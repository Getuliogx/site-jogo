
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import tls from "node:tls";

const app = express();
const PORT = process.env.PORT || 10000;
const APP_VERSION = "5.0.0";

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Evita que o navegador ou um proxy continue mostrando o painel antigo após o deploy.
app.use((req, res, next) => {
  if (req.path.startsWith("/hg") || req.path.includes("hungergames") || req.path === "/version") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.set("X-HG-Version", APP_VERSION);
  }
  next();
});

const autoTimers = new Map();
const chatTrackers = new Map();
const channelQueues = new Map();

const DEFAULT_IGNORED_CHATTERS = new Set([
  "streamelements", "nightbot", "moobot", "streamlabs", "soundalerts",
  "sery_bot", "commanderroot", "wizebot", "fossabot"
]);

function getAutoIntervalMs() {
  const ms = Number(process.env.HG_AUTO_INTERVAL_MS || 12000);
  return Math.max(4000, Math.min(120000, Number.isFinite(ms) ? ms : 12000));
}

function stopAuto(channel) {
  const key = nick(channel || "");
  const timer = autoTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  autoTimers.delete(key);
}

function isAutoRunning(channel) {
  return autoTimers.has(nick(channel || ""));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ignoredChatters() {
  return new Set([...DEFAULT_IGNORED_CHATTERS, ...envList("HG_IGNORE_CHATTERS")]);
}

function decodeIrcTag(value = "") {
  return String(value)
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function parseIrcTags(line) {
  if (!line.startsWith("@")) return {};
  const raw = line.slice(1, line.indexOf(" "));
  const tags = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    const key = i >= 0 ? part.slice(0, i) : part;
    const value = i >= 0 ? part.slice(i + 1) : "";
    tags[key] = decodeIrcTag(value);
  }
  return tags;
}

function trackerAddUser(state, username, displayName = "") {
  const login = nick(username);
  if (!login || login.startsWith("justinfan") || ignoredChatters().has(login)) return;
  const previous = state.users.get(login);
  state.users.set(login, {
    username: login,
    display_name: String(displayName || previous?.display_name || login).trim() || login
  });
  if (state.pendingNames) state.pendingNames.add(login);
}

function requestTrackerNames(state) {
  if (!state?.socket || state.socket.destroyed || !state.connected) return false;
  state.pendingNames = new Set();
  state.socket.write(`NAMES #${state.channel}\r\n`);
  return true;
}

function handleIrcLine(state, line) {
  if (!line) return;
  if (line.startsWith("PING")) {
    state.socket?.write(line.replace(/^PING/, "PONG") + "\r\n");
    return;
  }

  const names = line.match(/ 353 [^ ]+ [=@*] #([^ ]+) :(.+)$/);
  if (names) {
    for (const rawName of names[2].split(/\s+/)) {
      const login = nick(rawName.replace(/^[~&@%+]+/, ""));
      if (!login) continue;
      if (state.pendingNames) state.pendingNames.add(login);
      else trackerAddUser(state, login, login);
    }
    return;
  }

  if (/ 366 [^ ]+ #[^ ]+ :/.test(line)) {
    if (state.pendingNames) {
      const fresh = new Map();
      for (const login of state.pendingNames) {
        if (ignoredChatters().has(login) || login.startsWith("justinfan")) continue;
        const old = state.users.get(login);
        fresh.set(login, old || { username: login, display_name: login });
      }
      state.users = fresh;
      state.pendingNames = null;
      state.lastNamesAt = Date.now();
    }
    return;
  }

  const prefixUser = line.match(/^(?:@[^ ]+ )?:([^! ]+)!/);
  const login = nick(prefixUser?.[1] || "");
  if (!login) return;

  if (line.includes(" JOIN #")) {
    const tags = parseIrcTags(line);
    trackerAddUser(state, login, tags["display-name"] || login);
    return;
  }
  if (line.includes(" PART #")) {
    state.users.delete(login);
    state.pendingNames?.delete(login);
    return;
  }
  if (line.includes(" PRIVMSG #")) {
    const tags = parseIrcTags(line);
    trackerAddUser(state, login, tags["display-name"] || login);
  }
}

function startChatTracker(channel) {
  const ch = nick(channel);
  if (!ch) return null;
  const current = chatTrackers.get(ch);
  if (current?.socket && !current.socket.destroyed) return current;

  const state = current || {
    channel: ch,
    users: new Map(),
    pendingNames: null,
    connected: false,
    reconnectTimer: null,
    socket: null,
    buffer: "",
    lastNamesAt: 0
  };
  chatTrackers.set(ch, state);

  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const socket = tls.connect({ host: "irc.chat.twitch.tv", port: 6697, servername: "irc.chat.twitch.tv" });
  state.socket = socket;
  state.buffer = "";
  state.connected = false;
  socket.setEncoding("utf8");

  socket.on("secureConnect", () => {
    state.connected = true;
    const guest = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    socket.write("PASS SCHMOOPIIE\r\n");
    socket.write(`NICK ${guest}\r\n`);
    socket.write("CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands\r\n");
    socket.write(`JOIN #${ch}\r\n`);
    setTimeout(() => requestTrackerNames(state), 700).unref?.();
  });

  socket.on("data", chunk => {
    state.buffer += chunk;
    const lines = state.buffer.split("\r\n");
    state.buffer = lines.pop() || "";
    for (const line of lines) handleIrcLine(state, line);
  });

  const reconnect = () => {
    state.connected = false;
    if (state.socket === socket) state.socket = null;
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      startChatTracker(ch);
    }, 5000);
    state.reconnectTimer.unref?.();
  };
  socket.on("error", err => console.error(`Twitch IRC ${ch}:`, err.message));
  socket.on("close", reconnect);
  socket.on("end", reconnect);
  return state;
}

async function trackedChatters(channel) {
  const state = startChatTracker(channel);
  if (!state) return [];
  requestTrackerNames(state);
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    if (!state.pendingNames && state.users.size) break;
    await sleep(150);
  }
  return [...state.users.values()];
}

async function withChannelLock(channel, task) {
  const key = nick(channel) || "default";
  const previous = channelQueues.get(key) || Promise.resolve();
  let releaseLocal;
  const localGate = new Promise(resolve => { releaseLocal = resolve; });
  const tail = previous.then(() => localGate);
  channelQueues.set(key, tail);
  await previous;

  let conn = null;
  try {
    await ensureTables();
    const db = await getPool();
    conn = await db.getConnection();
    const lockName = `hg:${key}`.slice(0, 64);
    const [rows] = await conn.query("SELECT GET_LOCK(?, 30) AS ok", [lockName]);
    if (Number(rows?.[0]?.ok) !== 1) return "Aguarde: outra ação da arena ainda está sendo processada.";
    try {
      return await task(conn);
    } finally {
      try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    }
  } finally {
    if (conn) conn.release();
    releaseLocal();
    if (channelQueues.get(key) === tail) channelQueues.delete(key);
  }
}


let pool = null;
let ready = false;
let readyPromise = null;
let twitchTokenCache = { token: null, expiresAt: 0 };

function dbUrl() {
  return String(process.env.DATABASE_URL || "").replace(/[\?&]ssl=true/g, "");
}

async function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não configurado.");
  pool = mysql.createPool({
    uri: dbUrl(),
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true
  });
  return pool;
}

function normalize(v = "") {
  return String(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function nick(v = "") {
  return normalize(v).replace(/^@/, "").replace(/^#/, "").replace(/[^a-z0-9_]/g, "");
}
function envList(name) {
  return String(process.env[name] || "").split(",").map(nick).filter(Boolean);
}
function tokenValue() {
  return String(process.env.COMMAND_SECRET || process.env.ADD_TOKEN || "carolina-hg");
}
function channelFrom(req) {
  const ch = nick(req.query.channel || req.body?.channel || process.env.DEFAULT_CHANNEL || "icarolinaporto");
  if (ch === "carolinaporto") return "icarolinaporto";
  return ch || "icarolinaporto";
}
function userFrom(req) {
  return nick(req.query.user || req.body?.user || req.query.sender || req.body?.sender || "");
}
function displayFrom(req) {
  return String(req.query.user || req.body?.user || req.query.sender || req.body?.sender || "").replace(/^@/, "").trim();
}
function send(res, msg) {
  return res.status(200).type("text/plain").send(msg);
}
function checkToken(req, res) {
  const t = String(req.query.token || req.body?.token || "");
  if (t !== tokenValue()) {
    send(res, "Token inválido.");
    return false;
  }
  return true;
}
function checkChannel(req, res) {
  const allowed = envList("ALLOWED_CHANNELS");
  const ch = channelFrom(req);
  const fixedAllowed = new Set(["icarolinaporto", "carolinaporto"]);
  if (allowed.length && !allowed.includes(ch) && !fixedAllowed.has(ch)) {
    send(res, "Canal não autorizado.");
    return false;
  }
  return true;
}
function isAdmin(req) {
  const ch = channelFrom(req);
  const u = userFrom(req);
  const mods = envList("ALLOWED_USERS");
  return !!u && (u === ch || mods.includes(u));
}
function checkAdmin(req, res) {
  if (!isAdmin(req)) {
    send(res, "Usuário não autorizado.");
    return false;
  }
  return true;
}
function checkBase(req, res) {
  return checkToken(req, res) && checkChannel(req, res);
}
function checkAll(req, res) {
  return checkToken(req, res) && checkChannel(req, res) && checkAdmin(req, res);
}

const DEFAULT_EVENTS = [
  ["bloodbath","neutral",1,"{p1} corre para longe da cornucópia sem pegar nada.","",0],
  ["bloodbath","item",1,"{p1} pega uma mochila e desaparece no meio da confusão.","",0],
  ["bloodbath","item",1,"{p1} acha uma garrafa de água e foge antes que alguém veja.","",0],
  ["bloodbath","death",2,"{p1} acerta {p2} durante a correria da cornucópia.","p2",0],
  ["bloodbath","death",2,"{p1} derruba {p2} na disputa pelos suprimentos.","p2",0],
  ["bloodbath","death",3,"{p1} e {p2} cercam {p3} perto da cornucópia.","p3",0],
  ["bloodbath","alliance",2,"{p1} e {p2} fogem juntos e fazem uma aliança temporária.","",0],

  ["day","neutral",1,"{p1} passa o dia procurando água.","",0],
  ["day","neutral",1,"{p1} monta uma armadilha, mas ninguém cai nela.","",0],
  ["day","item",1,"{p1} encontra frutas escondidas perto de um riacho.","",0],
  ["day","item",1,"{p1} acha suprimentos abandonados.","",0],
  ["day","alliance",2,"{p1} e {p2} dividem comida e conversam sobre estratégia.","",0],
  ["day","alliance",3,"{p1}, {p2} e {p3} criam uma panelinha perigosa.","",0],
  ["day","neutral",2,"{p1} segue {p2} por horas, mas perde o rastro.","",0],
  ["day","death",2,"{p1} empurra {p2} em uma armadilha escondida.","p2",0],
  ["day","death",2,"{p1} ataca {p2} durante uma distração.","p2",0],
  ["day","death",3,"{p1} distrai {p3} enquanto {p2} prepara o ataque final.","p3",0],
  ["day","death",4,"{p1}, {p2} e {p3} armam uma emboscada para {p4}.","p4",0],

  ["night","neutral",1,"{p1} passa a noite acordado, com medo de qualquer barulho.","",0],
  ["night","neutral",1,"{p1} dorme escondido atrás de pedras.","",0],
  ["night","item",1,"{p1} encontra lenha seca e consegue se aquecer.","",0],
  ["night","alliance",2,"{p1} e {p2} dividem um abrigo improvisado.","",0],
  ["night","neutral",2,"{p1} ouve {p2} andando por perto, mas fica em silêncio.","",0],
  ["night","death",2,"{p1} ataca {p2} durante a madrugada.","p2",0],
  ["night","death",3,"{p1} e {p2} traem {p3} enquanto todos fingiam descansar.","p3",0],

  ["feast","item",1,"{p1} corre até o banquete, pega suprimentos e foge vivo.","",0],
  ["feast","neutral",2,"{p1} e {p2} chegam ao banquete ao mesmo tempo e fogem para lados opostos.","",0],
  ["feast","death",2,"{p1} elimina {p2} na disputa por uma caixa de suprimentos.","p2",0],
  ["feast","death",3,"{p1} usa o caos do banquete para atacar {p3}, enquanto {p2} foge.","p3",0],

  ["arena","neutral",1,"Uma tempestade começa e {p1} precisa mudar de esconderijo.","",0],
  ["arena","death",1,"Um evento da arena pega {p1} desprevenido.","p1",0],
  ["arena","death",2,"A arena força {p1} e {p2} a correrem. {p2} não consegue escapar.","p2",0],
  ["arena","death",3,"Criaturas da arena atacam o grupo. {p3} fica para trás.","p3",0],

  ["day","adult",2,"{p1} e {p2} somem atrás das árvores e voltam descabelados, fingindo que nada aconteceu.","",1],
  ["day","adult",2,"{p1} dá em cima de {p2} no pior momento possível. A estratégia vira fofoca na arena.","",1],
  ["day","adult",2,"{p1} e {p2} fazem uma aliança safada demais para explicar em público.","",1],
  ["night","adult",2,"{p1} e {p2} dividem o abrigo e a noite fica suspeitamente silenciosa.","",1],
  ["night","adult",2,"{p1} tenta seduzir {p2} para conseguir suprimentos. Funciona melhor do que deveria.","",1],
  ["night","adult",3,"{p1}, {p2} e {p3} fazem uma festa proibida no meio da arena.","",1],
  ["feast","adult",2,"{p1} distrai {p2} com charme e sai do banquete com os melhores suprimentos.","",1],
  ["day","adult",2,"{p1} chama {p2} para uma aliança com benefícios. Ninguém sabe se é estratégia ou safadeza.","",1],
  ["night","adult",1,"{p1} passa a noite lembrando coisas que definitivamente não deveriam ser narradas na live.","",1],
  ["day","adult",2,"{p1} flerta tanto com {p2} que os patrocinadores ficam confusos se isso é guerra ou date.","",1]
];



const HEAVY_ADULT_EVENTS = [
  ["day","adult",2,"{p1} e {p2} somem da câmera por alguns minutos e voltam com cara de quem aprontou.","",1],
  ["day","adult",2,"{p1} provoca {p2} até os dois esquecerem que isso era para ser uma arena.","",1],
  ["day","adult",2,"{p1} faz uma proposta indecente para {p2} em troca de proteção.","",1],
  ["day","adult",2,"{p1} usa charme, safadeza e zero vergonha para distrair {p2}.","",1],
  ["day","adult",2,"{p1} e {p2} transformam a aliança em algo muito menos inocente.","",1],
  ["day","adult",3,"{p1}, {p2} e {p3} criam uma panelinha tão safada que até os patrocinadores ficam sem reação.","",1],
  ["day","adult",2,"{p1} tenta seduzir {p2} e quase esquece que ainda precisa sobreviver.","",1],
  ["day","adult",2,"{p1} chama {p2} para conversar em particular. Ninguém acredita que foi só conversa.","",1],
  ["day","adult",2,"{p1} flerta pesado com {p2} e consegue escapar de uma briga só no papo.","",1],
  ["day","adult",2,"{p1} troca olhares com {p2} e a tensão fica mais perigosa que a arena.","",1],
  ["night","adult",2,"{p1} e {p2} dividem o abrigo e a noite fica quente demais para narrar direito.","",1],
  ["night","adult",2,"{p1} e {p2} passam a madrugada ocupados demais para vigiar a arena.","",1],
  ["night","adult",2,"{p1} convida {p2} para se aquecer no abrigo. A desculpa cola por uns cinco segundos.","",1],
  ["night","adult",2,"{p1} e {p2} fazem barulho demais no escuro e entregam o esconderijo.","",1],
  ["night","adult",2,"{p1} provoca {p2} no abrigo e a estratégia vira bagunça.","",1],
  ["night","adult",3,"{p1}, {p2} e {p3} fazem uma festa adulta escondida da transmissão oficial.","",1],
  ["night","adult",2,"{p1} tenta dormir, mas {p2} aparece com uma ideia muito errada e muito tentadora.","",1],
  ["night","adult",2,"{p1} e {p2} esquecem a fogueira acesa enquanto a noite esquenta por outro motivo.","",1],
  ["feast","adult",2,"{p1} distrai {p2} com safadeza e rouba os melhores suprimentos.","",1],
  ["feast","adult",2,"{p1} usa provocação pesada para fazer {p2} baixar a guarda no banquete.","",1],
  ["feast","adult",3,"{p1} cria um clima indecente entre {p2} e {p3} só para fugir com a mochila.","",1],
  ["arena","adult",2,"A arena fica em silêncio enquanto {p1} e {p2} fazem uma aliança adulta demais para o horário.","",1],
  ["arena","adult",2,"Os patrocinadores mandam censura preventiva depois que {p1} e {p2} ficam sozinhos.","",1],
  ["day","adult",2,"{p1} fala uma besteira tão safada para {p2} que até os inimigos param para ouvir.","",1],
  ["night","adult",1,"{p1} passa a noite tendo pensamentos nada santos e perde o foco da arena.","",1],
  ["day","adult",2,"{p1} chama {p2} de gostoso(a) no meio da arena e cria um silêncio constrangedor.","",1],
  ["night","adult",2,"{p1} e {p2} fazem um acordo: proteção de dia, safadeza de noite.","",1],
  ["day","adult",3,"{p1} joga charme para {p2} enquanto {p3} fica segurando vela sem pedir.","",1],
  ["night","adult",2,"{p1} e {p2} ficam tão grudados que ninguém sabe onde termina a estratégia e começa a safadeza.","",1],
  ["day","adult",2,"{p1} promete recompensa adulta para {p2} se os dois chegarem vivos até a noite.","",1]
];

async function ensureTables() {
  if (ready) return;
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
      const db = await getPool();

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_games (
          id INT AUTO_INCREMENT PRIMARY KEY,
          channel VARCHAR(80) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'lobby',
          phase VARCHAR(30) NOT NULL DEFAULT 'bloodbath',
          day_number INT NOT NULL DEFAULT 1,
          adult_mode TINYINT(1) NOT NULL DEFAULT 0,
          winner VARCHAR(120) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_channel_status (channel,status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_players (
          id INT AUTO_INCREMENT PRIMARY KEY,
          game_id INT NOT NULL,
          channel VARCHAR(80) NOT NULL,
          username VARCHAR(120) NOT NULL,
          display_name VARCHAR(120) NOT NULL,
          district INT NOT NULL DEFAULT 1,
          avatar_url TEXT NULL,
          alive TINYINT(1) NOT NULL DEFAULT 1,
          kills INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_game_user (game_id,username),
          INDEX idx_game_alive (game_id,alive)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          game_id INT NOT NULL,
          channel VARCHAR(80) NOT NULL,
          phase VARCHAR(30) NOT NULL,
          day_number INT NOT NULL DEFAULT 1,
          text TEXT NOT NULL,
          deaths TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_game_log (game_id,id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          phase VARCHAR(30) NOT NULL,
          type VARCHAR(30) NOT NULL DEFAULT 'neutral',
          players INT NOT NULL DEFAULT 1,
          text TEXT NOT NULL,
          kills VARCHAR(50) NULL,
          adult TINYINT(1) NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_event_phase (phase, active, adult)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Migração segura: mantém todos os eventos e partidas já existentes.
      // A coluna só é criada na primeira execução desta versão.
      try {
        await db.query("ALTER TABLE hg_games ADD COLUMN active_scenario_id INT NULL AFTER adult_mode");
      } catch (e) {
        if (e?.code !== "ER_DUP_FIELDNAME") throw e;
      }

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_scenarios (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          phase VARCHAR(30) NOT NULL DEFAULT 'arena',
          type VARCHAR(30) NOT NULL DEFAULT 'neutral',
          players INT NOT NULL DEFAULT 1,
          text TEXT NOT NULL,
          kills VARCHAR(50) NULL,
          adult TINYINT(1) NOT NULL DEFAULT 0,
          mix_with_normal TINYINT(1) NOT NULL DEFAULT 1,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_scenario_active_phase (active, phase, adult)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_scenario_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          scenario_id INT NOT NULL,
          phase VARCHAR(30) NOT NULL DEFAULT 'any',
          type VARCHAR(30) NOT NULL DEFAULT 'neutral',
          players INT NOT NULL DEFAULT 1,
          text TEXT NOT NULL,
          kills VARCHAR(50) NULL,
          adult TINYINT(1) NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_scenario_event (scenario_id, active, phase, adult)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_game_scenario_runs (
          game_id INT NOT NULL,
          scenario_id INT NOT NULL,
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME NULL,
          PRIMARY KEY (game_id, scenario_id),
          INDEX idx_scenario_run (scenario_id, completed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_scenario_usage (
          game_id INT NOT NULL,
          scenario_id INT NOT NULL,
          event_id INT NOT NULL,
          used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (game_id, event_id),
          INDEX idx_scenario_usage (game_id, scenario_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      const [count] = await db.query("SELECT COUNT(*) AS total FROM hg_events");
      if (Number(count?.[0]?.total || 0) === 0) {
        await db.query("INSERT INTO hg_events (phase,type,players,text,kills,adult) VALUES ?", [DEFAULT_EVENTS.map(e => [e[0],e[1],e[2],e[3],e[4],e[5]])]);
      }

      ready = true;
  })();
  try {
    await readyPromise;
  } catch (e) {
    readyPromise = null;
    throw e;
  }
}


async function seedHeavyAdultEvents() {
  await ensureTables();
  const db = await getPool();
  await db.query("INSERT INTO hg_events (phase,type,players,text,kills,adult) VALUES ?", [HEAVY_ADULT_EVENTS.map(e => [e[0], e[1], e[2], e[3], e[4], e[5]])]);
  return `✅ Pacote +18 pesado adicionado: ${HEAVY_ADULT_EVENTS.length} eventos.`;
}

async function getTwitchAppToken() {
  if (twitchTokenCache.token && twitchTokenCache.expiresAt > Date.now() + 60000) return twitchTokenCache.token;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });

  const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!r.ok) return null;
  const j = await r.json();
  twitchTokenCache = {
    token: j.access_token,
    expiresAt: Date.now() + Math.max(60, Number(j.expires_in || 3600) - 60) * 1000
  };
  return twitchTokenCache.token;
}

async function getTwitchAvatar(username) {
  try {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = await getTwitchAppToken();
    if (!clientId || !token || !username) return "";
    const r = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
      headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return "";
    const j = await r.json();
    return j?.data?.[0]?.profile_image_url || "";
  } catch {
    return "";
  }
}

async function getTwitchProfiles(usernames) {
  const logins = [...new Set((usernames || []).map(nick).filter(Boolean))];
  const result = new Map();
  try {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = await getTwitchAppToken();
    if (!clientId || !token || !logins.length) return result;
    for (let i = 0; i < logins.length; i += 100) {
      const params = new URLSearchParams();
      for (const login of logins.slice(i, i + 100)) params.append("login", login);
      const r = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
        headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` }
      });
      if (!r.ok) continue;
      const j = await r.json();
      for (const u of j?.data || []) {
        result.set(nick(u.login), {
          username: nick(u.login),
          display_name: u.display_name || u.login,
          avatar_url: u.profile_image_url || ""
        });
      }
    }
  } catch (e) {
    console.error("Erro ao buscar perfis da Twitch:", e.message);
  }
  return result;
}

async function officialChatters(channel) {
  const clientId = String(process.env.TWITCH_CLIENT_ID || "");
  const userToken = String(process.env.TWITCH_CHAT_TOKEN || process.env.TWITCH_USER_TOKEN || "").replace(/^oauth:/i, "");
  if (!clientId || !userToken) return null;
  const headers = { "Client-ID": clientId, Authorization: `Bearer ${userToken}` };

  async function twitchUser(login) {
    const r = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, { headers });
    if (!r.ok) throw new Error(`Twitch Users HTTP ${r.status}`);
    const j = await r.json();
    return j?.data?.[0] || null;
  }

  const broadcaster = await twitchUser(channel);
  const moderatorLogin = nick(process.env.TWITCH_CHAT_MODERATOR || channel);
  const moderator = moderatorLogin === nick(channel) ? broadcaster : await twitchUser(moderatorLogin);
  if (!broadcaster || !moderator) throw new Error("Canal ou moderador não encontrado na Twitch.");

  const users = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({
      broadcaster_id: broadcaster.id,
      moderator_id: moderator.id,
      first: "100"
    });
    if (cursor) params.set("after", cursor);
    const r = await fetch(`https://api.twitch.tv/helix/chat/chatters?${params}`, { headers });
    if (!r.ok) throw new Error(`Twitch Chatters HTTP ${r.status}`);
    const j = await r.json();
    for (const u of j?.data || []) {
      users.push({ username: nick(u.user_login), display_name: u.user_name || u.user_login });
    }
    cursor = j?.pagination?.cursor || "";
  } while (cursor);
  return users;
}

async function currentChatters(channel) {
  try {
    const official = await officialChatters(channel);
    if (official?.length) return official;
  } catch (e) {
    console.error("Lista oficial de chatters indisponível; usando IRC:", e.message);
  }
  return trackedChatters(channel);
}

async function currentGame(channel, create = true) {
  await ensureTables();
  const db = await getPool();
  const [rows] = await db.query("SELECT * FROM hg_games WHERE channel=? AND status IN ('lobby','running','ended') ORDER BY id DESC LIMIT 1", [channel]);
  if (rows.length) return rows[0];
  if (!create) return null;
  const [r] = await db.query("INSERT INTO hg_games (channel,status,phase,day_number,adult_mode) VALUES (?, 'lobby', 'bloodbath', 1, ?)", [channel, process.env.HG_ADULT_DEFAULT === "1" ? 1 : 0]);
  const [created] = await db.query("SELECT * FROM hg_games WHERE id=?", [r.insertId]);
  return created[0];
}

async function newLobby(channel, adult = 0) {
  await ensureTables();
  const db = await getPool();
  await db.query("UPDATE hg_games SET status='archived' WHERE channel=? AND status IN ('lobby','running','ended')", [channel]);
  const [r] = await db.query("INSERT INTO hg_games (channel,status,phase,day_number,adult_mode) VALUES (?, 'lobby', 'bloodbath', 1, ?)", [channel, adult ? 1 : 0]);
  return r.insertId;
}

function district(n) {
  const x = Number(n || 1);
  return Math.max(1, Math.min(12, Number.isFinite(x) ? Math.round(x) : 1));
}
async function autoDistrict(gameId) {
  const db = await getPool();
  const [rows] = await db.query("SELECT district,COUNT(*) total FROM hg_players WHERE game_id=? GROUP BY district", [gameId]);
  const m = new Map(rows.map(r => [Number(r.district), Number(r.total)]));
  let best = 1, c = m.get(1) || 0;
  for (let d=2; d<=12; d++) {
    const q = m.get(d) || 0;
    if (q < c) { best = d; c = q; }
  }
  return best;
}

async function join(channel, username, display, distRaw) {
  return withChannelLock(channel, async () => {
    const game = await currentGame(channel, true);
    if (game.status !== "lobby") return "A partida já começou. Espere resetar.";
    const db = await getPool();
    const [ex] = await db.query("SELECT * FROM hg_players WHERE game_id=? AND username=? LIMIT 1", [game.id, username]);

    const dist = distRaw ? district(distRaw) : (ex.length ? ex[0].district : await autoDistrict(game.id));
    const avatar = ex.length ? (ex[0].avatar_url || "") : await getTwitchAvatar(username);

    await db.query(`
      INSERT INTO hg_players (game_id,channel,username,display_name,district,avatar_url,alive)
      VALUES (?,?,?,?,?,?,1)
      ON DUPLICATE KEY UPDATE
        display_name=VALUES(display_name),
        district=VALUES(district),
        avatar_url=COALESCE(NULLIF(VALUES(avatar_url),''),avatar_url)
    `, [game.id, channel, username, display || username, dist, avatar || ""]);

    return `✅ ${display || username} entrou no Distrito ${dist}.`;
  });
}

async function leave(channel, username) {
  return withChannelLock(channel, async () => {
    const game = await currentGame(channel, false);
    if (!game || game.status !== "lobby") return "Só dá para sair antes da partida começar.";
    const db = await getPool();
    await db.query("DELETE FROM hg_players WHERE game_id=? AND username=?", [game.id, username]);
    return `✅ ${username} saiu da arena.`;
  });
}

async function changeDistrict(channel, username, distRaw) {
  return withChannelLock(channel, async () => {
    const game = await currentGame(channel, false);
    if (!game || game.status !== "lobby") return "Só dá para trocar distrito antes da partida começar.";
    const db = await getPool();
    const [r] = await db.query("UPDATE hg_players SET district=? WHERE game_id=? AND username=?", [district(distRaw), game.id, username]);
    if (!r.affectedRows) return `Você ainda não entrou. Use !hg entrar ${district(distRaw)}`;
    return `✅ ${username} foi para o Distrito ${district(distRaw)}.`;
  });
}

async function addManual(channel, name, distRaw) {
  const display = String(name || "").trim().replace(/\s+/g, " ");
  if (!display) return "Faltou o nome.";
  return join(channel, nick(display) || `player${Date.now()}`, display, distRaw);
}

async function addAllChatters(channel) {
  return withChannelLock(channel, async () => {
    const game = await currentGame(channel, true);
    if (game.status !== "lobby") return "Só é possível adicionar todos antes da partida começar.";

    const chatters = await currentChatters(channel);
    const ignore = ignoredChatters();
    const unique = new Map();
    for (const person of chatters || []) {
      const username = nick(person?.username || person?.user_login || person);
      if (!username || ignore.has(username) || username.startsWith("justinfan")) continue;
      unique.set(username, {
        username,
        display_name: String(person?.display_name || person?.user_name || username).trim() || username
      });
    }
    if (!unique.size) {
      return "Não consegui ler os usuários do chat agora. Aguarde alguns segundos e use !hg todos novamente.";
    }

    const db = await getPool();
    const [existing] = await db.query("SELECT username,district FROM hg_players WHERE game_id=?", [game.id]);
    const existingNames = new Set(existing.map(p => nick(p.username)));
    const selected = [...unique.values()].filter(p => !existingNames.has(p.username));
    if (!selected.length) return `✅ Todos que estavam no chat já foram adicionados. Total: ${existing.length}.`;

    const profiles = await getTwitchProfiles(selected.map(p => p.username));
    const counts = new Map();
    for (const p of existing) counts.set(Number(p.district), (counts.get(Number(p.district)) || 0) + 1);
    function nextBalancedDistrict() {
      let best = 1;
      let amount = counts.get(1) || 0;
      for (let d = 2; d <= 12; d++) {
        const value = counts.get(d) || 0;
        if (value < amount) { best = d; amount = value; }
      }
      counts.set(best, amount + 1);
      return best;
    }

    const values = selected.map(person => {
      const profile = profiles.get(person.username);
      return [
        game.id,
        channel,
        person.username,
        profile?.display_name || person.display_name || person.username,
        nextBalancedDistrict(),
        profile?.avatar_url || "",
        1
      ];
    });
    await db.query(`
      INSERT IGNORE INTO hg_players
        (game_id,channel,username,display_name,district,avatar_url,alive)
      VALUES ?
    `, [values]);

    return `✅ ${selected.length} participante(s) do chat adicionado(s). Total: ${existing.length + selected.length}.`;
  });
}

async function start(channel) {
  return withChannelLock(channel, async () => {
    const game = await currentGame(channel, true);
    if (game.status === "running") return "A partida já está rodando.";
    if (game.status === "ended") return "A partida já terminou. Use Resetar antes de iniciar outra.";
    if (game.status !== "lobby") return "Esta arena não está disponível para iniciar.";
    const db = await getPool();
    const [players] = await db.query("SELECT * FROM hg_players WHERE game_id=?", [game.id]);
    if (players.length < 2) return "Precisa de pelo menos 2 participantes.";
    await db.query("UPDATE hg_players SET kills=0 WHERE game_id=?", [game.id]);
    await db.query("DELETE FROM hg_scenario_usage WHERE game_id=?", [game.id]);
    await db.query("DELETE FROM hg_game_scenario_runs WHERE game_id=?", [game.id]);
    await db.query("UPDATE hg_games SET status='running',phase='bloodbath',day_number=1,winner=NULL,active_scenario_id=NULL WHERE id=? AND status='lobby'", [game.id]);
    await db.query("INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,'reaping',0,?,'')", [game.id, channel, `🎲 A arena começou com ${players.length} participantes.`]);
    return `🔥 Partida iniciada com ${players.length} participantes.`;
  });
}

async function reset(channel) {
  stopAuto(channel);
  return withChannelLock(channel, async () => {
    const old = await currentGame(channel, false);
    await newLobby(channel, old?.adult_mode || (process.env.HG_ADULT_DEFAULT === "1" ? 1 : 0));
    return "✅ Arena resetada. Use !hg entrar ou !hg todos.";
  });
}

async function adult(channel, on) {
  const game = await currentGame(channel, true);
  const db = await getPool();
  await db.query("UPDATE hg_games SET adult_mode=? WHERE id=?", [on ? 1 : 0, game.id]);
  return on ? "🔞 Modo +18 ligado." : "✅ Modo +18 desligado.";
}

function shuffle(a) {
  const arr = [...a];
  for (let i=arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function random(a) { return a[Math.floor(Math.random()*a.length)]; }
function formatParticipantNames(players) {
  const names = (players || []).map(p => String(p?.display_name || p?.username || "").trim()).filter(Boolean);
  if (!names.length) return "ninguém";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}
function fill(text, players) {
  let out = String(text || "");
  const allNames = formatParticipantNames(players);
  out = out.replace(/\{todos\}/gi, allNames).replace(/\{p\}/gi, allNames);
  players.forEach((p, idx) => {
    out = out.replace(new RegExp(`\\{p${idx+1}\\}`, "g"), p.display_name || p.username);
  });
  return out;
}
function parseEventPlayers(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["0", "todos", "todo", "all"].includes(raw)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, Math.round(n)));
}
function eventUsesAllPlayers(event) {
  return Number(event?.players) === 0;
}
function eventParticipantCount(event, aliveCount) {
  return eventUsesAllPlayers(event)
    ? Math.max(0, Number(aliveCount || 0))
    : Math.max(1, Math.min(4, Number(event?.players || 1)));
}
function killIndexes(kills) {
  return String(kills || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).map(s => {
    const m = s.match(/^p([1-9])$/);
    return m ? Number(m[1])-1 : -1;
  }).filter(n => n >= 0);
}
function validEventKillIndexes(event) {
  const players = parseEventPlayers(event?.players);
  if (players === 0) return [];
  return [...new Set(killIndexes(event?.kills).filter(index => index < players))];
}
function validateEventDeathConfig(type, players, kills) {
  const parsedPlayers = parseEventPlayers(players);
  const raw = String(kills || "").trim();
  if (parsedPlayers === 0 && (raw || String(type || "").toLowerCase() === "death")) {
    return "Eventos para Todos não podem usar Mortes. Para matar alguém, escolha de 1 a 4 participantes.";
  }
  const valid = validEventKillIndexes({ players: parsedPlayers, kills });
  if (raw && valid.length !== killIndexes(raw).length) {
    return `Mortes inválidas. Use apenas p1 até p${parsedPlayers}, separadas por vírgula.`;
  }
  if (String(type || "").toLowerCase() === "death" && valid.length === 0) {
    return "Evento do tipo Morte precisa indicar quem morre no campo Mortes, por exemplo: p2.";
  }
  return "";
}
function phaseName(phase, day) {
  if (phase === "bloodbath") return "Cornucópia";
  if (phase === "day") return `Dia ${day}`;
  if (phase === "night") return `Noite ${day}`;
  if (phase === "feast") return `Banquete do Dia ${day}`;
  if (phase === "arena") return "Evento da Arena";
  return phase;
}
function nextPhase(phase, day) {
  if (phase === "bloodbath") return { phase: "day", day };
  if (phase === "day") return { phase: "night", day };
  if (phase === "night") {
    const d = Number(day) + 1;
    return d % 3 === 0 ? { phase: "feast", day: d } : { phase: "day", day: d };
  }
  if (phase === "feast") return { phase: "night", day };
  return { phase: "day", day };
}

async function alivePlayers(gameId) {
  const db = await getPool();
  const [rows] = await db.query("SELECT * FROM hg_players WHERE game_id=? AND alive=1 ORDER BY RAND()", [gameId]);
  return rows;
}

async function finishScenario(conn, gameId, scenarioId, channel, phase, day, scenarioName) {
  await conn.query("UPDATE hg_games SET active_scenario_id=NULL WHERE id=? AND active_scenario_id=?", [gameId, scenarioId]);
  await conn.query("UPDATE hg_game_scenario_runs SET completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP) WHERE game_id=? AND scenario_id=?", [gameId, scenarioId]);
  if (scenarioName) {
    await conn.query(
      "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,?,?,?,'')",
      [gameId, channel, phase, day, `✅ O evento especial “${scenarioName}” terminou.`]
    );
  }
}

async function nextRound(channel) {
  return withChannelLock(channel, async (conn) => {
    // A rodada inteira usa uma transação e um bloqueio por canal. Mortes,
    // eventos normais e eventos encadeados ficam sempre no mesmo estado.
    await conn.beginTransaction();
    try {
      const [games] = await conn.query(
        "SELECT * FROM hg_games WHERE channel=? AND status IN ('lobby','running','ended') ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [channel]
      );
      const game = games[0];
      if (!game) {
        await conn.rollback();
        return "Nenhuma partida criada.";
      }
      if (game.status === "lobby") {
        await conn.rollback();
        return "A partida ainda não começou. Use !hg iniciar.";
      }
      if (game.status === "ended") {
        await conn.rollback();
        return `A partida já acabou. Vencedor: ${game.winner || "ninguém"}.`;
      }

      let [alive] = await conn.query(
        "SELECT * FROM hg_players WHERE game_id=? AND alive=1 ORDER BY RAND() FOR UPDATE",
        [game.id]
      );
      if (alive.length <= 1) {
        const winner = alive[0]?.display_name || null;
        await conn.query("UPDATE hg_games SET status='ended',winner=? WHERE id=?", [winner, game.id]);
        await conn.commit();
        return winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor.";
      }

      const phase = game.phase || "bloodbath";
      const day = Number(game.day_number || 1);
      const title = phaseName(phase, day);
      const phases = (phase === "day" || phase === "night") ? [phase, "arena"] : [phase];
      const phaseMarks = phases.map(() => "?").join(",");
      const adultAllowed = Number(game.adult_mode) === 1 ? 1 : 0;

      const [normalEvents] = await conn.query(
        `SELECT e.*, 'normal' AS event_source, NULL AS scenario_id, NULL AS scenario_name
         FROM hg_events e
         WHERE e.active=1 AND e.phase IN (${phaseMarks}) AND (e.adult=0 OR ?=1)
         ORDER BY RAND()`,
        [...phases, adultAllowed]
      );

      // Um evento especial só pode começar uma vez em cada partida.
      let scenarioTriggers = [];
      if (!Number(game.active_scenario_id || 0)) {
        const [rows] = await conn.query(
          `SELECT s.id, s.phase, s.type, s.players, s.text, s.kills, s.adult,
                  'scenario_trigger' AS event_source, s.id AS scenario_id,
                  s.name AS scenario_name, s.mix_with_normal
           FROM hg_scenarios s
           LEFT JOIN hg_game_scenario_runs r
             ON r.game_id=? AND r.scenario_id=s.id
           WHERE s.active=1 AND r.scenario_id IS NULL
             AND s.phase IN (${phaseMarks}) AND (s.adult=0 OR ?=1)
           ORDER BY RAND()`,
          [game.id, ...phases, adultAllowed]
        );
        scenarioTriggers = rows;
      }

      if (!normalEvents.length && !scenarioTriggers.length && !Number(game.active_scenario_id || 0)) {
        await conn.rollback();
        return "Sem eventos para essa fase.";
      }

      await conn.query(
        "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,?,?,?,'')",
        [game.id, channel, phase, day, `📍 ${title}`]
      );

      let available = shuffle(alive);
      let activeScenarioId = Number(game.active_scenario_id || 0);
      let allowScenarioTrigger = activeScenarioId === 0;

      while (available.length > 0) {
        const [aliveNow] = await conn.query(
          "SELECT id FROM hg_players WHERE game_id=? AND alive=1 FOR UPDATE",
          [game.id]
        );
        const aliveIds = new Set(aliveNow.map(p => Number(p.id)));
        available = available.filter(p => aliveIds.has(Number(p.id)));
        if (aliveIds.size <= 1 || available.length === 0) break;

        let pool = [];
        let activeScenario = null;
        let childEvents = [];

        if (activeScenarioId) {
          const [scenarioRows] = await conn.query(
            "SELECT * FROM hg_scenarios WHERE id=? LIMIT 1",
            [activeScenarioId]
          );
          activeScenario = scenarioRows[0] || null;

          if (!activeScenario || !Number(activeScenario.active)) {
            await finishScenario(conn, game.id, activeScenarioId, channel, phase, day, activeScenario?.name || "");
            activeScenarioId = 0;
            activeScenario = null;
            allowScenarioTrigger = false;
          } else {
            const [children] = await conn.query(
              `SELECT se.*, 'scenario_child' AS event_source, se.scenario_id,
                      ? AS scenario_name
               FROM hg_scenario_events se
               LEFT JOIN hg_scenario_usage u
                 ON u.game_id=? AND u.event_id=se.id
               WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
                 AND (se.phase='any' OR se.phase IN (${phaseMarks}))
                 AND (se.adult=0 OR ?=1)
               ORDER BY se.sort_order ASC, RAND()`,
              [activeScenario.name, game.id, activeScenarioId, ...phases, adultAllowed]
            );
            childEvents = children;

            const [remainingRows] = await conn.query(
              `SELECT COUNT(*) AS total,
                      SUM(CASE WHEN se.players=0 OR se.players<=? THEN 1 ELSE 0 END) AS usable
               FROM hg_scenario_events se
               LEFT JOIN hg_scenario_usage u
                 ON u.game_id=? AND u.event_id=se.id
               WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
                 AND (se.adult=0 OR ?=1)`,
              [aliveIds.size, game.id, activeScenarioId, adultAllowed]
            );
            const remainingTotal = Number(remainingRows?.[0]?.total || 0);
            const usableRemaining = Number(remainingRows?.[0]?.usable || 0);

            if (remainingTotal === 0 || usableRemaining === 0) {
              await finishScenario(conn, game.id, activeScenarioId, channel, phase, day, activeScenario.name);
              activeScenarioId = 0;
              activeScenario = null;
              allowScenarioTrigger = false;
            }
          }
        }

        if (activeScenario) {
          pool = Number(activeScenario.mix_with_normal)
            ? [...normalEvents, ...childEvents]
            : [...childEvents];

          // No modo exclusivo, uma fase sem evento decorrente é pulada. Assim
          // nenhum evento normal entra no meio da história especial.
          if (!pool.length && !Number(activeScenario.mix_with_normal)) break;
        } else {
          pool = [...normalEvents];
          if (allowScenarioTrigger) pool.push(...scenarioTriggers);
        }

        const possible = pool.filter(ev => {
          const participantCount = eventParticipantCount(ev, aliveIds.size);
          if (eventUsesAllPlayers(ev)) {
            // "Todos" pega todos os participantes vivos e só pode acontecer
            // antes de alguém já ter sido usado em outro evento desta rodada.
            if (available.length !== aliveIds.size || participantCount === 0) return false;
          } else if (participantCount > available.length) {
            return false;
          }
          const configuredDeaths = validEventKillIndexes(ev);
          if (String(ev.type || "").toLowerCase() === "death" && configuredDeaths.length === 0) return false;
          return true;
        });
        if (!possible.length) break;

        // Uma introdução para Todos tem prioridade no começo da rodada, para
        // garantir que nenhum participante fique de fora da cena de abertura.
        const allPlayerEvents = possible.filter(ev => eventUsesAllPlayers(ev) && ev.event_source !== "normal");
        let eventPool;
        if (allPlayerEvents.length) {
          eventPool = allPlayerEvents;
        } else {
          const deathEvents = possible.filter(ev => validEventKillIndexes(ev).length > 0);
          eventPool = aliveIds.size > 2 && deathEvents.length && Math.random() < 0.38
            ? deathEvents
            : possible;
        }
        const ev = random(eventPool);
        const count = eventParticipantCount(ev, aliveIds.size);
        const group = eventUsesAllPlayers(ev)
          ? available.splice(0, available.length)
          : available.splice(0, Math.min(count, available.length));

        const deathMap = new Map();
        for (const idx of validEventKillIndexes(ev)) {
          const person = group[idx];
          if (person && aliveIds.has(Number(person.id))) deathMap.set(Number(person.id), person);
        }
        let deaths = [...deathMap.values()];
        if (aliveIds.size - deaths.length < 1) {
          deaths = deaths.slice(0, Math.max(0, aliveIds.size - 1));
        }

        const confirmedDeaths = [];
        for (const dead of deaths) {
          const [deadUpdate] = await conn.query(
            "UPDATE hg_players SET alive=0 WHERE id=? AND game_id=? AND alive=1",
            [dead.id, game.id]
          );
          if (deadUpdate.affectedRows === 1) confirmedDeaths.push(dead);
        }

        const expectedDeath = validEventKillIndexes(ev).length > 0;
        if (expectedDeath && deaths.length > 0 && confirmedDeaths.length !== deaths.length) {
          throw new Error("A morte do evento não pôde ser confirmada; a rodada foi cancelada para evitar reviver participante.");
        }

        const deadIds = new Set(confirmedDeaths.map(p => Number(p.id)));
        const killer = group.find(p => !deadIds.has(Number(p.id)) && aliveIds.has(Number(p.id)));
        if (killer && confirmedDeaths.length) {
          await conn.query(
            "UPDATE hg_players SET kills=kills+? WHERE id=? AND game_id=? AND alive=1",
            [confirmedDeaths.length, killer.id, game.id]
          );
        }

        const text = fill(ev.text, group);
        const confirmedDeathNames = confirmedDeaths.map(p => p.display_name || p.username);
        await conn.query(
          "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,?,?,?,?)",
          [game.id, channel, phase, day, text, confirmedDeathNames.join(", ")]
        );

        if (ev.event_source === "scenario_trigger") {
          const scenarioId = Number(ev.scenario_id || ev.id);
          await conn.query(
            "INSERT IGNORE INTO hg_game_scenario_runs (game_id,scenario_id) VALUES (?,?)",
            [game.id, scenarioId]
          );
          await conn.query("UPDATE hg_games SET active_scenario_id=? WHERE id=?", [scenarioId, game.id]);
          activeScenarioId = scenarioId;
          allowScenarioTrigger = false;
        } else if (ev.event_source === "scenario_child") {
          await conn.query(
            "INSERT IGNORE INTO hg_scenario_usage (game_id,scenario_id,event_id) VALUES (?,?,?)",
            [game.id, Number(ev.scenario_id), Number(ev.id)]
          );

          const [remaining] = await conn.query(
            `SELECT COUNT(*) AS total
             FROM hg_scenario_events se
             LEFT JOIN hg_scenario_usage u
               ON u.game_id=? AND u.event_id=se.id
             WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
               AND (se.adult=0 OR ?=1)`,
            [game.id, Number(ev.scenario_id), adultAllowed]
          );
          if (Number(remaining?.[0]?.total || 0) === 0) {
            await finishScenario(conn, game.id, Number(ev.scenario_id), channel, phase, day, ev.scenario_name || "");
            activeScenarioId = 0;
            allowScenarioTrigger = false;
          }
        }
      }

      [alive] = await conn.query(
        "SELECT * FROM hg_players WHERE game_id=? AND alive=1 ORDER BY RAND() FOR UPDATE",
        [game.id]
      );
      if (alive.length <= 1) {
        const winner = alive[0]?.display_name || null;
        await conn.query("UPDATE hg_games SET status='ended',winner=? WHERE id=?", [winner, game.id]);
        await conn.query(
          "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,'winner',?,?, '')",
          [game.id, channel, day, winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor."]
        );
        await conn.commit();
        return winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor.";
      }

      const np = nextPhase(phase, day);
      await conn.query(
        "UPDATE hg_games SET phase=?,day_number=? WHERE id=? AND status='running'",
        [np.phase, np.day, game.id]
      );
      await conn.commit();
      return `✅ ${title} gerado. Restam ${alive.length} vivos.`;
    } catch (error) {
      try { await conn.rollback(); } catch {}
      throw error;
    }
  });
}


async function startAuto(channel) {
  const ch = nick(channel || "icarolinaporto");
  stopAuto(ch);
  const game = await currentGame(ch, false);
  if (!game || game.status !== "running") return "A partida precisa estar rodando. Clique em Iniciar primeiro.";
  const intervalMs = getAutoIntervalMs();

  const scheduleNext = () => {
    const timer = setTimeout(async () => {
      if (!autoTimers.has(ch)) return;
      try {
        const g = await currentGame(ch, false);
        if (!g || g.status !== "running") {
          stopAuto(ch);
          return;
        }
        const result = await nextRound(ch);
        if (/venceu|acabou|já acabou/i.test(String(result))) {
          stopAuto(ch);
          return;
        }
        if (autoTimers.has(ch)) scheduleNext();
      } catch (e) {
        console.error("Erro no auto HG:", e);
        stopAuto(ch);
      }
    }, intervalMs);
    autoTimers.set(ch, timer);
  };

  scheduleNext();
  return `▶️ Automático ligado. Rodada a cada ${Math.round(intervalMs / 1000)}s, sem sobrepor rodadas.`;
}

function parseCommand(raw) {
  const original = String(raw || "").trim().replace(/^!hg\s+/i, "").trim();
  const q = normalize(original);
  if (!q || q === "ajuda" || q === "help") return { action: "help" };
  let m = q.match(/^(entrar|join|participar)(?:\s+(?:distrito\s*)?(\d{1,2}))?$/i);
  if (m) return { action: "join", district: m[2] || null };
  if (/^(sair|leave)$/i.test(q)) return { action: "leave" };
  m = q.match(/^(distrito|trocar|mudar)\s+(\d{1,2})$/i);
  if (m) return { action: "district", district: m[2] };
  if (/^(iniciar|start|comecar|começar)$/i.test(q)) return { action: "start" };
  if (/^(proximo|próximo|next|prosseguir|rodada|proceed)$/i.test(q)) return { action: "next" };
  if (/^(auto|automatico|automático|rodar|rodarsozinho|rodar sozinho|play)$/i.test(q)) return { action: "auto_start" };
  if (/^(parar|stop|pausar|auto off|automatico off|automático off)$/i.test(q)) return { action: "auto_stop" };
  if (/^(resetar|reset|limpar)$/i.test(q)) return { action: "reset" };
  if (/^(todos|all|adicionar todos|add todos)$/i.test(q)) return { action: "add_all" };
  if (/^(\+18|18\+|adulto|adult)\s*(on|ligar|liga)?$/i.test(q)) return { action: "adult_on" };
  if (/^(\+18|18\+|adulto|adult)\s*(off|desligar|desliga)$/i.test(q)) return { action: "adult_off" };
  m = original.match(/^(add|adicionar)\s+(.+?)(?:\s+(?:distrito\s*)?(\d{1,2}))?$/i);
  if (m) return { action: "manual_add", name: m[2], district: m[3] || null };
  return { action: "unknown" };
}

function help() {
  return "Comandos: !hg entrar | !hg entrar 5 | !hg distrito 5 | !hg sair | !hg todos | !hg iniciar | !hg proximo | !hg auto | !hg parar | !hg resetar | !hg +18 ligar/desligar";
}

async function command(req, res) {
  try {
    if (!checkBase(req, res)) return;

    const ch = channelFrom(req);
    const u = userFrom(req);
    const display = displayFrom(req) || u;
    const cmd = parseCommand(req.query.q || req.body?.q || "");

    if (cmd.action === "help" || cmd.action === "unknown") return send(res, help());
    if (cmd.action === "join") return send(res, await join(ch, u, display, cmd.district));
    if (cmd.action === "leave") return send(res, await leave(ch, u));
    if (cmd.action === "district") return send(res, await changeDistrict(ch, u, cmd.district));

    if (!checkAdmin(req, res)) return;

    if (cmd.action === "add_all") return send(res, await addAllChatters(ch));
    if (cmd.action === "start") return send(res, await start(ch));
    if (cmd.action === "next") return send(res, await nextRound(ch));
    if (cmd.action === "auto_start") return send(res, await startAuto(ch));
    if (cmd.action === "auto_stop") { stopAuto(ch); return send(res, "⏸️ Automático desligado."); }
    if (cmd.action === "reset") return send(res, await reset(ch));
    if (cmd.action === "adult_on") return send(res, await adult(ch, true));
    if (cmd.action === "adult_off") return send(res, await adult(ch, false));
    if (cmd.action === "manual_add") return send(res, await addManual(ch, cmd.name, cmd.district));

    return send(res, help());
  } catch (e) {
    console.error(e);
    return send(res, `Erro HG: ${e.message}`);
  }
}

async function adminAction(req, res) {
  try {
    if (!checkBase(req, res)) return;
    const ch = channelFrom(req);
    const action = String(req.query.action || req.body?.action || "");

    // Admin web usa token secreto na URL; não precisa de user=$(sender).
    // A proteção por usuário continua valendo no comando do chat.
    if (action === "start") return send(res, await start(ch));
    if (action === "next") return send(res, await nextRound(ch));
    if (action === "auto_start") return send(res, await startAuto(ch));
    if (action === "auto_stop") { stopAuto(ch); return send(res, "⏸️ Automático desligado."); }
    if (action === "reset") return send(res, await reset(ch));
    if (action === "adult_on") return send(res, await adult(ch, true));
    if (action === "adult_off") return send(res, await adult(ch, false));
    if (action === "add_player") return send(res, await addManual(ch, req.query.name || req.body?.name, req.query.district || req.body?.district));
    if (action === "add_all_chat") return send(res, await addAllChatters(ch));
    if (action === "seed_adult_heavy") return send(res, await seedHeavyAdultEvents());

    if (action === "add_event") {
      await ensureTables();
      const db = await getPool();
      const phase = String(req.body?.phase || req.query.phase || "day").trim();
      const type = String(req.body?.type || req.query.type || "neutral").trim();
      const players = parseEventPlayers(req.body?.players ?? req.query.players ?? 1);
      const text = String(req.body?.text || req.query.text || "").trim();
      const kills = String(req.body?.kills || req.query.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? req.query.adult ?? "0") === "1" ? 1 : 0;
      if (!text) return send(res, "Faltou o texto do evento.");
      const deathConfigError = validateEventDeathConfig(type, players, kills);
      if (deathConfigError) return send(res, deathConfigError);
      await db.query("INSERT INTO hg_events (phase,type,players,text,kills,adult) VALUES (?,?,?,?,?,?)", [phase,type,players,text,kills,adultFlag]);
      return send(res, "✅ Evento adicionado.");
    }

    if (action === "update_event") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || req.query.id || 0);
      const phase = String(req.body?.phase || req.query.phase || "day").trim();
      const type = String(req.body?.type || req.query.type || "neutral").trim();
      const players = parseEventPlayers(req.body?.players ?? req.query.players ?? 1);
      const text = String(req.body?.text || req.query.text || "").trim();
      const kills = String(req.body?.kills || req.query.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? req.query.adult ?? "0") === "1" ? 1 : 0;
      const activeFlag = String(req.body?.active ?? req.query.active ?? "1") === "1" ? 1 : 0;
      if (!id) return send(res, "ID inválido.");
      if (!text) return send(res, "Faltou o texto do evento.");
      const deathConfigError = validateEventDeathConfig(type, players, kills);
      if (deathConfigError) return send(res, deathConfigError);
      await db.query("UPDATE hg_events SET phase=?, type=?, players=?, text=?, kills=?, adult=?, active=? WHERE id=?", [phase,type,players,text,kills,adultFlag,activeFlag,id]);
      return send(res, "✅ Evento atualizado.");
    }

    if (action === "delete_event") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || req.query.id || 0);
      if (!id) return send(res, "ID inválido.");
      await db.query("DELETE FROM hg_events WHERE id=?", [id]);
      return send(res, "🗑️ Evento excluído.");
    }

    if (action === "toggle_event") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || req.query.id || 0);
      const activeFlag = String(req.body?.active ?? req.query.active ?? "1") === "1" ? 1 : 0;
      if (!id) return send(res, "ID inválido.");
      await db.query("UPDATE hg_events SET active=? WHERE id=?", [activeFlag,id]);
      return send(res, activeFlag ? "✅ Evento ativado." : "⛔ Evento desativado.");
    }

    if (action === "add_scenario") {
      await ensureTables();
      const db = await getPool();
      const name = String(req.body?.name || "").trim().slice(0, 120);
      const phase = String(req.body?.phase || "arena").trim();
      const type = String(req.body?.type || "neutral").trim();
      const players = parseEventPlayers(req.body?.players ?? 1);
      const text = String(req.body?.text || "").trim();
      const kills = String(req.body?.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? "0") === "1" ? 1 : 0;
      const mixFlag = String(req.body?.mix_with_normal ?? "1") === "1" ? 1 : 0;
      const activeFlag = String(req.body?.active ?? "1") === "1" ? 1 : 0;
      if (!name) return send(res, "Faltou o nome do evento especial.");
      if (!text) return send(res, "Faltou o texto que inicia o evento especial.");
      const deathConfigError = validateEventDeathConfig(type, players, kills);
      if (deathConfigError) return send(res, deathConfigError);
      const [result] = await db.query(
        "INSERT INTO hg_scenarios (name,phase,type,players,text,kills,adult,mix_with_normal,active) VALUES (?,?,?,?,?,?,?,?,?)",
        [name, phase, type, players, text, kills, adultFlag, mixFlag, activeFlag]
      );
      return send(res, `✅ Evento especial criado. Abra a seta para adicionar os eventos decorrentes. ID ${result.insertId}.`);
    }

    if (action === "update_scenario") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || 0);
      const name = String(req.body?.name || "").trim().slice(0, 120);
      const phase = String(req.body?.phase || "arena").trim();
      const type = String(req.body?.type || "neutral").trim();
      const players = parseEventPlayers(req.body?.players ?? 1);
      const text = String(req.body?.text || "").trim();
      const kills = String(req.body?.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? "0") === "1" ? 1 : 0;
      const mixFlag = String(req.body?.mix_with_normal ?? "1") === "1" ? 1 : 0;
      const activeFlag = String(req.body?.active ?? "1") === "1" ? 1 : 0;
      if (!id) return send(res, "ID inválido.");
      if (!name || !text) return send(res, "Preencha o nome e o texto inicial.");
      const deathConfigError = validateEventDeathConfig(type, players, kills);
      if (deathConfigError) return send(res, deathConfigError);
      await db.query(
        "UPDATE hg_scenarios SET name=?,phase=?,type=?,players=?,text=?,kills=?,adult=?,mix_with_normal=?,active=? WHERE id=?",
        [name, phase, type, players, text, kills, adultFlag, mixFlag, activeFlag, id]
      );
      if (!activeFlag) await db.query("UPDATE hg_games SET active_scenario_id=NULL WHERE active_scenario_id=?", [id]);
      return send(res, "✅ Evento especial atualizado.");
    }

    if (action === "delete_scenario") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || 0);
      if (!id) return send(res, "ID inválido.");
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query("UPDATE hg_games SET active_scenario_id=NULL WHERE active_scenario_id=?", [id]);
        await conn.query("DELETE FROM hg_scenario_usage WHERE scenario_id=?", [id]);
        await conn.query("DELETE FROM hg_game_scenario_runs WHERE scenario_id=?", [id]);
        await conn.query("DELETE FROM hg_scenario_events WHERE scenario_id=?", [id]);
        await conn.query("DELETE FROM hg_scenarios WHERE id=?", [id]);
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch {}
        throw e;
      } finally {
        conn.release();
      }
      return send(res, "🗑️ Evento especial e seus eventos decorrentes foram excluídos.");
    }

    if (action === "add_scenario_event") {
      await ensureTables();
      const db = await getPool();
      const scenarioId = Number(req.body?.scenario_id || 0);
      const phase = String(req.body?.phase || "any").trim();
      const type = String(req.body?.type || "neutral").trim();
      const players = parseEventPlayers(req.body?.players ?? 1);
      const text = String(req.body?.text || "").trim();
      const kills = String(req.body?.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? "0") === "1" ? 1 : 0;
      const activeFlag = String(req.body?.active ?? "1") === "1" ? 1 : 0;
      if (!scenarioId) return send(res, "Evento especial inválido.");
      if (!text) return send(res, "Faltou o texto do evento decorrente.");
      const deathConfigError = validateEventDeathConfig(type, players, kills);
      if (deathConfigError) return send(res, deathConfigError);
      const [exists] = await db.query("SELECT id FROM hg_scenarios WHERE id=? LIMIT 1", [scenarioId]);
      if (!exists.length) return send(res, "Evento especial não encontrado.");
      const [ord] = await db.query("SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM hg_scenario_events WHERE scenario_id=?", [scenarioId]);
      await db.query(
        "INSERT INTO hg_scenario_events (scenario_id,phase,type,players,text,kills,adult,active,sort_order) VALUES (?,?,?,?,?,?,?,?,?)",
        [scenarioId, phase, type, players, text, kills, adultFlag, activeFlag, Number(ord?.[0]?.next_order || 1)]
      );
      return send(res, "✅ Evento decorrente adicionado.");
    }

    if (action === "update_scenario_event") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || 0);
      const phase = String(req.body?.phase || "any").trim();
      const type = String(req.body?.type || "neutral").trim();
      const players = parseEventPlayers(req.body?.players ?? 1);
      const text = String(req.body?.text || "").trim();
      const kills = String(req.body?.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? "0") === "1" ? 1 : 0;
      const activeFlag = String(req.body?.active ?? "1") === "1" ? 1 : 0;
      if (!id) return send(res, "ID inválido.");
      if (!text) return send(res, "Faltou o texto do evento decorrente.");
      const deathConfigError = validateEventDeathConfig(type, players, kills);
      if (deathConfigError) return send(res, deathConfigError);
      await db.query(
        "UPDATE hg_scenario_events SET phase=?,type=?,players=?,text=?,kills=?,adult=?,active=? WHERE id=?",
        [phase, type, players, text, kills, adultFlag, activeFlag, id]
      );
      return send(res, "✅ Evento decorrente atualizado.");
    }

    if (action === "delete_scenario_event") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || 0);
      if (!id) return send(res, "ID inválido.");
      await db.query("DELETE FROM hg_scenario_usage WHERE event_id=?", [id]);
      await db.query("DELETE FROM hg_scenario_events WHERE id=?", [id]);
      return send(res, "🗑️ Evento decorrente excluído.");
    }

    return send(res, "Ação inválida.");
  } catch (e) {
    console.error(e);
    return send(res, `Erro admin HG: ${e.message}`);
  }
}

async function state(req, res) {
  let conn = null;
  try {
    const ch = channelFrom(req);
    await currentGame(ch, true);
    const db = await getPool();
    conn = await db.getConnection();

    // Todas as partes do painel vêm do mesmo retrato do banco. Sem isso, uma
    // morte podia entrar nos logs entre a consulta dos jogadores e dos eventos,
    // fazendo a pessoa parecer viva e morta ao mesmo tempo.
    await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await conn.beginTransaction();
    const [games] = await conn.query(
      "SELECT * FROM hg_games WHERE channel=? AND status IN ('lobby','running','ended') ORDER BY id DESC LIMIT 1",
      [ch]
    );
    const game = games[0];
    const [players] = game
      ? await conn.query("SELECT * FROM hg_players WHERE game_id=? ORDER BY district ASC, alive DESC, id ASC", [game.id])
      : [[]];
    const [logs] = game
      ? await conn.query("SELECT * FROM hg_logs WHERE game_id=? ORDER BY id DESC LIMIT 150", [game.id])
      : [[]];
    const [events] = await conn.query(`
      SELECT
        (SELECT COUNT(*) FROM hg_events WHERE active=1) +
        (SELECT COUNT(*) FROM hg_scenarios WHERE active=1) +
        (SELECT COUNT(*) FROM hg_scenario_events se JOIN hg_scenarios sc ON sc.id=se.scenario_id WHERE se.active=1 AND sc.active=1) AS total,
        (SELECT COUNT(*) FROM hg_events WHERE active=1 AND adult=1) +
        (SELECT COUNT(*) FROM hg_scenarios WHERE active=1 AND adult=1) +
        (SELECT COUNT(*) FROM hg_scenario_events se JOIN hg_scenarios sc ON sc.id=se.scenario_id WHERE se.active=1 AND sc.active=1 AND se.adult=1) AS adultTotal
    `);
    const [activeScenarioRows] = game?.active_scenario_id
      ? await conn.query("SELECT id,name,mix_with_normal FROM hg_scenarios WHERE id=? LIMIT 1", [game.active_scenario_id])
      : [[]];
    await conn.commit();

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.json({
      game,
      players,
      logs: logs.reverse(),
      eventCount: Number(events?.[0]?.total || 0),
      adultEventCount: Number(events?.[0]?.adultTotal || 0),
      activeScenario: activeScenarioRows?.[0] || null,
      autoRunning: isAutoRunning(ch),
      autoIntervalMs: getAutoIntervalMs()
    });
  } catch (e) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    if (conn) conn.release();
  }
}


function page(admin = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hunger Games da Live</title>
<meta name="hg-version" content="${APP_VERSION}"/>
<!-- HG_VERSION ${APP_VERSION} -->
<style>
:root{--bg:#07070c;--card:#141421;--card2:#1c1c2d;--text:#f8f7ff;--muted:#aaa6c8;--p:#a855f7;--d:#ef4444;--ok:#22c55e;--b:#303044}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#2a1247,#080810 46%,#050509);color:var(--text);font-family:Inter,system-ui,Arial,sans-serif}.wrap{max-width:1280px;margin:auto;padding:22px}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start}h1{margin:0;font-size:clamp(30px,4vw,54px);letter-spacing:-.05em}.sub,.small{color:var(--muted)}.pill{border:1px solid var(--b);background:#141421d9;border-radius:999px;padding:9px 13px;font-weight:900}
.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-top:20px}@media(max-width:900px){.grid{grid-template-columns:1fr}}.card{background:#141421dd;border:1px solid var(--b);border-radius:26px;padding:18px;box-shadow:0 16px 50px #0008}.controls{display:flex;gap:8px;flex-wrap:wrap}
button,.btn{border:0;border-radius:14px;padding:11px 14px;font-weight:950;color:white;background:var(--p);cursor:pointer}.danger{background:var(--d)}.ok{background:var(--ok);color:#061208}.secondary{background:#303044}
input,select,textarea{width:100%;background:#0d0d16;color:var(--text);border:1px solid var(--b);border-radius:14px;padding:11px;font:inherit}textarea{min-height:90px}.players{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.player{border:1px solid var(--b);background:var(--card2);border-radius:18px;padding:12px;display:flex;gap:12px;align-items:center}.dead{opacity:.45;filter:grayscale(1)}.avatar{width:46px;height:46px;border-radius:14px;object-fit:cover;background:#333}.fake{display:flex;align-items:center;justify-content:center;background:#402060;font-weight:950}
.district{color:#d8b4fe;font-weight:950;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.name{font-weight:950}.kills{font-size:12px;color:var(--muted)}.logs{display:flex;flex-direction:column;gap:14px;max-height:760px;overflow:auto}.log{border:1px solid var(--b);background:#11111c;border-radius:22px;padding:14px;line-height:1.45}.death{border-color:#7f1d1d;background:#1c1014}.phase{color:#f0abfc;font-weight:950;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.event-avatars{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 12px}.event-person{min-width:86px;text-align:center}.event-person .avatar,.event-person .fake{width:72px;height:72px;border-radius:18px;margin:0 auto 6px;object-fit:cover;border:1px solid var(--b)}.event-name{display:none!important}.event-text{font-size:15px;font-weight:800}.lobby-only.hidden{display:none}.two{display:grid;grid-template-columns:1fr 100px;gap:8px}

body.hg-running .grid{display:block!important}
body.hg-running .arena-card{display:none!important}
body.hg-running .events-card{width:100%!important;max-width:none!important}
body.hg-running .logs{max-height:none!important;overflow:visible!important}
body.hg-running .log{max-width:820px;margin:0 auto 18px auto;padding:20px;border-radius:26px}
body.hg-running .event-avatars{justify-content:center;margin:10px 0 14px}
body.hg-running .event-person .avatar,body.hg-running .event-person .fake{width:96px;height:96px;border-radius:22px}
body.hg-running .event-name{display:none!important}
body.hg-running .event-text{text-align:center;font-size:18px;line-height:1.45}
body.hg-running h2.events-title{text-align:center;font-size:28px}
body.hg-running .top-main-info{display:none!important}


body .event-person .event-name,
body.hg-running .event-person .event-name,
.event-avatars .event-name{display:none!important;font-size:0!important;width:0!important;height:0!important;overflow:hidden!important}
.event-person{font-size:0!important;line-height:0!important}
.event-person img,.event-person .avatar,.event-person .fake{font-size:16px!important;line-height:normal!important}

.scenario-create-grid,.scenario-edit-grid,.child-edit-grid{display:grid;grid-template-columns:1.25fr 1fr .7fr 1.4fr .8fr;gap:8px;margin-top:12px}.scenario-card{border:1px solid var(--b);background:#10101a;border-radius:20px;overflow:hidden}.scenario-head{display:flex;align-items:center;gap:10px;padding:14px;cursor:pointer;background:#171726}.scenario-arrow{width:42px;min-width:42px;padding:9px;background:#303044}.scenario-title{flex:1}.scenario-body{padding:14px;border-top:1px solid var(--b)}.scenario-body.collapsed{display:none}.scenario-flags{display:flex;gap:8px;flex-wrap:wrap}.flag{font-size:11px;font-weight:950;border:1px solid var(--b);border-radius:999px;padding:5px 8px;color:#ddd6fe}.switch-row{display:flex;align-items:center;gap:10px;border:1px solid var(--b);background:#0d0d16;border-radius:14px;padding:10px 12px}.switch-row input{width:20px;height:20px;accent-color:var(--p)}.child-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}.child-card{border:1px solid var(--b);border-radius:16px;padding:12px;background:#0d0d16}.scenario-help{border-left:4px solid var(--p);padding:10px 12px;background:#1b1026;border-radius:10px;margin:10px 0}.wide-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.narration-bar{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;gap:8px;margin:0 0 8px}.narration-bar button{white-space:nowrap}.narration-help{margin:0 0 14px}.story-card{border-color:#6b21a8;box-shadow:0 18px 60px #581c8730}.player-count-note{display:block;margin-top:6px;color:#c4b5fd}@media(max-width:900px){.scenario-create-grid,.scenario-edit-grid,.child-edit-grid{grid-template-columns:1fr 1fr}.scenario-create-grid textarea,.scenario-edit-grid textarea,.child-edit-grid textarea,.span-all{grid-column:1/-1}.narration-bar{grid-template-columns:1fr}.admin-event-grid{grid-template-columns:1fr 1fr!important}}
</style></head><body><div class="wrap"><div class="top"><div><h1>Hunger Games da Live</h1><div class="sub">Participantes do chat, distritos, eventos, mortes e vencedor final.</div></div><div class="pill" id="statusPill">Carregando...</div></div>
<div class="grid"><section class="card arena-card"><div class="top"><div><div class="phase" id="phase">Arena</div><div style="font-size:18px;font-weight:950" id="status">Carregando...</div><div class="small" id="counts"></div></div>${admin ? `<div class="controls"><button class="ok" onclick="act('start')">Iniciar</button><button class="secondary" onclick="act('next')">Próximo</button><button class="ok" onclick="act('auto_start')">Rodar sozinho</button><button class="secondary" onclick="act('auto_stop')">Parar automático</button><button class="danger" onclick="act('reset')">Resetar</button><button class="secondary" onclick="act('adult_on')">Ligar +18</button><button class="secondary" onclick="act('adult_off')">Desligar +18</button><button class="secondary" onclick="act('add_all_chat')">Adicionar todos do chat</button><button class="secondary" onclick="seedAdultHeavy()">Adicionar +18 pesado</button></div>` : ``}</div>
${admin ? `<div class="two" style="margin:16px 0"><input id="manualName" placeholder="Adicionar participante manual"/><input id="manualDistrict" placeholder="Distrito" type="number" min="1" max="12"/><button style="grid-column:1/-1" onclick="addPlayer()">Adicionar participante</button></div>` : ``}
<div id="participantsBox" class="lobby-only"><h2>Participantes</h2><div class="players" id="players"></div></div></section><aside class="card events-card"><h2 class="events-title">Eventos</h2><div class="narration-bar"><button id="narrationToggle" class="secondary" onclick="toggleNarration()">🔊 Ativar narração</button><select id="narrationVoice" aria-label="Voz da narração"></select><button class="secondary" onclick="testNarration()">▶ Testar voz</button></div><div class="small narration-help">A narração usa a voz disponível neste navegador e prioriza Google Português do Brasil quando ela existir.</div><div class="logs" id="logs"></div></aside></div>
${admin ? `<section class="card story-card" style="margin-top:18px"><h2>Modo História</h2><div class="scenario-help"><b>Exemplo:</b> “Um ET invade a arena”. Crie a introdução e depois abra a seta para cadastrar os acontecimentos decorrentes.</div><div class="small">Na seleção de pessoas, escolha <b>Todos</b> para colocar todos os participantes vivos na mesma cena. No texto, use <b>{p}</b> ou <b>{todos}</b> para mostrar todos os nomes.</div>
<input id="scName" style="margin-top:12px" placeholder="Nome da história: Invasão alienígena"/>
<div class="scenario-create-grid"><select id="scPhase"><option value="bloodbath">Cornucópia</option><option value="day">Dia</option><option value="night">Noite</option><option value="feast">Banquete</option><option value="arena" selected>Evento da arena</option></select><select id="scType"><option value="neutral">Neutro</option><option value="death">Morte</option><option value="item">Item</option><option value="alliance">Aliança</option><option value="adult">Adulto</option></select><select id="scPlayers"><option value="1">1 pessoa</option><option value="2">2 pessoas</option><option value="3">3 pessoas</option><option value="4">4 pessoas</option><option value="0" selected>Todos</option></select><input id="scKills" placeholder="Mortes: p2"/><select id="scAdult"><option value="0">Normal</option><option value="1">+18</option></select></div>
<textarea id="scText" placeholder="Um ET invade a arena diante de {p}."></textarea><span class="small player-count-note">“Todos” usa todos que estiverem vivos quando a introdução acontecer. Eventos para Todos não usam o campo Mortes.</span>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><label class="switch-row"><input id="scMix" type="checkbox" checked/><span><b>Misturar com eventos normais</b><br><span class="small">Desligue para usar somente os eventos desta história.</span></span></label><label class="switch-row"><input id="scActive" type="checkbox" checked/><span><b>História ativa</b><br><span class="small">Desligue para impedir que ela seja sorteada.</span></span></label></div>
<button style="margin-top:10px" onclick="addScenario()">Criar história</button><hr style="border-color:var(--b);margin:24px 0"><div class="top"><div><h2>Histórias criadas</h2><div class="small">Clique na seta para expandir ou encolher e editar os eventos internos.</div></div><button class="secondary" onclick="loadScenarios()">Recarregar histórias</button></div><div id="scenariosEditor" style="display:flex;flex-direction:column;gap:12px;margin-top:14px"></div></section>
<section class="card" style="margin-top:18px"><h2>Adicionar evento normal</h2><div class="small">Use {p1}, {p2}, {p3}, {p4}. Ao escolher Todos, use {p} ou {todos}. Para matar alguém, escolha de 1 a 4 pessoas e coloque em Mortes: p2 ou p1,p3.</div><div class="admin-event-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:12px"><select id="evPhase"><option value="bloodbath">Cornucópia</option><option value="day">Dia</option><option value="night">Noite</option><option value="feast">Banquete</option><option value="arena">Evento da arena</option></select><select id="evType"><option value="neutral">Neutro</option><option value="death">Morte</option><option value="item">Item</option><option value="alliance">Aliança</option><option value="adult">Adulto</option></select><select id="evPlayers"><option value="1">1 pessoa</option><option value="2">2 pessoas</option><option value="3">3 pessoas</option><option value="4">4 pessoas</option><option value="0">Todos</option></select><input id="evKills" placeholder="Mortes: p2"/><select id="evAdult"><option value="0">Normal</option><option value="1">+18</option></select></div><textarea id="evText" placeholder="{p1} faz alguma coisa com {p2}."></textarea><button onclick="addEvent()">Salvar evento</button><hr style="border-color:var(--b);margin:24px 0"><div class="top"><div><h2>Editar eventos existentes</h2><div class="small">Aqui edita, desativa ou exclui os eventos que já estão cadastrados.</div></div><button class="secondary" onclick="loadEvents()">Recarregar eventos</button></div><div id="eventsEditor" style="display:flex;flex-direction:column;gap:12px;margin-top:14px"></div></section>` : ``}</div>
<script>
const params=new URLSearchParams(location.search),channel=params.get("channel")||"icarolinaporto",token=params.get("token")||"",admin=${admin?"true":"false"};
const statusLabels={lobby:"AGUARDANDO",running:"EM ANDAMENTO",ended:"ENCERRADA",archived:"ARQUIVADA"};
const phaseLabels={any:"Qualquer fase",bloodbath:"Cornucópia",day:"Dia",night:"Noite",feast:"Banquete",arena:"Evento da arena",reaping:"Início da arena",winner:"Vencedor"};
const typeLabels={neutral:"Neutro",death:"Morte",item:"Item",alliance:"Aliança",adult:"Adulto"};
function phaseLabel(phase,day){const p=phaseLabels[phase]||phase||"Arena";if(["day","night","feast"].includes(phase))return p+" "+(day||1);return p}
function typeLabel(type){return typeLabels[type]||type||"Neutro"}
function playerOptions(value,allowAll=true){const current=Number(value);const items=[[1,"1 pessoa"],[2,"2 pessoas"],[3,"3 pessoas"],[4,"4 pessoas"]];if(allowAll)items.push([0,"Todos"]);return items.map(x=>'<option value="'+x[0]+'" '+(current===x[0]?"selected":"")+'>'+x[1]+'</option>').join("")}
function playerLabel(value){return Number(value)===0?"Todos":String(value||1)+" pessoa(s)"}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[m]))}
async function api(path,opt={}){const sep=path.includes("?")?"&":"?";const url=path+sep+"channel="+encodeURIComponent(channel)+(token?"&token="+encodeURIComponent(token):"");const r=await fetch(url,{cache:"no-store",...opt}),ct=r.headers.get("content-type")||"";return ct.includes("json")?r.json():r.text()}
function avatarHtml(p,cls="avatar"){return p&&p.avatar_url?'<img class="'+cls+'" src="'+esc(p.avatar_url)+'">':'<div class="'+cls+' fake">'+esc(((p&&p.display_name)||"?").slice(0,1).toUpperCase())+'</div>'}
function mentionedPlayers(text,players){const found=[];const lower=String(text||"").toLowerCase();players.forEach(p=>{const nm=String(p.display_name||p.username||"").toLowerCase();if(nm&&lower.includes(nm)&&!found.some(x=>x.id===p.id))found.push(p)});return found}
let narrationEnabled=false,narrationInitialized=false,lastNarratedLogId=0,narrationVoices=[];
function availableNarrationVoices(){return (window.speechSynthesis?.getVoices?.()||[]).slice()}
function populateNarrationVoices(){const select=document.getElementById("narrationVoice");if(!select||!window.speechSynthesis)return;narrationVoices=availableNarrationVoices();const saved=localStorage.getItem("hgNarrationVoice")||"";narrationVoices.sort((a,b)=>{const apt=/^pt(-|_)/i.test(a.lang)?0:1,bpt=/^pt(-|_)/i.test(b.lang)?0:1;return apt-bpt||a.name.localeCompare(b.name)});select.innerHTML=narrationVoices.map((v,i)=>'<option value="'+i+'">'+esc(v.name+' — '+v.lang)+'</option>').join("")||'<option value="">Voz padrão do navegador</option>';let chosen=narrationVoices.findIndex(v=>v.name===saved);if(chosen<0)chosen=narrationVoices.findIndex(v=>/google/i.test(v.name)&&/^pt(-|_)?br/i.test(v.lang));if(chosen<0)chosen=narrationVoices.findIndex(v=>/^pt(-|_)?br/i.test(v.lang));if(chosen<0)chosen=narrationVoices.findIndex(v=>/^pt/i.test(v.lang));if(chosen>=0)select.value=String(chosen);select.onchange=()=>{const v=narrationVoices[Number(select.value)];if(v)localStorage.setItem("hgNarrationVoice",v.name)}}
function selectedNarrationVoice(){const select=document.getElementById("narrationVoice");return select&&select.value!==""?narrationVoices[Number(select.value)]||null:null}
function updateNarrationButton(){const b=document.getElementById("narrationToggle");if(b)b.textContent=narrationEnabled?"🔇 Desativar narração":"🔊 Ativar narração"}
function toggleNarration(){if(!("speechSynthesis" in window)){alert("Este navegador não oferece narração de texto.");return}narrationEnabled=!narrationEnabled;if(!narrationEnabled)window.speechSynthesis.cancel();populateNarrationVoices();updateNarrationButton()}
function testNarration(){if(!("speechSynthesis" in window)){alert("Este navegador não oferece narração de texto.");return}populateNarrationVoices();const wasEnabled=narrationEnabled;narrationEnabled=true;window.speechSynthesis.cancel();speakNarration("Teste de narração do modo história. A arena está pronta.");narrationEnabled=wasEnabled;updateNarrationButton()}
function speakNarration(text){if(!narrationEnabled||!("speechSynthesis" in window)||!String(text||"").trim())return;const u=new SpeechSynthesisUtterance(String(text));u.lang="pt-BR";u.rate=1;u.pitch=1;const v=selectedNarrationVoice();if(v)u.voice=v;window.speechSynthesis.speak(u)}
function handleNarration(logs){const list=Array.isArray(logs)?logs:[];const maxId=list.reduce((m,l)=>Math.max(m,Number(l.id||0)),0);if(!narrationInitialized){lastNarratedLogId=maxId;narrationInitialized=true;return}const news=list.filter(l=>Number(l.id||0)>lastNarratedLogId&&!String(l.text||"").startsWith("📍")).sort((a,b)=>Number(a.id)-Number(b.id));lastNarratedLogId=Math.max(lastNarratedLogId,maxId);for(const l of news)speakNarration(l.text)}
if("speechSynthesis" in window){populateNarrationVoices();window.speechSynthesis.onvoiceschanged=populateNarrationVoices}
let loadInProgress=false,loadAgain=false;
async function load(){
  if(loadInProgress){loadAgain=true;return}
  loadInProgress=true;
  try{
    const st=await api("/hg/state"),g=st.game||{};document.body.classList.toggle("hg-running",!admin&&(g.status==="running"||g.status==="ended"));document.getElementById("statusPill").textContent=(statusLabels[g.status]||"AGUARDANDO")+(g.adult_mode?" • +18":"");document.getElementById("phase").textContent=phaseLabel(g.phase||"bloodbath",g.day_number||1);document.getElementById("status").textContent=g.status==="running"?"Partida rolando":g.status==="ended"?("Vencedor: "+(g.winner||"ninguém")):"Aguardando participantes";const alive=st.players.filter(p=>p.alive).length;document.getElementById("counts").textContent=st.players.length+" participantes • "+alive+" vivos • "+st.eventCount+" eventos"+(st.activeScenario?" • Especial: "+st.activeScenario.name:"")+(st.autoRunning?" • automático ligado":"");
const box=document.getElementById("participantsBox");if(box)box.classList.toggle("hidden",g.status==="running");
document.getElementById("players").innerHTML=st.players.map(p=>{const av=avatarHtml(p);return '<div class="player '+(p.alive?'':'dead')+'">'+av+'<div><div class="district">Distrito '+p.district+'</div><div class="name">'+esc(p.display_name)+'</div><div class="kills">'+(p.kills||0)+' abate(s) '+(p.alive?'🟢':'💀')+'</div></div></div>'}).join("")||"<div class='small'>Ninguém entrou ainda.</div>";
document.getElementById("logs").innerHTML=st.logs.map(l=>{const ps=mentionedPlayers(l.text,st.players);const avs=ps.length?'<div class="event-avatars">'+ps.map(p=>'<div class="event-person">'+avatarHtml(p,"avatar")+'</div>').join("")+'</div>':'';return '<div class="log '+(l.deaths?'death':'')+'"><div class="phase">'+esc(phaseLabel(l.phase,l.day_number))+'</div>'+avs+'<div class="event-text">'+esc(l.text)+'</div>'+(l.deaths?'<div class="small">Mortes: '+esc(l.deaths)+'</div>':'')+'</div>'}).join("")||"<div class='small'>Sem eventos ainda.</div>";document.querySelectorAll(".event-name").forEach(e=>e.remove());handleNarration(st.logs)  }finally{
    loadInProgress=false;
    if(loadAgain){loadAgain=false;queueMicrotask(load)}
  }
}
let actionBusy=false;
async function act(a){if(!token)return alert("Abra com ?token=SEU_TOKEN");if(actionBusy)return;actionBusy=true;try{const t=await api("/hg/admin?action="+encodeURIComponent(a));alert(t);await load()}finally{actionBusy=false}}
async function seedAdultHeavy(){if(!confirm("Adicionar pacote de eventos +18 pesado ao banco?"))return;const t=await api("/hg/admin?action=seed_adult_heavy");alert(t);load();if(admin)loadEvents()}
async function addPlayer(){const name=document.getElementById("manualName").value.trim(),d=document.getElementById("manualDistrict").value.trim();if(!name)return alert("Nome vazio");const t=await api("/hg/admin?action=add_player&name="+encodeURIComponent(name)+"&district="+encodeURIComponent(d));alert(t);load()}
async function addEvent(){const body={action:"add_event",phase:evPhase.value,type:evType.value,players:evPlayers.value,kills:evKills.value,adult:evAdult.value,text:evText.value};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);evText.value="";load();if(admin)loadEvents()}
function eventRow(e){return '<div class="log" style="max-width:none;margin:0"><div class="phase">ID '+e.id+' • '+esc(phaseLabels[e.phase]||e.phase)+' • '+esc(typeLabel(e.type))+' • '+esc(playerLabel(e.players))+' • '+(e.adult?"+18":"Normal")+' • '+(e.active?"Ativo":"Desativado")+'</div><div style="display:grid;grid-template-columns:120px 120px 80px 1fr 100px 100px;gap:8px;margin:8px 0"><select id="phase_'+e.id+'"><option value="bloodbath" '+(e.phase==="bloodbath"?"selected":"")+'>Cornucópia</option><option value="day" '+(e.phase==="day"?"selected":"")+'>Dia</option><option value="night" '+(e.phase==="night"?"selected":"")+'>Noite</option><option value="feast" '+(e.phase==="feast"?"selected":"")+'>Banquete</option><option value="arena" '+(e.phase==="arena"?"selected":"")+'>Evento da arena</option></select><select id="type_'+e.id+'"><option value="neutral" '+(e.type==="neutral"?"selected":"")+'>Neutro</option><option value="death" '+(e.type==="death"?"selected":"")+'>Morte</option><option value="item" '+(e.type==="item"?"selected":"")+'>Item</option><option value="alliance" '+(e.type==="alliance"?"selected":"")+'>Aliança</option><option value="adult" '+(e.type==="adult"?"selected":"")+'>Adulto</option></select><select id="players_'+e.id+'">'+playerOptions(e.players,true)+'</select><input id="kills_'+e.id+'" placeholder="Mortes" value="'+esc(e.kills||"")+'"><select id="adult_'+e.id+'"><option value="0" '+(!e.adult?"selected":"")+'>Normal</option><option value="1" '+(e.adult?"selected":"")+'>+18</option></select><select id="active_'+e.id+'"><option value="1" '+(e.active?"selected":"")+'>Ativo</option><option value="0" '+(!e.active?"selected":"")+'>Desativado</option></select></div><textarea id="text_'+e.id+'">'+esc(e.text)+'</textarea><div class="controls" style="margin-top:8px"><button onclick="saveEvent('+e.id+')">Salvar edição</button><button class="danger" onclick="deleteEvent('+e.id+')">Excluir</button></div></div>'}
async function loadEvents(){if(!admin)return;const box=document.getElementById("eventsEditor");if(!box)return;box.innerHTML="<div class='small'>Carregando eventos...</div>";const evs=await api("/hg/events");if(!Array.isArray(evs)){box.innerHTML="<div class='small'>Erro ao carregar eventos.</div>";return}box.innerHTML=evs.map(eventRow).join("")||"<div class='small'>Sem eventos cadastrados.</div>"}
async function saveEvent(id){const body={action:"update_event",id,phase:document.getElementById("phase_"+id).value,type:document.getElementById("type_"+id).value,players:document.getElementById("players_"+id).value,kills:document.getElementById("kills_"+id).value,adult:document.getElementById("adult_"+id).value,active:document.getElementById("active_"+id).value,text:document.getElementById("text_"+id).value};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);loadEvents();load()}
async function deleteEvent(id){if(!confirm("Excluir este evento?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_event",id})});alert(t);loadEvents();load()}
const openScenarios=new Set();
function phaseOptions(value,allowAny=false){const items=[];if(allowAny)items.push(["any","Qualquer fase"]);items.push(["bloodbath","Cornucópia"],["day","Dia"],["night","Noite"],["feast","Banquete"],["arena","Evento da arena"]);return items.map(x=>'<option value="'+x[0]+'" '+(value===x[0]?"selected":"")+'>'+x[1]+'</option>').join("")}
function typeOptions(value){return [["neutral","Neutro"],["death","Morte"],["item","Item"],["alliance","Aliança"],["adult","Adulto"]].map(x=>'<option value="'+x[0]+'" '+(value===x[0]?"selected":"")+'>'+x[1]+'</option>').join("")}
function toggleScenario(id){const body=document.getElementById("scenario_body_"+id),arrow=document.getElementById("scenario_arrow_"+id);if(!body)return;const opening=body.classList.contains("collapsed");body.classList.toggle("collapsed",!opening);arrow.textContent=opening?"▼":"▶";if(opening)openScenarios.add(id);else openScenarios.delete(id)}
async function addScenario(){const g=id=>document.getElementById(id);const body={action:"add_scenario",name:g("scName").value,phase:g("scPhase").value,type:g("scType").value,players:g("scPlayers").value,kills:g("scKills").value,adult:g("scAdult").value,text:g("scText").value,mix_with_normal:g("scMix").checked?"1":"0",active:g("scActive").checked?"1":"0"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);if(String(t).startsWith("✅")){g("scName").value="";g("scText").value=""}await loadScenarios();load()}
function scenarioChildRow(c,sid){return '<div class="child-card"><div class="phase">EVENTO DA HISTÓRIA ID '+c.id+' • '+esc(phaseLabels[c.phase]||c.phase)+' • '+esc(typeLabel(c.type))+' • '+esc(playerLabel(c.players))+' • '+(c.active?"Ativo":"Desativado")+'</div><div class="child-edit-grid"><select id="sce_phase_'+c.id+'">'+phaseOptions(c.phase,true)+'</select><select id="sce_type_'+c.id+'">'+typeOptions(c.type)+'</select><select id="sce_players_'+c.id+'">'+playerOptions(c.players,true)+'</select><input id="sce_kills_'+c.id+'" placeholder="Mortes: p2" value="'+esc(c.kills||"")+'"><select id="sce_adult_'+c.id+'"><option value="0" '+(!c.adult?"selected":"")+'>Normal</option><option value="1" '+(c.adult?"selected":"")+'>+18</option></select></div><textarea id="sce_text_'+c.id+'">'+esc(c.text)+'</textarea><div class="wide-actions"><label class="switch-row"><input id="sce_active_'+c.id+'" type="checkbox" '+(c.active?"checked":"")+'><span>Evento decorrente ativo</span></label><button onclick="saveScenarioEvent('+c.id+','+sid+')">Salvar evento interno</button><button class="danger" onclick="deleteScenarioEvent('+c.id+','+sid+')">Excluir</button></div></div>'}
function scenarioRow(s){const opened=openScenarios.has(Number(s.id));const children=(s.events||[]).map(c=>scenarioChildRow(c,s.id)).join("")||'<div class="small">Nenhum evento decorrente criado. Use o formulário abaixo.</div>';return '<div class="scenario-card"><div class="scenario-head" onclick="toggleScenario('+s.id+')"><button class="scenario-arrow" id="scenario_arrow_'+s.id+'">'+(opened?"▼":"▶")+'</button><div class="scenario-title"><div style="font-weight:950;font-size:17px">'+esc(s.name)+'</div><div class="scenario-flags"><span class="flag">ID '+s.id+'</span><span class="flag">'+esc(phaseLabels[s.phase]||s.phase)+'</span><span class="flag">'+(s.mix_with_normal?"Mistura com normais":"Somente esta história")+'</span><span class="flag">'+(s.active?"Ativo":"Desativado")+'</span><span class="flag">'+esc(playerLabel(s.players))+'</span><span class="flag">'+(s.events||[]).length+' decorrente(s)</span></div></div></div><div id="scenario_body_'+s.id+'" class="scenario-body '+(opened?"":"collapsed")+'"><input id="sc_name_'+s.id+'" value="'+esc(s.name)+'"><div class="scenario-edit-grid"><select id="sc_phase_'+s.id+'">'+phaseOptions(s.phase,false)+'</select><select id="sc_type_'+s.id+'">'+typeOptions(s.type)+'</select><select id="sc_players_'+s.id+'">'+playerOptions(s.players,true)+'</select><input id="sc_kills_'+s.id+'" placeholder="Mortes: p2" value="'+esc(s.kills||"")+'"><select id="sc_adult_'+s.id+'"><option value="0" '+(!s.adult?"selected":"")+'>Normal</option><option value="1" '+(s.adult?"selected":"")+'>+18</option></select></div><textarea id="sc_text_'+s.id+'">'+esc(s.text)+'</textarea><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><label class="switch-row"><input id="sc_mix_'+s.id+'" type="checkbox" '+(s.mix_with_normal?"checked":"")+'><span><b>Misturar com eventos normais</b><br><span class="small">Desligado: somente os eventos internos.</span></span></label><label class="switch-row"><input id="sc_active_'+s.id+'" type="checkbox" '+(s.active?"checked":"")+'><span><b>História ativa</b><br><span class="small">Controla se o início pode ser sorteado.</span></span></label></div><div class="wide-actions"><button onclick="saveScenario('+s.id+')">Salvar história</button><button class="danger" onclick="deleteScenario('+s.id+')">Excluir tudo</button></div><hr style="border-color:var(--b);margin:18px 0"><h3>Adicionar evento decorrente</h3><div class="small">“Qualquer fase” é recomendado para a história continuar sem ficar esperando Dia ou Noite.</div><div class="child-edit-grid"><select id="new_sce_phase_'+s.id+'">'+phaseOptions("any",true)+'</select><select id="new_sce_type_'+s.id+'">'+typeOptions("neutral")+'</select><select id="new_sce_players_'+s.id+'">'+playerOptions(1,true)+'</select><input id="new_sce_kills_'+s.id+'" placeholder="Mortes: p2"><select id="new_sce_adult_'+s.id+'"><option value="0">Normal</option><option value="1">+18</option></select></div><textarea id="new_sce_text_'+s.id+'" placeholder="{p1} tenta conversar com o ET. Use {p} para Todos."></textarea><span class="small player-count-note">Selecione Todos e use {p} ou {todos} para colocar todos os vivos nesta cena.</span><button onclick="addScenarioEvent('+s.id+')">Adicionar dentro desta história</button><hr style="border-color:var(--b);margin:18px 0"><h3>Eventos decorrentes cadastrados</h3><div class="child-list">'+children+'</div></div></div>'}
async function loadScenarios(){if(!admin)return;const box=document.getElementById("scenariosEditor");if(!box)return;box.innerHTML="<div class='small'>Carregando histórias...</div>";const rows=await api("/hg/scenarios");if(!Array.isArray(rows)){box.innerHTML="<div class='small'>Erro ao carregar histórias.</div>";return}box.innerHTML=rows.map(scenarioRow).join("")||"<div class='small'>Nenhuma história criada.</div>"}
async function saveScenario(id){const body={action:"update_scenario",id,name:document.getElementById("sc_name_"+id).value,phase:document.getElementById("sc_phase_"+id).value,type:document.getElementById("sc_type_"+id).value,players:document.getElementById("sc_players_"+id).value,kills:document.getElementById("sc_kills_"+id).value,adult:document.getElementById("sc_adult_"+id).value,text:document.getElementById("sc_text_"+id).value,mix_with_normal:document.getElementById("sc_mix_"+id).checked?"1":"0",active:document.getElementById("sc_active_"+id).checked?"1":"0"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);openScenarios.add(Number(id));loadScenarios();load()}
async function deleteScenario(id){if(!confirm("Excluir esta história e TODOS os eventos que estão dentro dela?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_scenario",id})});alert(t);openScenarios.delete(Number(id));loadScenarios();load()}
async function addScenarioEvent(id){const body={action:"add_scenario_event",scenario_id:id,phase:document.getElementById("new_sce_phase_"+id).value,type:document.getElementById("new_sce_type_"+id).value,players:document.getElementById("new_sce_players_"+id).value,kills:document.getElementById("new_sce_kills_"+id).value,adult:document.getElementById("new_sce_adult_"+id).value,text:document.getElementById("new_sce_text_"+id).value,active:"1"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);openScenarios.add(Number(id));loadScenarios();load()}
async function saveScenarioEvent(id,sid){const body={action:"update_scenario_event",id,phase:document.getElementById("sce_phase_"+id).value,type:document.getElementById("sce_type_"+id).value,players:document.getElementById("sce_players_"+id).value,kills:document.getElementById("sce_kills_"+id).value,adult:document.getElementById("sce_adult_"+id).value,text:document.getElementById("sce_text_"+id).value,active:document.getElementById("sce_active_"+id).checked?"1":"0"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);openScenarios.add(Number(sid));loadScenarios();load()}
async function deleteScenarioEvent(id,sid){if(!confirm("Excluir este evento decorrente?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_scenario_event",id})});alert(t);openScenarios.add(Number(sid));loadScenarios();load()}
load();if(admin){loadEvents();loadScenarios()}setInterval(load,2500);
</script></body></html>`;
}

app.get("/", (_req, res) => res.type("text/plain").send(`OK - Hunger Games da Live v${APP_VERSION}`));
app.get("/health", (_req, res) => res.json({ ok: true, version: APP_VERSION }));
app.get("/version", (_req, res) => res.json({ version: APP_VERSION }));
app.get("/hg", command);
app.post("/hg", command);
app.get("/hg/admin", adminAction);
app.post("/hg/admin", adminAction);
app.get("/hg/state", state);

app.get("/hg/events", async (req, res) => {
  try {
    if (!checkBase(req, res)) return;
    await ensureTables();
    const db = await getPool();
    const [rows] = await db.query("SELECT * FROM hg_events ORDER BY phase ASC, adult ASC, id ASC");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/hg/scenarios", async (req, res) => {
  try {
    if (!checkBase(req, res)) return;
    await ensureTables();
    const db = await getPool();
    const [scenarios] = await db.query("SELECT * FROM hg_scenarios ORDER BY active DESC, id DESC");
    const [children] = scenarios.length
      ? await db.query("SELECT * FROM hg_scenario_events ORDER BY scenario_id ASC, sort_order ASC, id ASC")
      : [[]];
    const byScenario = new Map();
    for (const child of children) {
      const list = byScenario.get(Number(child.scenario_id)) || [];
      list.push(child);
      byScenario.set(Number(child.scenario_id), list);
    }
    res.json(scenarios.map(row => ({ ...row, events: byScenario.get(Number(row.id)) || [] })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/hungergames", (_req, res) => res.type("html").send(page(false)));
app.get("/jogos/hunger", (_req, res) => res.type("html").send(page(false)));
app.get("/admin/hungergames", (_req, res) => res.type("html").send(page(true)));
app.get("/permissions", (req, res) => {
  if (!checkToken(req, res)) return;
  res.json({
    ok: true,
    allowedChannels: envList("ALLOWED_CHANNELS"),
    allowedUsers: envList("ALLOWED_USERS"),
    command: "$(customapi https://site-jogo-o9d1.onrender.com/hg?token=carolina-hg&channel=$(channel)&user=$(sender)&q=$(queryescape ${1:}))",
    publicPage: "https://site-jogo-o9d1.onrender.com/hungergames?channel=icarolinaporto",
    adminPage: "https://site-jogo-o9d1.onrender.com/admin/hungergames?channel=icarolinaporto&token=carolina-hg"
  });
});
app.listen(PORT, () => {
  console.log("HG Live separado rodando na porta " + PORT);
  const channels = new Set([
    nick(process.env.DEFAULT_CHANNEL || "icarolinaporto"),
    ...envList("ALLOWED_CHANNELS")
  ]);
  for (const channel of channels) if (channel) startChatTracker(channel);
});
