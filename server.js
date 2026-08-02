
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import tls from "node:tls";

const app = express();
const PORT = process.env.PORT || 10000;
const APP_VERSION = "14.0.0";
const DEFAULT_WINNER_PRIZE_TEXT = "🏆 {vencedor}, você ganhou! O seu prêmio é: {premio}";

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
const autoRunTokens = new Map();
const chatTrackers = new Map();
const channelQueues = new Map();
const avatarRefreshTimes = new Map();
const avatarLookupCache = new Map();

const DEFAULT_IGNORED_CHATTERS = new Set([
  "streamelements", "nightbot", "moobot", "streamlabs", "soundalerts",
  "sery_bot", "commanderroot", "wizebot", "fossabot"
]);

function getAutoIntervalMs(game = null) {
  const ms = Number(game?.event_delay_ms ?? process.env.HG_AUTO_INTERVAL_MS ?? 9000);
  return Math.max(1000, Math.min(60000, Number.isFinite(ms) ? ms : 9000));
}

function stopAuto(channel) {
  const key = nick(channel || "");
  const timer = autoTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  autoTimers.delete(key);
  autoRunTokens.delete(key);
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
  ["day","adult",2,"{p1} flerta tanto com {p2} que os patrocinadores ficam confusos se isso é guerra ou encontro.","",1]
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


const AUTOMATIC_STORY_PACKS = {
  vampiro: {
    title: "Vampiros",
    intro: "Uma lua de sangue cobre a arena. Um castelo surge ao redor de {p}, e uma voz anuncia que somente um sobrevivente verá o amanhecer.",
    calm: [
      "{p1} encontra marcas de presas nas paredes e percebe que alguma coisa está seguindo seus passos.",
      "{p1} atravessa uma galeria cheia de retratos cujos olhos parecem acompanhar cada movimento.",
      "{p1} encontra um frasco de água benta escondido dentro de um altar quebrado.",
      "{p1} ouve asas batendo sobre a torre e se esconde antes que a criatura desça.",
      "{p1} descobre uma passagem secreta que liga a biblioteca à cripta.",
      "{p1} percebe que o amanhecer está cada vez mais distante, como se a noite não tivesse fim."
    ],
    conflict: [
      "{p1} e {p2} atravessam juntos o salão dos espelhos, mas nenhum dos dois confia no reflexo do outro.",
      "{p1} impede {p2} de abrir um caixão selado, evitando que algo antigo desperte cedo demais.",
      "{p1} divide uma tocha com {p2} enquanto sombras famintas cercam o corredor.",
      "{p1} encontra {p2} perto da saída, mas os portões se fecham antes que consigam escapar."
    ],
    deaths: [
      "{p1} alcança a ponte levadiça, mas corta a corrente antes de {p2} atravessar. Vampiros cercam {p2}, que não sobrevive.",
      "{p1} usa o último raio de luz contra a criatura. {p2} fica preso na sombra e é levado para a cripta.",
      "{p1} encontra uma estaca escondida, mas {p2} é atacado antes que ela possa ser usada. {p2} morre no corredor.",
      "{p1} fecha a porta de ferro para conter o lorde vampiro. {p2} fica do lado errado e não consegue escapar.",
      "{p1} quebra o vitral e a luz invade o salão. {p2}, já transformado, é consumido pelo amanhecer.",
      "{p1} foge pela passagem secreta enquanto {p2} é arrastado para dentro de um caixão vazio."
    ],
    finales: [
      "No coração do castelo, {p1} enfrenta {p2} diante do trono de sangue. {p1} resiste à maldição, mas {p2} não sobrevive.",
      "O primeiro raio do amanhecer atravessa a torre. {p1} alcança a luz; {p2} é tomado pelas criaturas da noite.",
      "A última porta se abre. {p1} atravessa antes do sino final, enquanto {p2} é deixado para trás no castelo dos vampiros."
    ]
  },
  terror: {
    title: "Terror",
    intro: "As luzes da arena apagam. Quando voltam, {p} estão presos em um hospital abandonado, e uma mensagem avisa que o prédio escolherá apenas um sobrevivente.",
    calm: [
      "{p1} encontra uma lanterna quase sem bateria e decide economizar cada segundo de luz.",
      "{p1} escuta passos no andar de cima, embora a escada tenha desabado há anos.",
      "{p1} encontra fotografias antigas dos participantes tiradas antes mesmo de entrarem na arena.",
      "{p1} abre uma sala vazia e encontra o próprio nome escrito na parede.",
      "{p1} percebe que todos os relógios do prédio estão parados exatamente no mesmo minuto.",
      "{p1} encontra uma chave enferrujada presa dentro de uma caixa de música."
    ],
    conflict: [
      "{p1} e {p2} tentam religar o gerador enquanto alguma coisa bate do outro lado da porta.",
      "{p1} acredita ter encontrado a saída, mas {p2} percebe que o corredor leva de volta ao mesmo lugar.",
      "{p1} e {p2} se escondem no necrotério e precisam ficar em silêncio absoluto.",
      "{p1} segura a porta enquanto {p2} procura uma passagem entre as paredes."
    ],
    deaths: [
      "{p1} consegue entrar no elevador, mas as portas se fecham antes de {p2}. A criatura encontra {p2} no corredor.",
      "{p1} percebe a armadilha a tempo. {p2} pisa no lugar errado e desaparece sob o piso do hospital.",
      "{p1} apaga a lanterna e permanece imóvel. {p2} corre, chama atenção da entidade e não sobrevive.",
      "{p1} atravessa a porta marcada como saída. Ela se fecha atrás de si, deixando {p2} preso com o assassino.",
      "{p1} encontra a chave correta. {p2} tenta outra porta e é puxado para dentro da escuridão.",
      "{p1} escapa pelo duto de ventilação. {p2} fica para trás quando mãos surgem das paredes."
    ],
    finales: [
      "A sirene final toca. {p1} descobre a verdadeira saída, enquanto {p2} é alcançado pela entidade que controlava o prédio.",
      "Na última sala, {p1} enfrenta o medo e quebra o ciclo. {p2} hesita por um instante e não sobrevive.",
      "O hospital começa a desabar. {p1} atravessa o portão; {p2} fica preso dentro do pesadelo."
    ]
  },
  apocalipse: {
    title: "Apocalipse",
    intro: "Sirenas ecoam por toda a arena. As cidades caíram, a comunicação parou e {p} recebem a última mensagem: existe lugar para apenas um no abrigo final.",
    calm: [
      "{p1} vasculha um mercado destruído e encontra água suficiente para continuar.",
      "{p1} sobe em um prédio abandonado para procurar sinais de sobreviventes.",
      "{p1} encontra um rádio funcionando, mas a transmissão repete apenas coordenadas incompletas.",
      "{p1} atravessa uma avenida tomada por carros vazios e alarmes disparados.",
      "{p1} improvisa uma máscara para passar por uma área contaminada.",
      "{p1} encontra o mapa de um abrigo subterrâneo escondido em uma estação."
    ],
    conflict: [
      "{p1} e {p2} dividem combustível para atravessar uma região tomada por infectados.",
      "{p1} protege {p2} durante uma tempestade tóxica, mas os suprimentos ficam quase no fim.",
      "{p1} e {p2} encontram um comboio abandonado e discutem qual rota ainda pode estar segura.",
      "{p1} ajuda {p2} a cruzar uma ponte instável antes que a horda se aproxime."
    ],
    deaths: [
      "{p1} consegue ligar o veículo e parte. {p2} é cercado pelos infectados antes de alcançar a porta.",
      "{p1} fecha a comporta para impedir a contaminação. {p2} fica do lado de fora e não sobrevive.",
      "{p1} encontra um filtro ainda utilizável. O equipamento de {p2} falha dentro da nuvem tóxica.",
      "{p1} atravessa a ponte antes que ela desabe. {p2} cai junto com a estrutura.",
      "{p1} percebe a emboscada e muda de rota. {p2} segue em frente e é alcançado pela horda.",
      "{p1} entra no trem de evacuação. As portas se fecham e {p2} fica preso na plataforma destruída."
    ],
    finales: [
      "O abrigo final inicia o fechamento. {p1} entra com o último código válido; {p2} não consegue atravessar a comporta.",
      "A última aeronave de resgate pousa por poucos segundos. {p1} embarca, enquanto {p2} é alcançado pela onda de destruição.",
      "O sinal de evacuação termina. {p1} alcança a zona segura, mas {p2} fica para trás no fim do mundo."
    ]
  },
  zumbi: {
    title: "Zumbis",
    intro: "Uma infecção toma a arena em minutos. {p} correm para um centro de evacuação enquanto uma horda cresce a cada rua atravessada.",
    calm: [
      "{p1} encontra remédios dentro de uma farmácia saqueada.",
      "{p1} bloqueia uma porta com móveis antes que a horda chegue.",
      "{p1} encontra munição, mas decide guardar para o pior momento.",
      "{p1} escuta um pedido de socorro vindo de um rádio quebrado.",
      "{p1} atravessa uma escola abandonada sem fazer barulho.",
      "{p1} encontra uma rota marcada até o ponto de evacuação."
    ],
    conflict: [
      "{p1} e {p2} empurram um carro para bloquear a rua.",
      "{p1} ajuda {p2} a passar por uma janela antes que os infectados entrem.",
      "{p1} e {p2} dividem os últimos suprimentos dentro de uma loja fechada.",
      "{p1} cobre a fuga de {p2} enquanto a horda se aproxima."
    ],
    deaths: [
      "{p1} atravessa o portão e o tranca. {p2} é cercado pela horda e não sobrevive.",
      "{p1} percebe que o corredor está tomado e recua. {p2} continua e é atacado pelos infectados.",
      "{p1} sobe no caminhão de fuga. {p2} perde o equilíbrio e cai no meio da horda.",
      "{p1} usa o último sinalizador para abrir caminho. {p2} fica preso no prédio e não consegue sair.",
      "{p1} alcança o telhado. A escada cede sob {p2}, que é alcançado pelos zumbis.",
      "{p1} fecha a porta do abrigo. {p2}, já ferido, fica do lado de fora."
    ],
    finales: [
      "O helicóptero chega ao último ponto de resgate. {p1} embarca; {p2} é alcançado pela horda.",
      "A evacuação termina. {p1} atravessa o portão final, enquanto {p2} não consegue escapar dos infectados.",
      "A última vaga do abrigo é ocupada por {p1}. {p2} fica do lado de fora quando a cidade é tomada."
    ]
  }
};

function normalizeStoryCategory(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function storyCategoryKey(category) {
  const key = normalizeStoryCategory(category);
  if (/vampir/.test(key)) return "vampiro";
  if (/terror|horror|assombr|fantasma/.test(key)) return "terror";
  if (/zumbi|zombie|infectad/.test(key)) return "zumbi";
  if (/apocalip|fim do mundo|nuclear|catastrof/.test(key)) return "apocalipse";
  return "generic";
}

function storyTitle(category) {
  return String(category || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map(word => word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : "")
    .join(" ");
}

function splitStoryCategories(value) {
  const raw = String(value || "")
    .replace(/[\r\n]+/g, " + ")
    .trim();

  const parts = raw
    .split(/\s*(?:\+|,|;|\||\/|\s+e\s+)\s*/i)
    .map(item => item.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  const seen = new Set();
  const categories = [];
  for (const part of parts) {
    const key = storyCategoryKey(part);
    const dedupeKey = key === "generic" ? `generic:${normalizeStoryCategory(part)}` : `pack:${key}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      categories.push(part);
    }
    if (categories.length >= 10) break;
  }

  if (!categories.length && normalizeStoryCategory(raw)) categories.push(raw);
  return categories;
}

function joinStoryTitles(titles) {
  const clean = titles.filter(Boolean);
  if (clean.length <= 1) return clean[0] || "";
  if (clean.length === 2) return `${clean[0]} e ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} e ${clean[clean.length - 1]}`;
}

function storyPackFromCategory(category) {
  const key = storyCategoryKey(category);
  return {
    key,
    input: category,
    pack: key === "generic" ? genericStoryPack(category) : AUTOMATIC_STORY_PACKS[key]
  };
}

function genericStoryPack(category) {
  const label = storyTitle(category);
  return {
    title: label,
    intro: `A arena é transformada por uma ameaça ligada a “${label}”. {p} descobrem que a história só terminará quando restar um sobrevivente.`,
    calm: [
      `{p1} encontra uma pista sobre “${label}” e percebe que a ameaça está mais perto do que parecia.`,
      `{p1} atravessa uma área destruída tentando entender as regras desta história de ${label}.`,
      `{p1} encontra um objeto que pode ser útil contra a ameaça de ${label}.`,
      `{p1} escuta um aviso misterioso e muda de caminho antes que seja tarde.`,
      `{p1} descobre uma passagem escondida que pode levar ao centro da história.`,
      `{p1} percebe que o cenário está mudando e que não existe mais um lugar realmente seguro.`
    ],
    conflict: [
      `{p1} e {p2} seguem juntos uma pista sobre ${label}, mas a confiança entre eles começa a desaparecer.`,
      `{p1} ajuda {p2} a escapar de uma armadilha ligada à ameaça de ${label}.`,
      `{p1} e {p2} encontram uma rota segura, mas ela só ficará aberta por poucos segundos.`,
      `{p1} e {p2} chegam ao mesmo esconderijo enquanto a ameaça se aproxima.`
    ],
    deaths: [
      `{p1} percebe a armadilha de ${label} a tempo. {p2} continua avançando e não sobrevive.`,
      `{p1} consegue atravessar a passagem antes que ela se feche. {p2} fica preso com a ameaça de ${label}.`,
      `{p1} encontra proteção, mas {p2} é alcançado pelo perigo que domina esta história.`,
      `{p1} muda de rota no último instante. {p2} segue pelo caminho errado e morre.`,
      `{p1} escapa do ataque relacionado a ${label}. {p2} fica para trás e não sobrevive.`,
      `{p1} usa a última chance de fuga. A passagem se fecha e {p2} é eliminado pela ameaça.`
    ],
    finales: [
      `No capítulo final de ${label}, {p1} encontra a saída. {p2} é alcançado pela ameaça e não sobrevive.`,
      `A arena começa a desabar. {p1} vence o último desafio de ${label}, enquanto {p2} fica para trás.`,
      `A história de ${label} chega ao confronto final. {p1} resiste, mas {p2} é eliminado.`
    ]
  };
}

function buildAutomaticStory(categoryInput, aliveCountRaw = 0) {
  const categoryInputs = splitStoryCategories(categoryInput);
  const categoryPacks = categoryInputs.map(storyPackFromCategory);
  const packs = categoryPacks.map(item => item.pack);
  const titles = packs.map(pack => pack.title);
  const categoryLabel = joinStoryTitles(titles);
  const isMixed = packs.length > 1;

  const aliveCount = Math.max(0, Math.round(Number(aliveCountRaw || 0)));
  const expectedPlayers = aliveCount > 1 ? aliveCount : 24;
  const deathCount = Math.max(1, Math.min(120, expectedPlayers - 1));
  const events = [];
  let step = 1;

  const add = (type, players, text, kills = "") => {
    events.push({
      phase: "any",
      type,
      players,
      text: `Capítulo ${step++} — ${text}`,
      kills,
      adult: 0,
      active: 1
    });
  };

  const packAt = index => packs[index % packs.length];
  const mixedPrefix = (primary, secondary) => {
    if (!isMixed || !secondary || secondary === primary) return "";
    return `Ao mesmo tempo, a ameaça de ${secondary.title} invade o cenário. `;
  };

  const intro = isMixed
    ? `A arena se transforma em uma única história que mistura ${categoryLabel}. {p} descobrem que todos esses perigos estão ligados e que a história só terminará quando restar um sobrevivente.`
    : packs[0].intro;

  // Cada categoria ganha espaço logo no começo para a mistura ficar visível.
  packs.forEach((pack, index) => {
    add(
      index % 3 === 0 ? "neutral" : index % 3 === 1 ? "item" : "alliance",
      index % 3 === 2 ? 2 : 1,
      pack.calm[index % pack.calm.length]
    );
  });

  if (isMixed) {
    const first = packAt(0);
    const second = packAt(1);
    add(
      "alliance",
      2,
      `Os perigos de ${first.title} e ${second.title} se encontram no mesmo lugar. ${first.conflict[0]}`
    );
  } else {
    add("alliance", 2, packs[0].conflict[0]);
    add("item", 1, packs[0].calm[1]);
  }

  for (let i = 0; i < deathCount; i += 1) {
    const progress = deathCount <= 1 ? 1 : i / (deathCount - 1);
    const primary = packAt(i);
    const secondary = isMixed ? packAt(i + 1) : null;

    if (i > 0 && i % 2 === 0) {
      const calmPack = packAt(i + 1);
      const calm = calmPack.calm[(Math.floor(i / 2) + 1) % calmPack.calm.length];
      const calmPrefix = isMixed
        ? `Enquanto a história alterna para ${calmPack.title}, `
        : "";
      add(i % 4 === 0 ? "item" : "neutral", 1, calmPrefix + calm);
    }

    if (i > 0 && i % 5 === 0) {
      const conflictPack = packAt(i + 2);
      const conflict = conflictPack.conflict[(Math.floor(i / 5) + 1) % conflictPack.conflict.length];
      const conflictPrefix = isMixed
        ? `As ameaças de ${primary.title} e ${conflictPack.title} se cruzam. `
        : "";
      add("alliance", 2, conflictPrefix + conflict);
    }

    const source = progress >= 0.85 ? primary.finales : primary.deaths;
    const deathText = source[i % source.length];
    const prefix = progress >= 0.85 && isMixed
      ? `No confronto final entre ${primary.title} e ${secondary.title}, `
      : mixedPrefix(primary, secondary);
    add("death", 2, prefix + deathText, "p2");
  }

  return {
    name: `História automática: ${titles.join(" + ")}`,
    intro,
    events,
    deathCount,
    categoryCount: packs.length,
    categories: titles,
    mixed: isMixed
  };
}

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
          normal_events_enabled TINYINT(1) NOT NULL DEFAULT 1,
          narration_enabled TINYINT(1) NOT NULL DEFAULT 0,
          narration_voice VARCHAR(160) NOT NULL DEFAULT 'disabled',
          narration_rate DECIMAL(4,2) NOT NULL DEFAULT 1.00,
          event_delay_ms INT NOT NULL DEFAULT 9000,
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
          participant_ids TEXT NULL,
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
          kills TEXT NULL,
          adult TINYINT(1) NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_event_phase (phase, active, adult)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Migração segura: mantém todos os eventos e partidas já existentes.
      // A coluna só é criada na primeira execução desta versão.
      try {
        await db.query("ALTER TABLE hg_logs ADD COLUMN participant_ids TEXT NULL AFTER deaths");
      } catch (e) {
        if (e?.code !== "ER_DUP_FIELDNAME") throw e;
      }
      try {
        await db.query("ALTER TABLE hg_games ADD COLUMN active_scenario_id INT NULL AFTER adult_mode");
      } catch (e) {
        if (e?.code !== "ER_DUP_FIELDNAME") throw e;
      }
      try {
        await db.query("ALTER TABLE hg_games ADD COLUMN normal_events_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER adult_mode");
      } catch (e) {
        if (e?.code !== "ER_DUP_FIELDNAME") throw e;
      }
      for (const migration of [
        "ALTER TABLE hg_games ADD COLUMN narration_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER normal_events_enabled",
        "ALTER TABLE hg_games ADD COLUMN narration_voice VARCHAR(160) NOT NULL DEFAULT 'disabled' AFTER narration_enabled",
        "ALTER TABLE hg_games ADD COLUMN narration_rate DECIMAL(4,2) NOT NULL DEFAULT 1.00 AFTER narration_voice",
        "ALTER TABLE hg_games ADD COLUMN event_delay_ms INT NOT NULL DEFAULT 9000 AFTER narration_rate"
      ]) {
        try {
          await db.query(migration);
        } catch (e) {
          if (e?.code !== "ER_DUP_FIELDNAME") throw e;
        }
      }
      // A narração foi removida desta versão, inclusive para partidas antigas.
      await db.query("UPDATE hg_games SET narration_enabled=0,narration_voice='disabled',narration_rate=1.00 WHERE narration_enabled<>0 OR narration_voice<>'disabled'");

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_scenarios (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          phase VARCHAR(30) NOT NULL DEFAULT 'arena',
          type VARCHAR(30) NOT NULL DEFAULT 'neutral',
          players INT NOT NULL DEFAULT 1,
          text TEXT NOT NULL,
          kills TEXT NULL,
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
          kills TEXT NULL,
          adult TINYINT(1) NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_scenario_event (scenario_id, active, phase, adult)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_trophies (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(160) NOT NULL,
          image_data LONGTEXT NOT NULL,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_trophy_active (active, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_prize_settings (
          channel VARCHAR(80) NOT NULL PRIMARY KEY,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          text_template TEXT NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      for (const migration of [
        "ALTER TABLE hg_games ADD COLUMN winner_trophy_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER event_delay_ms",
        "ALTER TABLE hg_games ADD COLUMN winner_trophy_text TEXT NULL AFTER winner_trophy_enabled",
        "ALTER TABLE hg_games ADD COLUMN winner_trophy_id INT NULL AFTER winner_trophy_text",
        "ALTER TABLE hg_games ADD COLUMN winner_trophy_title VARCHAR(160) NULL AFTER winner_trophy_id",
        "ALTER TABLE hg_games ADD COLUMN winner_trophy_image LONGTEXT NULL AFTER winner_trophy_title"
      ]) {
        try {
          await db.query(migration);
        } catch (e) {
          if (e?.code !== "ER_DUP_FIELDNAME") throw e;
        }
      }

      await db.query("UPDATE hg_games SET winner_trophy_text=COALESCE(NULLIF(winner_trophy_text,''), ?) WHERE winner_trophy_text IS NULL OR winner_trophy_text=''", [DEFAULT_WINNER_PRIZE_TEXT]);
      await db.query("UPDATE hg_games SET winner_trophy_text=REPLACE(winner_trophy_text,'{winner}','{vencedor}') WHERE winner_trophy_text LIKE '%{winner}%'");
      await db.query("UPDATE hg_prize_settings SET text_template=REPLACE(text_template,'{winner}','{vencedor}') WHERE text_template LIKE '%{winner}%'");

      // Migração segura para permitir listas grandes, como p1,p2,...,p25.
      // MODIFY preserva todo o conteúdo já cadastrado.
      await db.query("ALTER TABLE hg_events MODIFY COLUMN kills TEXT NULL");
      await db.query("ALTER TABLE hg_scenarios MODIFY COLUMN kills TEXT NULL");
      await db.query("ALTER TABLE hg_scenario_events MODIFY COLUMN kills TEXT NULL");

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

      await db.query(`
        CREATE TABLE IF NOT EXISTS hg_phase_usage (
          game_id INT NOT NULL,
          phase VARCHAR(30) NOT NULL,
          day_number INT NOT NULL,
          player_id INT NOT NULL,
          used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (game_id, phase, day_number, player_id),
          INDEX idx_phase_usage (game_id, phase, day_number)
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return (url.protocol === "https:" || url.protocol === "http:") ? url.href : "";
  } catch {
    return "";
  }
}

async function getTwitchAppToken() {
  if (twitchTokenCache.token && twitchTokenCache.expiresAt > Date.now() + 60000) return twitchTokenCache.token;
  const clientId = String(process.env.TWITCH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.TWITCH_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });

  try {
    const r = await fetchWithTimeout("https://id.twitch.tv/oauth2/token", { method: "POST", body }, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    const token = String(j?.access_token || "").trim();
    if (!token) return null;
    twitchTokenCache = {
      token,
      expiresAt: Date.now() + Math.max(60, Number(j.expires_in || 3600) - 60) * 1000
    };
    return twitchTokenCache.token;
  } catch (error) {
    console.error("Token da Twitch indisponível:", error.message);
    return null;
  }
}

async function getAvatarFromHelix(username) {
  const login = nick(username);
  const clientId = String(process.env.TWITCH_CLIENT_ID || "").trim();
  const token = await getTwitchAppToken();
  if (!clientId || !token || !login) return "";
  try {
    const r = await fetchWithTimeout(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
      headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` }
    }, 8000);
    if (!r.ok) return "";
    const j = await r.json();
    return validHttpUrl(j?.data?.[0]?.profile_image_url);
  } catch {
    return "";
  }
}

async function getAvatarFromIvr(username) {
  const login = nick(username);
  if (!login) return "";
  const base = String(process.env.TWITCH_IVR_API_BASE || "https://api.ivr.fi/v2/twitch/user").trim();
  try {
    const separator = base.includes("?") ? "&" : "?";
    const r = await fetchWithTimeout(`${base}${separator}login=${encodeURIComponent(login)}`, {
      headers: { "User-Agent": "HG-Live/9.0" }
    }, 7000);
    if (!r.ok) return "";
    const j = await r.json();
    const item = Array.isArray(j) ? j[0] : (Array.isArray(j?.data) ? j.data[0] : j);
    return validHttpUrl(item?.logo || item?.profileImageUrl || item?.profile_image_url || item?.avatar);
  } catch {
    return "";
  }
}

async function getAvatarFromDecapi(username) {
  const login = nick(username);
  if (!login) return "";
  const base = String(process.env.TWITCH_DECAPI_BASE || "https://decapi.me/twitch/avatar").replace(/\/+$/, "");
  try {
    const r = await fetchWithTimeout(`${base}/${encodeURIComponent(login)}`, {
      headers: { "User-Agent": "HG-Live/9.0" }
    }, 7000);
    if (!r.ok) return "";
    return validHttpUrl(await r.text());
  } catch {
    return "";
  }
}

async function resolveTwitchAvatar(username, force = false) {
  const login = nick(username);
  if (!login) return "";
  const cached = avatarLookupCache.get(login);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.url;

  let url = await getAvatarFromHelix(login);
  if (!url) url = await getAvatarFromIvr(login);
  if (!url) url = await getAvatarFromDecapi(login);

  avatarLookupCache.set(login, {
    url,
    expiresAt: Date.now() + (url ? 12 * 60 * 60 * 1000 : 2 * 60 * 1000)
  });
  return url;
}

async function getTwitchAvatar(username) {
  return resolveTwitchAvatar(username, false);
}

async function getTwitchProfiles(usernames) {
  const logins = [...new Set((usernames || []).map(nick).filter(Boolean))];
  const result = new Map();
  if (!logins.length) return result;

  const clientId = String(process.env.TWITCH_CLIENT_ID || "").trim();
  const token = await getTwitchAppToken();
  if (clientId && token) {
    try {
      for (let i = 0; i < logins.length; i += 100) {
        const params = new URLSearchParams();
        for (const login of logins.slice(i, i + 100)) params.append("login", login);
        const r = await fetchWithTimeout(`https://api.twitch.tv/helix/users?${params}`, {
          headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` }
        }, 9000);
        if (!r.ok) continue;
        const j = await r.json();
        for (const u of j?.data || []) {
          const username = nick(u.login);
          const avatarUrl = validHttpUrl(u.profile_image_url);
          result.set(username, {
            username,
            display_name: u.display_name || u.login,
            avatar_url: avatarUrl
          });
          if (avatarUrl) avatarLookupCache.set(username, { url: avatarUrl, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
        }
      }
    } catch (e) {
      console.error("Busca oficial de perfis da Twitch falhou:", e.message);
    }
  }

  const missing = logins.filter(login => !result.get(login)?.avatar_url);
  for (let i = 0; i < missing.length; i += 6) {
    const batch = missing.slice(i, i + 6);
    const rows = await Promise.all(batch.map(async login => ({ login, avatar: await resolveTwitchAvatar(login, false) })));
    for (const row of rows) {
      const previous = result.get(row.login);
      result.set(row.login, {
        username: row.login,
        display_name: previous?.display_name || row.login,
        avatar_url: row.avatar || previous?.avatar_url || ""
      });
    }
  }
  return result;
}

async function refreshMissingPlayerAvatars(gameId, force = false) {
  const id = Number(gameId || 0);
  if (!id) return 0;
  const db = await getPool();
  const [players] = force
    ? await db.query("SELECT id,username FROM hg_players WHERE game_id=?", [id])
    : await db.query("SELECT id,username FROM hg_players WHERE game_id=? AND (avatar_url IS NULL OR avatar_url='')", [id]);
  if (!players.length) return 0;

  if (force) {
    for (const player of players) avatarLookupCache.delete(nick(player.username));
  }
  const profiles = await getTwitchProfiles(players.map(player => player.username));
  let updated = 0;
  for (const player of players) {
    const avatar = String(profiles.get(nick(player.username))?.avatar_url || "").trim();
    if (!avatar) continue;
    const [result] = force
      ? await db.query("UPDATE hg_players SET avatar_url=? WHERE id=? AND game_id=?", [avatar, player.id, id])
      : await db.query("UPDATE hg_players SET avatar_url=? WHERE id=? AND game_id=? AND (avatar_url IS NULL OR avatar_url='')", [avatar, player.id, id]);
    updated += Number(result.affectedRows || 0);
  }
  return updated;
}

async function refreshMissingPlayerAvatarsThrottled(gameId, intervalMs = 300000) {
  const id = Number(gameId || 0);
  if (!id) return 0;
  const last = Number(avatarRefreshTimes.get(id) || 0);
  if (Date.now() - last < intervalMs) return 0;
  avatarRefreshTimes.set(id, Date.now());
  try {
    return await refreshMissingPlayerAvatars(id, false);
  } catch (error) {
    console.error("Erro ao atualizar fotos dos participantes:", error.message);
    return 0;
  }
}

async function avatarRoute(req, res) {
  const login = nick(req.params.username || req.query.login || "");
  if (!login) return res.status(404).end();
  try {
    const avatar = await resolveTwitchAvatar(login, false);
    const fallbackBase = String(process.env.TWITCH_UNAVATAR_BASE || "https://unavatar.io/twitch").replace(/\/+$/, "");
    const destination = avatar || `${fallbackBase}/${encodeURIComponent(login)}?fallback=false`;
    res.set("Cache-Control", avatar ? "public, max-age=43200, stale-while-revalidate=86400" : "public, max-age=120");
    return res.redirect(302, destination);
  } catch (error) {
    console.error(`Avatar da Twitch (${login}):`, error.message);
    return res.status(404).end();
  }
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

async function getWinnerPrizeSettings(db, channel) {
  const ch = nick(channel);
  await db.query(
    "INSERT IGNORE INTO hg_prize_settings (channel,enabled,text_template) VALUES (?,1,?)",
    [ch, DEFAULT_WINNER_PRIZE_TEXT]
  );
  const [rows] = await db.query(
    "SELECT enabled,text_template FROM hg_prize_settings WHERE channel=? LIMIT 1",
    [ch]
  );
  const row = rows[0] || {};
  return {
    enabled: Number(row.enabled ?? 1) === 1,
    text: String(row.text_template || DEFAULT_WINNER_PRIZE_TEXT)
  };
}

async function saveWinnerPrizeSettings(db, channel, enabled, text) {
  const ch = nick(channel);
  const safeText = String(text || DEFAULT_WINNER_PRIZE_TEXT)
    .replace(/\{winner\}/gi, "{vencedor}")
    .trim()
    .slice(0, 1000) || DEFAULT_WINNER_PRIZE_TEXT;
  await db.query(
    `INSERT INTO hg_prize_settings (channel,enabled,text_template)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),text_template=VALUES(text_template)`,
    [ch, enabled ? 1 : 0, safeText]
  );
  return { enabled: Boolean(enabled), text: safeText };
}

async function currentGame(channel, create = true) {
  await ensureTables();
  const db = await getPool();
  const [rows] = await db.query("SELECT * FROM hg_games WHERE channel=? AND status IN ('lobby','running','ended') ORDER BY id DESC LIMIT 1", [channel]);
  if (rows.length) return rows[0];
  if (!create) return null;
  const prizeSettings = await getWinnerPrizeSettings(db, channel);
  const [r] = await db.query("INSERT INTO hg_games (channel,status,phase,day_number,adult_mode,normal_events_enabled,winner_trophy_enabled,winner_trophy_text) VALUES (?, 'lobby', 'bloodbath', 1, ?, ?, ?, ?)", [channel, process.env.HG_ADULT_DEFAULT === "1" ? 1 : 0, process.env.HG_NORMAL_EVENTS_DEFAULT === "0" ? 0 : 1, prizeSettings.enabled ? 1 : 0, prizeSettings.text]);
  const [created] = await db.query("SELECT * FROM hg_games WHERE id=?", [r.insertId]);
  return created[0];
}

async function newLobby(channel, adult = 0, normalEventsEnabled = 1, eventDelayMsRaw = 9000) {
  await ensureTables();
  const db = await getPool();
  await db.query("UPDATE hg_games SET status='archived' WHERE channel=? AND status IN ('lobby','running','ended')", [channel]);
  const eventDelayMs = Math.max(1000, Math.min(60000, Number(eventDelayMsRaw || 9000)));
  const globalPrizeSettings = await getWinnerPrizeSettings(db, channel);
  const winnerPrizeEnabled = globalPrizeSettings.enabled ? 1 : 0;
  const winnerPrizeText = globalPrizeSettings.text;
  const [r] = await db.query(
    "INSERT INTO hg_games (channel,status,phase,day_number,adult_mode,normal_events_enabled,narration_enabled,narration_voice,narration_rate,event_delay_ms,winner_trophy_enabled,winner_trophy_text) VALUES (?, 'lobby', 'bloodbath', 1, ?, ?, 0, 'disabled', 1.00, ?, ?, ?)",
    [channel, adult ? 1 : 0, normalEventsEnabled ? 1 : 0, eventDelayMs, winnerPrizeEnabled, winnerPrizeText]
  );
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
    await refreshMissingPlayerAvatars(game.id);

    return `✅ ${selected.length} participante(s) do chat adicionado(s). Total: ${existing.length + selected.length}.`;
  });
}

async function start(channel) {
  const result = await withChannelLock(channel, async () => {
    const game = await currentGame(channel, true);
    if (game.status === "running") return "A partida já está rodando.";
    if (game.status === "ended") return "A partida já terminou. Use Resetar antes de iniciar outra.";
    if (game.status !== "lobby") return "Esta arena não está disponível para iniciar.";
    const db = await getPool();
    await refreshMissingPlayerAvatars(game.id);
    const [players] = await db.query("SELECT * FROM hg_players WHERE game_id=?", [game.id]);
    if (players.length < 2) return "Precisa de pelo menos 2 participantes.";
    await db.query("UPDATE hg_players SET kills=0 WHERE game_id=?", [game.id]);
    await db.query("DELETE FROM hg_scenario_usage WHERE game_id=?", [game.id]);
    await db.query("DELETE FROM hg_game_scenario_runs WHERE game_id=?", [game.id]);
    await db.query("UPDATE hg_games SET status='running',phase='bloodbath',day_number=1,winner=NULL,active_scenario_id=NULL,winner_trophy_id=NULL,winner_trophy_title=NULL,winner_trophy_image=NULL,narration_enabled=0 WHERE id=? AND status='lobby'", [game.id]);
    await db.query(
      "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths,participant_ids) VALUES (?,?,'reaping',0,?,'',?)",
      [game.id, channel, `🎲 A arena começou com ${players.length} participantes.`, players.map(player => Number(player.id)).join(",")]
    );
    return `🔥 Partida iniciada com ${players.length} participantes.`;
  });
  if (!String(result).startsWith("🔥")) return result;
  const automatic = await startAuto(channel);
  return `${result}
${automatic}`;
}

async function reset(channel) {
  stopAuto(channel);
  return withChannelLock(channel, async () => {
    const old = await currentGame(channel, false);
    await newLobby(
      channel,
      old?.adult_mode || (process.env.HG_ADULT_DEFAULT === "1" ? 1 : 0),
      Number(old?.normal_events_enabled ?? 1),
      Number(old?.event_delay_ms || 9000)
    );
    return "✅ Arena resetada. Use !hg entrar ou !hg todos.";
  });
}

async function adult(channel, on) {
  const game = await currentGame(channel, true);
  const db = await getPool();
  await db.query("UPDATE hg_games SET adult_mode=? WHERE id=?", [on ? 1 : 0, game.id]);
  return on ? "🔞 Modo +18 ligado." : "✅ Modo +18 desligado.";
}

async function setNormalEvents(channel, on) {
  return withChannelLock(channel, async () => {
    const game = await currentGame(channel, true);
    const db = await getPool();
    await db.query("UPDATE hg_games SET normal_events_enabled=? WHERE id=?", [on ? 1 : 0, game.id]);
    return on
      ? "✅ Eventos normais/antigos ativados novamente."
      : "⛔ Eventos normais/antigos desativados. O automático usará somente o Modo História.";
  });
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

async function assignWinnerPrize(conn, gameId, winner) {
  const [games] = await conn.query("SELECT channel FROM hg_games WHERE id=? LIMIT 1 FOR UPDATE", [gameId]);
  const game = games[0] || {};
  const settings = await getWinnerPrizeSettings(conn, game.channel || "");
  const enabled = settings.enabled;
  let trophyId = null, trophyTitle = null, trophyImage = null;
  if (enabled) {
    const [trophies] = await conn.query("SELECT id,title,image_data FROM hg_trophies WHERE active=1 ORDER BY RAND() LIMIT 1");
    const chosen = trophies[0];
    if (chosen) {
      trophyId = Number(chosen.id || 0) || null;
      trophyTitle = String(chosen.title || "").slice(0, 160) || null;
      trophyImage = String(chosen.image_data || "") || null;
    }
  }
  await conn.query(
    "UPDATE hg_games SET status='ended',winner=?,active_scenario_id=NULL,winner_trophy_id=?,winner_trophy_title=?,winner_trophy_image=? WHERE id=?",
    [winner || null, trophyId, trophyTitle, trophyImage, gameId]
  );
  return { enabled, trophyId, trophyTitle, trophyImage, text: settings.text };
}

// Garante que partidas encerradas antes desta correção também recebam um prêmio.
// A seleção é persistida uma única vez; novas atualizações da página não sorteiam de novo.
async function ensureWinnerPrizeForEndedGame(conn, game, channel, settings) {
  if (!game || game.status !== "ended" || !game.winner || !settings?.enabled) return;
  if (game.winner_trophy_id && game.winner_trophy_image) return;

  const [trophies] = await conn.query(
    "SELECT id,title,image_data FROM hg_trophies WHERE active=1 ORDER BY RAND() LIMIT 1"
  );
  const chosen = trophies[0];
  if (!chosen) return;

  const trophyId = Number(chosen.id || 0) || null;
  const trophyTitle = String(chosen.title || "").slice(0, 160) || null;
  const trophyImage = String(chosen.image_data || "") || null;
  await conn.query(
    "UPDATE hg_games SET winner_trophy_id=?,winner_trophy_title=?,winner_trophy_image=? WHERE id=? AND winner IS NOT NULL",
    [trophyId, trophyTitle, trophyImage, game.id]
  );
  game.winner_trophy_id = trophyId;
  game.winner_trophy_title = trophyTitle;
  game.winner_trophy_image = trophyImage;
}

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
  if (!Number.isFinite(n) || n < 1) return 1;
  // Sem limite fixo: aceita qualquer quantidade inteira positiva que o usuário digitar.
  return Math.max(1, Math.round(n));
}
function eventUsesAllPlayers(event) {
  return Number(event?.players) === 0;
}
function eventParticipantCount(event, aliveCount) {
  return eventUsesAllPlayers(event)
    ? Math.max(0, Number(aliveCount || 0))
    : Math.max(1, Math.round(Number(event?.players || 1)));
}
function killIndexes(kills) {
  return String(kills || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).map(s => {
    const m = s.match(/^p([1-9]\d*)$/);
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
    return "Eventos para Todos não podem usar Mortes. Para matar alguém, digite uma quantidade de participantes e informe p1, p2, p10 etc.";
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
  // A conclusão é salva no estado da história, mas não cria um segundo cartão
  // público. Assim, cada clique/comando produz no máximo um evento visível.
  await conn.query(
    "UPDATE hg_games SET active_scenario_id=NULL WHERE id=? AND active_scenario_id=?",
    [gameId, scenarioId]
  );
  await conn.query(
    "UPDATE hg_game_scenario_runs SET completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP) WHERE game_id=? AND scenario_id=?",
    [gameId, scenarioId]
  );
}

// Executa exatamente um trecho de uma história exclusiva por rodada.
// Enquanto existir uma história com "Misturar com eventos normais" desligado,
// nenhum evento normal é sorteado. A introdução inicia primeiro e os eventos
// internos seguem a ordem cadastrada, sem depender da fase Dia/Noite.
async function runExclusiveStoryBeat(conn, game, alive, channel, adultAllowed, forceStoryOnly = false) {
  const day = Number(game.day_number || 1);
  let scenario = null;
  let isIntroduction = false;

  const activeScenarioId = Number(game.active_scenario_id || 0);
  if (activeScenarioId) {
    const [rows] = await conn.query(
      `SELECT * FROM hg_scenarios
       WHERE id=? AND active=1 ${forceStoryOnly ? "" : "AND mix_with_normal=0"}
       LIMIT 1`,
      [activeScenarioId]
    );
    scenario = rows[0] || null;

    // No modo forçado, um ID antigo/inativo não pode bloquear outra história.
    if (!scenario && forceStoryOnly) {
      await conn.query("UPDATE hg_games SET active_scenario_id=NULL WHERE id=?", [game.id]);
    } else if (!scenario) {
      return { handled: false };
    }
  }

  if (!scenario) {
    const [rows] = await conn.query(
      `SELECT s.*
       FROM hg_scenarios s
       LEFT JOIN hg_game_scenario_runs r
         ON r.game_id=? AND r.scenario_id=s.id
       WHERE s.active=1
         ${forceStoryOnly ? "" : "AND s.mix_with_normal=0"}
         AND r.scenario_id IS NULL
         AND (s.adult=0 OR ?=1)
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 1`,
      [game.id, adultAllowed]
    );
    scenario = rows[0] || null;
    isIntroduction = Boolean(scenario);
  }

  if (!scenario) return { handled: false };

  let event = null;
  if (isIntroduction) {
    event = { ...scenario, event_source: "scenario_trigger", scenario_id: scenario.id };
  } else {
    const [children] = await conn.query(
      `SELECT se.*
       FROM hg_scenario_events se
       LEFT JOIN hg_scenario_usage u
         ON u.game_id=? AND u.event_id=se.id
       WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
         AND (se.adult=0 OR ?=1)
       ORDER BY se.sort_order ASC, se.id ASC`,
      [game.id, scenario.id, adultAllowed]
    );

    if (!children.length) {
      await finishScenario(conn, game.id, scenario.id, channel, "story", day, scenario.name);
      return { handled: true, message: `✅ A história “${scenario.name}” terminou.` };
    }
    event = { ...children[0], event_source: "scenario_child", scenario_id: scenario.id };
  }

  // Cada trecho pega uma lista atualizada de vivos. Isso impede que alguém
  // morto em um trecho anterior volte a aparecer na história.
  const [aliveNowRows] = await conn.query(
    "SELECT * FROM hg_players WHERE game_id=? AND alive=1 ORDER BY RAND() FOR UPDATE",
    [game.id]
  );
  const aliveNow = aliveNowRows.length ? aliveNowRows : alive;
  if (aliveNow.length <= 1) return { handled: false };

  const requested = eventParticipantCount(event, aliveNow.length);
  const group = eventUsesAllPlayers(event)
    ? shuffle(aliveNow)
    : shuffle(aliveNow).slice(0, Math.min(requested, aliveNow.length));
  const aliveIds = new Set(aliveNow.map(p => Number(p.id)));

  const deathMap = new Map();
  for (const idx of validEventKillIndexes(event)) {
    const person = group[idx];
    if (person && aliveIds.has(Number(person.id))) deathMap.set(Number(person.id), person);
  }
  let deaths = [...deathMap.values()];
  if (aliveIds.size - deaths.length < 1) {
    deaths = deaths.slice(0, Math.max(0, aliveIds.size - 1));
  }

  const confirmedDeaths = [];
  for (const dead of deaths) {
    const [updated] = await conn.query(
      "UPDATE hg_players SET alive=0 WHERE id=? AND game_id=? AND alive=1",
      [dead.id, game.id]
    );
    if (updated.affectedRows === 1) confirmedDeaths.push(dead);
  }

  const deadIds = new Set(confirmedDeaths.map(p => Number(p.id)));
  const killer = group.find(p => !deadIds.has(Number(p.id)) && aliveIds.has(Number(p.id)));
  if (killer && confirmedDeaths.length) {
    await conn.query(
      "UPDATE hg_players SET kills=kills+? WHERE id=? AND game_id=? AND alive=1",
      [confirmedDeaths.length, killer.id, game.id]
    );
  }

  const text = fill(event.text, group);
  const deathNames = confirmedDeaths.map(p => p.display_name || p.username);
  await conn.query(
    "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths,participant_ids) VALUES (?,?,?,?,?,?,?)",
    [game.id, channel, "story", day, text, deathNames.join(", "), group.map(player => Number(player.id)).join(",")]
  );

  if (isIntroduction) {
    await conn.query(
      "INSERT IGNORE INTO hg_game_scenario_runs (game_id,scenario_id) VALUES (?,?)",
      [game.id, scenario.id]
    );
    await conn.query("UPDATE hg_games SET active_scenario_id=? WHERE id=?", [scenario.id, game.id]);

    const [childCount] = await conn.query(
      "SELECT COUNT(*) AS total FROM hg_scenario_events WHERE scenario_id=? AND active=1 AND (adult=0 OR ?=1)",
      [scenario.id, adultAllowed]
    );
    if (Number(childCount?.[0]?.total || 0) === 0) {
      await finishScenario(conn, game.id, scenario.id, channel, "story", day, scenario.name);
    }
  } else {
    await conn.query(
      "INSERT IGNORE INTO hg_scenario_usage (game_id,scenario_id,event_id) VALUES (?,?,?)",
      [game.id, scenario.id, event.id]
    );
    const [remaining] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM hg_scenario_events se
       LEFT JOIN hg_scenario_usage u
         ON u.game_id=? AND u.event_id=se.id
       WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
         AND (se.adult=0 OR ?=1)`,
      [game.id, scenario.id, adultAllowed]
    );
    if (Number(remaining?.[0]?.total || 0) === 0) {
      await finishScenario(conn, game.id, scenario.id, channel, "story", day, scenario.name);
    }
  }

  const [survivors] = await conn.query(
    "SELECT * FROM hg_players WHERE game_id=? AND alive=1 ORDER BY RAND() FOR UPDATE",
    [game.id]
  );
  if (survivors.length <= 1) {
    const winner = survivors[0]?.display_name || null;
    // O último acontecimento já é o evento desta chamada. O vencedor aparece
    // no estado da partida, sem criar um segundo evento na página pública.
    await assignWinnerPrize(conn, game.id, winner);
    return { handled: true, message: winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor." };
  }

  return {
    handled: true,
    message: isIntroduction
      ? `🎬 História iniciada: ${scenario.name}.`
      : `▶️ Próximo acontecimento de “${scenario.name}”.`
  };
}

async function nextRound(channel) {
  return withChannelLock(channel, async (conn) => {
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
        await assignWinnerPrize(conn, game.id, winner);
        await conn.commit();
        return winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor.";
      }

      const adultAllowed = Number(game.adult_mode) === 1 ? 1 : 0;
      const normalEventsEnabled = Number(game.normal_events_enabled ?? 1) === 1;

      // Histórias exclusivas sempre têm prioridade. Esta função cria somente
      // a introdução OU somente um evento interno a cada chamada.
      const exclusiveStory = await runExclusiveStoryBeat(
        conn,
        game,
        alive,
        channel,
        adultAllowed,
        !normalEventsEnabled
      );
      if (exclusiveStory.handled) {
        await conn.commit();
        return exclusiveStory.message;
      }

      if (!normalEventsEnabled) {
        await conn.rollback();
        return "⛔ Eventos normais/antigos estão desativados e não há nenhuma história ativa pendente. Ative ou reinicie uma história.";
      }

      let phase = game.phase || "bloodbath";
      let day = Number(game.day_number || 1);
      let activeScenarioId = Number(game.active_scenario_id || 0);
      let selectedEvent = null;
      let selectedGroup = [];
      let selectedPhase = phase;
      let selectedDay = day;
      let selectedScenario = null;

      // Pode pular uma fase sem evento utilizável, mas nunca cria mais de um
      // evento. O limite evita laço infinito caso o banco esteja mal configurado.
      for (let attempt = 0; attempt < 8 && !selectedEvent; attempt++) {
        const phases = (phase === "day" || phase === "night") ? [phase, "arena"] : [phase];
        const marks = phases.map(() => "?").join(",");

        const [usedRows] = await conn.query(
          "SELECT player_id FROM hg_phase_usage WHERE game_id=? AND phase=? AND day_number=?",
          [game.id, phase, day]
        );
        const usedIds = new Set(usedRows.map(row => Number(row.player_id)));
        const available = shuffle(alive.filter(player => !usedIds.has(Number(player.id))));

        if (!available.length) {
          const next = nextPhase(phase, day);
          phase = next.phase;
          day = next.day;
          await conn.query(
            "UPDATE hg_games SET phase=?,day_number=? WHERE id=? AND status='running'",
            [phase, day, game.id]
          );
          continue;
        }

        const [normalEvents] = await conn.query(
          `SELECT e.*, 'normal' AS event_source, NULL AS scenario_id,
                  NULL AS scenario_name, 1 AS mix_with_normal
           FROM hg_events e
           WHERE e.active=1 AND e.phase IN (${marks}) AND (e.adult=0 OR ?=1)
           ORDER BY RAND()`,
          [...phases, adultAllowed]
        );

        let activeScenario = null;
        const storyCandidates = [];

        if (activeScenarioId) {
          const [scenarioRows] = await conn.query(
            "SELECT * FROM hg_scenarios WHERE id=? AND active=1 LIMIT 1",
            [activeScenarioId]
          );
          activeScenario = scenarioRows[0] || null;

          if (!activeScenario) {
            await finishScenario(conn, game.id, activeScenarioId, channel, phase, day, "");
            activeScenarioId = 0;
          } else if (!Number(activeScenario.mix_with_normal)) {
            await conn.rollback();
            return `⛔ A história “${activeScenario.name}” está em modo exclusivo. Reinicie a história ou confira os eventos internos ativos.`;
          } else {
            const [children] = await conn.query(
              `SELECT se.*, 'scenario_child' AS event_source, se.scenario_id,
                      ? AS scenario_name, 1 AS mix_with_normal
               FROM hg_scenario_events se
               LEFT JOIN hg_scenario_usage u
                 ON u.game_id=? AND u.event_id=se.id
               WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
                 AND (se.phase='any' OR se.phase IN (${marks}))
                 AND (se.adult=0 OR ?=1)
               ORDER BY se.sort_order ASC, se.id ASC
               LIMIT 1`,
              [activeScenario.name, game.id, activeScenarioId, ...phases, adultAllowed]
            );
            if (children[0]) {
              storyCandidates.push(children[0]);
            } else {
              const [remainingRows] = await conn.query(
                `SELECT COUNT(*) AS total
                 FROM hg_scenario_events se
                 LEFT JOIN hg_scenario_usage u
                   ON u.game_id=? AND u.event_id=se.id
                 WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
                   AND (se.adult=0 OR ?=1)`,
                [game.id, activeScenarioId, adultAllowed]
              );
              if (Number(remainingRows?.[0]?.total || 0) === 0) {
                await finishScenario(
                  conn,
                  game.id,
                  activeScenarioId,
                  channel,
                  phase,
                  day,
                  activeScenario.name
                );
                activeScenarioId = 0;
                activeScenario = null;
              }
            }
          }
        }

        if (!activeScenarioId) {
          const [triggers] = await conn.query(
            `SELECT s.id, s.phase, s.type, s.players, s.text, s.kills, s.adult,
                    'scenario_trigger' AS event_source, s.id AS scenario_id,
                    s.name AS scenario_name, s.mix_with_normal
             FROM hg_scenarios s
             LEFT JOIN hg_game_scenario_runs r
               ON r.game_id=? AND r.scenario_id=s.id
             WHERE s.active=1 AND s.mix_with_normal=1 AND r.scenario_id IS NULL
               AND s.phase IN (${marks}) AND (s.adult=0 OR ?=1)
             ORDER BY s.updated_at DESC, s.id DESC`,
            [game.id, ...phases, adultAllowed]
          );
          storyCandidates.push(...triggers);
        }

        const pool = [...normalEvents, ...storyCandidates];
        const possible = pool.filter(event => {
          const count = eventParticipantCount(event, alive.length);
          if (eventUsesAllPlayers(event)) {
            return usedIds.size === 0 && available.length === alive.length && alive.length > 0;
          }
          if (count > available.length) return false;
          if (String(event.type || "").toLowerCase() === "death" && validEventKillIndexes(event).length === 0) {
            return false;
          }
          return true;
        });

        if (!possible.length) {
          const next = nextPhase(phase, day);
          phase = next.phase;
          day = next.day;
          await conn.query(
            "UPDATE hg_games SET phase=?,day_number=? WHERE id=? AND status='running'",
            [phase, day, game.id]
          );
          continue;
        }

        const storyPossible = possible.filter(event => event.event_source !== "normal");
        const deathPossible = possible.filter(event => validEventKillIndexes(event).length > 0);

        let eventPool = possible;
        if (storyPossible.length && Math.random() < 0.72) {
          eventPool = storyPossible;
        } else if (alive.length > 2 && deathPossible.length && Math.random() < 0.38) {
          eventPool = deathPossible;
        }

        selectedEvent = random(eventPool);
        const count = eventParticipantCount(selectedEvent, alive.length);
        selectedGroup = eventUsesAllPlayers(selectedEvent)
          ? shuffle(alive)
          : available.slice(0, Math.min(count, available.length));
        selectedPhase = phase;
        selectedDay = day;
        selectedScenario = activeScenario;
      }

      if (!selectedEvent || !selectedGroup.length) {
        await conn.rollback();
        return "Sem eventos utilizáveis para as fases atuais.";
      }

      const aliveIds = new Set(alive.map(player => Number(player.id)));
      const deathMap = new Map();
      for (const index of validEventKillIndexes(selectedEvent)) {
        const person = selectedGroup[index];
        if (person && aliveIds.has(Number(person.id))) {
          deathMap.set(Number(person.id), person);
        }
      }

      let deaths = [...deathMap.values()];
      if (aliveIds.size - deaths.length < 1) {
        deaths = deaths.slice(0, Math.max(0, aliveIds.size - 1));
      }

      const confirmedDeaths = [];
      for (const dead of deaths) {
        const [updated] = await conn.query(
          "UPDATE hg_players SET alive=0 WHERE id=? AND game_id=? AND alive=1",
          [dead.id, game.id]
        );
        if (updated.affectedRows === 1) confirmedDeaths.push(dead);
      }

      if (deaths.length && confirmedDeaths.length !== deaths.length) {
        throw new Error("A morte do evento não pôde ser confirmada; o evento foi cancelado para impedir que alguém morto volte a aparecer.");
      }

      const deadIds = new Set(confirmedDeaths.map(player => Number(player.id)));
      const killer = selectedGroup.find(
        player => !deadIds.has(Number(player.id)) && aliveIds.has(Number(player.id))
      );
      if (killer && confirmedDeaths.length) {
        await conn.query(
          "UPDATE hg_players SET kills=kills+? WHERE id=? AND game_id=? AND alive=1",
          [confirmedDeaths.length, killer.id, game.id]
        );
      }

      const text = fill(selectedEvent.text, selectedGroup);
      const deathNames = confirmedDeaths.map(player => player.display_name || player.username);
      await conn.query(
        "INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths,participant_ids) VALUES (?,?,?,?,?,?,?)",
        [game.id, channel, selectedPhase, selectedDay, text, deathNames.join(", "), selectedGroup.map(player => Number(player.id)).join(",")]
      );

      await conn.query(
        "INSERT IGNORE INTO hg_phase_usage (game_id,phase,day_number,player_id) VALUES ?",
        [selectedGroup.map(player => [game.id, selectedPhase, selectedDay, player.id])]
      );

      if (selectedEvent.event_source === "scenario_trigger") {
        const scenarioId = Number(selectedEvent.scenario_id || selectedEvent.id);
        await conn.query(
          "INSERT IGNORE INTO hg_game_scenario_runs (game_id,scenario_id) VALUES (?,?)",
          [game.id, scenarioId]
        );
        await conn.query(
          "UPDATE hg_games SET active_scenario_id=? WHERE id=?",
          [scenarioId, game.id]
        );
        activeScenarioId = scenarioId;
      } else if (selectedEvent.event_source === "scenario_child") {
        const scenarioId = Number(selectedEvent.scenario_id);
        await conn.query(
          "INSERT IGNORE INTO hg_scenario_usage (game_id,scenario_id,event_id) VALUES (?,?,?)",
          [game.id, scenarioId, Number(selectedEvent.id)]
        );

        const [remaining] = await conn.query(
          `SELECT COUNT(*) AS total
           FROM hg_scenario_events se
           LEFT JOIN hg_scenario_usage u
             ON u.game_id=? AND u.event_id=se.id
           WHERE se.scenario_id=? AND se.active=1 AND u.event_id IS NULL
             AND (se.adult=0 OR ?=1)`,
          [game.id, scenarioId, adultAllowed]
        );
        if (Number(remaining?.[0]?.total || 0) === 0) {
          await finishScenario(
            conn,
            game.id,
            scenarioId,
            channel,
            selectedPhase,
            selectedDay,
            selectedEvent.scenario_name || selectedScenario?.name || ""
          );
          activeScenarioId = 0;
        }
      }

      [alive] = await conn.query(
        "SELECT * FROM hg_players WHERE game_id=? AND alive=1 ORDER BY RAND() FOR UPDATE",
        [game.id]
      );

      if (alive.length <= 1) {
        const winner = alive[0]?.display_name || null;
        await assignWinnerPrize(conn, game.id, winner);
        await conn.commit();
        return winner
          ? `🏆 Um evento foi gerado. ${winner} venceu a arena!`
          : "Um evento foi gerado. A partida acabou sem vencedor.";
      }

      const [remainingForPhase] = await conn.query(
        `SELECT p.id
         FROM hg_players p
         LEFT JOIN hg_phase_usage u
           ON u.game_id=p.game_id AND u.player_id=p.id
          AND u.phase=? AND u.day_number=?
         WHERE p.game_id=? AND p.alive=1 AND u.player_id IS NULL`,
        [selectedPhase, selectedDay, game.id]
      );

      if (!remainingForPhase.length) {
        const next = nextPhase(selectedPhase, selectedDay);
        await conn.query(
          "UPDATE hg_games SET phase=?,day_number=? WHERE id=? AND status='running'",
          [next.phase, next.day, game.id]
        );
      }

      await conn.commit();
      return `✅ 1 evento gerado em ${phaseName(selectedPhase, selectedDay)}. Restam ${alive.length} vivos.`;
    } catch (error) {
      try { await conn.rollback(); } catch {}
      throw error;
    }
  });
}

async function startAuto(channel, firstDelayMs = null) {
  const ch = nick(channel || "icarolinaporto");
  stopAuto(ch);
  const game = await currentGame(ch, false);
  if (!game || game.status !== "running") return "A partida precisa estar rodando. Clique em Iniciar primeiro.";
  const runToken = Symbol(ch);
  autoRunTokens.set(ch, runToken);

  const scheduleNext = delayMs => {
    const timer = setTimeout(async () => {
      if (autoRunTokens.get(ch) !== runToken) return;
      try {
        const current = await currentGame(ch, false);
        if (!current || current.status !== "running") {
          stopAuto(ch);
          return;
        }
        const result = await nextRound(ch);
        if (/venceu|acabou|já acabou|não há nenhuma história ativa pendente/i.test(String(result))) {
          stopAuto(ch);
          return;
        }
        const after = await currentGame(ch, false);
        if (!after || after.status !== "running") {
          stopAuto(ch);
          return;
        }
        if (autoRunTokens.get(ch) === runToken) scheduleNext(getAutoIntervalMs(after));
      } catch (e) {
        console.error("Erro no automático HG:", e);
        stopAuto(ch);
      }
    }, Math.max(500, Number(delayMs) || 800));
    autoTimers.set(ch, timer);
  };

  scheduleNext(firstDelayMs == null ? getAutoIntervalMs(game) : firstDelayMs);
  return `▶️ Automático ligado. Um novo evento será criado a cada ${(getAutoIntervalMs(game) / 1000).toFixed(1).replace(".", ",")} segundo(s), sem voz e sem mover a tela.`;
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
  return "Comandos: !hg entrar | !hg entrar 5 | !hg distrito 5 | !hg sair | !hg todos | !hg iniciar (começa o automático) | !hg proximo | !hg auto | !hg parar | !hg resetar | !hg +18 ligar/desligar";
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
    if (action === "normal_events_on") return send(res, await setNormalEvents(ch, true));
    if (action === "normal_events_off") return send(res, await setNormalEvents(ch, false));
    if (action === "refresh_avatars") {
      await ensureTables();
      const game = await currentGame(ch, true);
      avatarRefreshTimes.delete(Number(game.id));
      const updated = await refreshMissingPlayerAvatars(game.id, true);
      return send(res, `✅ Fotos da Twitch atualizadas. ${updated} participante(s) recebeu/atualizou a imagem.`);
    }
    if (action === "set_auto_interval") {
      await ensureTables();
      const game = await currentGame(ch, true);
      const db = await getPool();
      const delayRaw = Number(req.body?.event_delay_ms ?? req.query.event_delay_ms ?? 9000);
      const eventDelayMs = Math.max(1000, Math.min(60000, Number.isFinite(delayRaw) ? Math.round(delayRaw) : 9000));
      const wasRunning = isAutoRunning(ch);
      await db.query("UPDATE hg_games SET narration_enabled=0,event_delay_ms=? WHERE id=?", [eventDelayMs, game.id]);
      if (wasRunning && game.status === "running") await startAuto(ch, eventDelayMs);
      return send(res, `✅ Tempo do automático salvo: ${(eventDelayMs / 1000).toFixed(1).replace(".", ",")} segundo(s) entre os eventos.`);
    }
    if (action === "set_winner_prize_settings") {
      await ensureTables();
      const game = await currentGame(ch, true);
      const db = await getPool();
      const enabled = String(req.body?.enabled ?? req.query.enabled ?? "1") === "1" ? 1 : 0;
      const saved = await saveWinnerPrizeSettings(db, ch, enabled, req.body?.text || req.query.text || DEFAULT_WINNER_PRIZE_TEXT);
      await db.query("UPDATE hg_games SET winner_trophy_enabled=?, winner_trophy_text=? WHERE id=?", [saved.enabled ? 1 : 0, saved.text, game.id]);
      return send(res, saved.enabled ? "✅ Prêmio do vencedor ativado e salvo." : "⛔ Prêmio do vencedor desativado e salvo.");
    }

    if (action === "add_trophy") {
      await ensureTables();
      const db = await getPool();
      const title = String(req.body?.title || req.query.title || "").trim().slice(0, 160);
      const imageData = String(req.body?.image_data || req.query.image_data || "").trim();
      const activeFlag = String(req.body?.active ?? req.query.active ?? "1") === "1" ? 1 : 0;
      if (!title) return send(res, "Faltou o nome do prêmio.");
      if (!/^data:image\//i.test(imageData)) return send(res, "Envie uma imagem válida do prêmio.");
      if (imageData.length > 3_500_000) return send(res, "A imagem ficou grande demais. Escolha uma imagem menor.");
      await db.query("INSERT INTO hg_trophies (title,image_data,active) VALUES (?,?,?)", [title, imageData, activeFlag]);
      return send(res, "✅ Prêmio adicionado.");
    }

    if (action === "update_trophy") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || req.query.id || 0);
      const title = String(req.body?.title || req.query.title || "").trim().slice(0, 160);
      const imageData = String(req.body?.image_data || req.query.image_data || "").trim();
      const activeFlag = String(req.body?.active ?? req.query.active ?? "1") === "1" ? 1 : 0;
      if (!id) return send(res, "ID inválido.");
      if (!title) return send(res, "Faltou o nome do prêmio.");
      const params = [title, activeFlag];
      let sql = "UPDATE hg_trophies SET title=?, active=?";
      if (imageData) {
        if (!/^data:image\//i.test(imageData)) return send(res, "Imagem inválida.");
        if (imageData.length > 3_500_000) return send(res, "A imagem ficou grande demais. Escolha uma imagem menor.");
        sql += ", image_data=?";
        params.push(imageData);
      }
      sql += " WHERE id=?";
      params.push(id);
      await db.query(sql, params);
      return send(res, "✅ Prêmio atualizado.");
    }

    if (action === "delete_trophy") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || req.query.id || 0);
      if (!id) return send(res, "ID inválido.");
      await db.query("DELETE FROM hg_trophies WHERE id=?", [id]);
      await db.query("UPDATE hg_games SET winner_trophy_id=NULL, winner_trophy_title=NULL, winner_trophy_image=NULL WHERE winner_trophy_id=?", [id]);
      return send(res, "🗑️ Prêmio excluído.");
    }

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


    if (action === "generate_story") {
      await ensureTables();
      const db = await getPool();
      const category = String(req.body?.category || req.query.category || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      if (category.length < 2 || !splitStoryCategories(category).length) return send(res, "Digite uma ou mais categorias válidas para criar a história.");

      const [games] = await db.query(
        "SELECT id,status FROM hg_games WHERE channel=? AND status IN ('lobby','running') ORDER BY id DESC LIMIT 1",
        [ch]
      );
      const current = games[0] || null;
      let aliveCount = 0;
      if (current) {
        const [countRows] = await db.query(
          "SELECT COUNT(*) AS total FROM hg_players WHERE game_id=? AND alive=1",
          [current.id]
        );
        aliveCount = Number(countRows?.[0]?.total || 0);
      }

      const generated = buildAutomaticStory(category, aliveCount);
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const [scenarioResult] = await conn.query(
          "INSERT INTO hg_scenarios (name,phase,type,players,text,kills,adult,mix_with_normal,active) VALUES (?, 'arena', 'neutral', 0, ?, '', 0, 0, 1)",
          [generated.name, generated.intro]
        );
        const scenarioId = Number(scenarioResult.insertId);
        const rows = generated.events.map((event, index) => [
          scenarioId,
          event.phase,
          event.type,
          event.players,
          event.text,
          event.kills,
          event.adult,
          event.active,
          index + 1
        ]);
        if (rows.length) {
          await conn.query(
            "INSERT INTO hg_scenario_events (scenario_id,phase,type,players,text,kills,adult,active,sort_order) VALUES ?",
            [rows]
          );
        }
        if (current) {
          await conn.query(
            "UPDATE hg_games SET active_scenario_id=NULL,normal_events_enabled=0,narration_enabled=0 WHERE id=?",
            [current.id]
          );
        }
        await conn.commit();
        return send(
          res,
          `✅ ${generated.name} criada ${generated.mixed ? `misturando ${generated.categoryCount} categorias (${generated.categories.join(" + ")})` : "com 1 categoria"} em ${generated.events.length + 1} capítulos e ${generated.deathCount} mortes possíveis. Ela foi preparada em modo exclusivo e continuará usando a proteção que impede mortos de voltar e preserva um vencedor.`
        );
      } catch (error) {
        try { await conn.rollback(); } catch {}
        throw error;
      } finally {
        conn.release();
      }
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
      if (!mixFlag && activeFlag) {
        const [games] = await db.query(
          "SELECT id FROM hg_games WHERE channel=? AND status IN ('lobby','running') ORDER BY id DESC LIMIT 1",
          [ch]
        );
        if (games[0]) {
          await db.query("UPDATE hg_games SET active_scenario_id=NULL, normal_events_enabled=0 WHERE id=?", [games[0].id]);
        }
      }
      return send(res, !mixFlag && activeFlag
        ? `✅ História criada em modo exclusivo. Eventos antigos desativados. ID ${result.insertId}.`
        : `✅ Evento especial criado. Abra a seta para adicionar os eventos decorrentes. ID ${result.insertId}.`);
    }

    if (action === "update_scenario_options") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || 0);
      const mixFlag = String(req.body?.mix_with_normal ?? "1") === "1" ? 1 : 0;
      const activeFlag = String(req.body?.active ?? "1") === "1" ? 1 : 0;
      if (!id) return send(res, "ID inválido.");
      await db.query(
        "UPDATE hg_scenarios SET mix_with_normal=?, active=? WHERE id=?",
        [mixFlag, activeFlag, id]
      );
      if (!activeFlag) {
        await db.query("UPDATE hg_games SET active_scenario_id=NULL WHERE active_scenario_id=?", [id]);
      } else if (!mixFlag) {
        // Ao desligar a mistura, a história é preparada novamente na partida
        // atual. Assim a introdução entra no próximo passo automático, mesmo
        // que uma tentativa anterior já a tenha marcado como executada.
        const [games] = await db.query(
          "SELECT id FROM hg_games WHERE channel=? AND status IN ('lobby','running') ORDER BY id DESC LIMIT 1",
          [ch]
        );
        const current = games[0];
        if (current) {
          await db.query("DELETE FROM hg_scenario_usage WHERE game_id=? AND scenario_id=?", [current.id, id]);
          await db.query("DELETE FROM hg_game_scenario_runs WHERE game_id=? AND scenario_id=?", [current.id, id]);
          await db.query("UPDATE hg_games SET active_scenario_id=NULL, normal_events_enabled=0 WHERE id=?", [current.id]);
        }
      }
      return send(
        res,
        mixFlag
          ? "✅ Opções salvas: esta história pode misturar com eventos normais."
          : "✅ Opções salvas: modo exclusivo preparado e eventos antigos desativados. A introdução será o próximo evento."
      );
    }

    if (action === "restart_scenario") {
      await ensureTables();
      const db = await getPool();
      const id = Number(req.body?.id || req.query.id || 0);
      if (!id) return send(res, "ID inválido.");
      const [games] = await db.query(
        "SELECT id FROM hg_games WHERE channel=? AND status IN ('lobby','running') ORDER BY id DESC LIMIT 1",
        [ch]
      );
      const current = games[0];
      if (!current) return send(res, "Não existe uma partida atual para reiniciar a história.");
      await db.query("DELETE FROM hg_scenario_usage WHERE game_id=? AND scenario_id=?", [current.id, id]);
      await db.query("DELETE FROM hg_game_scenario_runs WHERE game_id=? AND scenario_id=?", [current.id, id]);
      await db.query("UPDATE hg_games SET active_scenario_id=NULL, normal_events_enabled=0 WHERE id=?", [current.id]);
      return send(res, "✅ História preparada. Os eventos antigos foram desativados e a introdução será o próximo evento automático.");
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
      if (!activeFlag) {
        await db.query("UPDATE hg_games SET active_scenario_id=NULL WHERE active_scenario_id=?", [id]);
      } else if (!mixFlag) {
        const [games] = await db.query(
          "SELECT id FROM hg_games WHERE channel=? AND status IN ('lobby','running') ORDER BY id DESC LIMIT 1",
          [ch]
        );
        const current = games[0];
        if (current) {
          await db.query("DELETE FROM hg_scenario_usage WHERE game_id=? AND scenario_id=?", [current.id, id]);
          await db.query("DELETE FROM hg_game_scenario_runs WHERE game_id=? AND scenario_id=?", [current.id, id]);
          await db.query("UPDATE hg_games SET active_scenario_id=NULL, normal_events_enabled=0 WHERE id=?", [current.id]);
        }
      }
      return send(res, !mixFlag && activeFlag
        ? "✅ História atualizada e preparada para começar pela introdução."
        : "✅ Evento especial atualizado.");
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
    const current = await currentGame(ch, true);
    await refreshMissingPlayerAvatarsThrottled(current?.id);
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
        (SELECT COUNT(*) FROM hg_events WHERE active=1) AS normalTotal,
        (SELECT COUNT(*) FROM hg_scenarios WHERE active=1) +
        (SELECT COUNT(*) FROM hg_scenario_events se JOIN hg_scenarios sc ON sc.id=se.scenario_id WHERE se.active=1 AND sc.active=1) AS storyTotal,
        (SELECT COUNT(*) FROM hg_events WHERE active=1 AND adult=1) AS normalAdultTotal,
        (SELECT COUNT(*) FROM hg_scenarios WHERE active=1 AND adult=1) +
        (SELECT COUNT(*) FROM hg_scenario_events se JOIN hg_scenarios sc ON sc.id=se.scenario_id WHERE se.active=1 AND sc.active=1 AND se.adult=1) AS storyAdultTotal
    `);
    const [activeScenarioRows] = game?.active_scenario_id
      ? await conn.query("SELECT id,name,mix_with_normal FROM hg_scenarios WHERE id=? LIMIT 1", [game.active_scenario_id])
      : [[]];
    const prizeSettings = await getWinnerPrizeSettings(conn, ch);
    await ensureWinnerPrizeForEndedGame(conn, game, ch, prizeSettings);
    await conn.commit();

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.json({
      game,
      players,
      logs: logs.reverse(),
      eventCount: Number(game?.normal_events_enabled ?? 1)
        ? Number(events?.[0]?.normalTotal || 0) + Number(events?.[0]?.storyTotal || 0)
        : Number(events?.[0]?.storyTotal || 0),
      normalEventCount: Number(events?.[0]?.normalTotal || 0),
      storyEventCount: Number(events?.[0]?.storyTotal || 0),
      adultEventCount: Number(game?.normal_events_enabled ?? 1)
        ? Number(events?.[0]?.normalAdultTotal || 0) + Number(events?.[0]?.storyAdultTotal || 0)
        : Number(events?.[0]?.storyAdultTotal || 0),
      activeScenario: activeScenarioRows?.[0] || null,
      autoRunning: isAutoRunning(ch),
      autoIntervalMs: getAutoIntervalMs(game),
      winnerPrize: {
        enabled: prizeSettings.enabled,
        text: prizeSettings.text,
        trophyId: Number(game?.winner_trophy_id || 0),
        trophyTitle: String(game?.winner_trophy_title || ""),
        trophyImage: String(game?.winner_trophy_image || "")
      }
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
*{box-sizing:border-box}html,body,.logs{overflow-anchor:none}body{margin:0;background:radial-gradient(circle at top,#2a1247,#080810 46%,#050509);color:var(--text);font-family:Inter,system-ui,Arial,sans-serif}.wrap{max-width:1280px;margin:auto;padding:22px}
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
.avatar-wrap{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}.avatar-wrap>[hidden]{display:none!important}.player>.avatar-wrap{width:46px;height:46px}.event-person>.avatar-wrap{width:72px;height:72px}body.hg-running .event-person>.avatar-wrap{width:96px;height:96px}

.automatic-story-generator{border:1px solid #7e22ce;background:linear-gradient(180deg,#22102f,#100b18);border-radius:20px;padding:16px;margin:12px 0 20px}.automatic-story-form{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;margin-top:12px}.automatic-story-status{margin-top:10px;color:#d8b4fe;font-weight:850;line-height:1.4}.automatic-story-generator h3{margin:4px 0 0}.automatic-story-generator button[disabled]{opacity:.55;cursor:wait}
.scenario-create-grid,.scenario-edit-grid,.child-edit-grid{display:grid;grid-template-columns:1.25fr 1fr .7fr 1.4fr .8fr;gap:8px;margin-top:12px}.scenario-card{border:1px solid var(--b);background:#10101a;border-radius:20px;overflow:hidden}.scenario-head{display:flex;align-items:center;gap:10px;padding:14px;cursor:pointer;background:#171726}.scenario-arrow{width:42px;min-width:42px;padding:9px;background:#303044}.scenario-title{flex:1}.scenario-body{padding:14px;border-top:1px solid var(--b)}.scenario-body.collapsed{display:none}.scenario-flags{display:flex;gap:8px;flex-wrap:wrap}.flag{font-size:11px;font-weight:950;border:1px solid var(--b);border-radius:999px;padding:5px 8px;color:#ddd6fe}.switch-row{display:flex;align-items:center;gap:10px;border:1px solid var(--b);background:#0d0d16;border-radius:14px;padding:10px 12px}.switch-row input{width:20px;height:20px;accent-color:var(--p)}.child-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}.child-card{border:1px solid var(--b);border-radius:16px;padding:12px;background:#0d0d16}.scenario-help{border-left:4px solid var(--p);padding:10px 12px;background:#1b1026;border-radius:10px;margin:10px 0}.wide-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.auto-time-bar{display:grid;grid-template-columns:minmax(230px,1fr) auto;gap:10px;margin:0 0 14px;align-items:end;border:1px solid var(--b);background:#0d0d16;border-radius:16px;padding:12px}.auto-time-field label{display:block;font-size:12px;font-weight:950;color:#ddd6fe;margin-bottom:7px}.auto-time-input{display:grid;grid-template-columns:minmax(90px,140px) auto;gap:8px;align-items:center}.auto-time-input input{font-weight:950}.auto-time-status{grid-column:1/-1;color:#c4b5fd}.story-card{border-color:#6b21a8;box-shadow:0 18px 60px #581c8730}.player-count-note{display:block;margin-top:6px;color:#c4b5fd}.player-count-input{font-weight:900}.log.event-sync-enter{animation:eventSyncEnter .22s ease-out}@keyframes eventSyncEnter{from{opacity:.15;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.winner-prize{margin-top:16px;padding:16px;border:1px solid #6b21a8;background:linear-gradient(180deg,#241032,#120a1b);border-radius:22px;text-align:center}.winner-prize>img{max-width:100%;max-height:360px;object-fit:contain;border-radius:18px;border:1px solid var(--b);background:#09090f;padding:8px}.winner-prize-title{font-size:20px;font-weight:950;margin:10px 0 6px}.winner-prize-text{font-size:18px;font-weight:900;line-height:1.4;color:#f5d0fe;margin-bottom:12px}.winner-prize-sub{font-size:13px;color:#c4b5fd}.trophy-admin-grid{display:grid;grid-template-columns:1.1fr .9fr auto;gap:8px;margin-top:12px;align-items:start}.trophy-preview{border:1px dashed var(--b);background:#0d0d16;border-radius:18px;min-height:150px;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:10px;color:var(--muted)}.trophy-preview img{max-width:100%;max-height:210px;object-fit:contain;border-radius:14px}.trophy-row{display:grid;grid-template-columns:170px 1fr;gap:14px;padding:12px;border:1px solid var(--b);background:#10101a;border-radius:18px}.trophy-row .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.trophy-row .preview{display:flex;align-items:center;justify-content:center;min-height:120px;border:1px solid var(--b);border-radius:16px;background:#0d0d16;overflow:hidden;padding:8px}.trophy-row .preview img{max-width:100%;max-height:150px;object-fit:contain;border-radius:12px}.winner-prize.hidden{display:none!important}.public-winner-prize:not(.hidden){position:static;width:100%;max-width:820px;margin:18px auto 0;box-shadow:0 18px 45px #0008;border:2px solid #a855f7;padding:20px}.public-winner-prize .winner-prize-text:first-child{font-size:clamp(22px,4vw,34px);color:#fff}.public-winner-prize>img{max-height:420px}.winner-player-photo{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;margin:8px auto 16px}.winner-player-photo img,.winner-player-photo .fake{width:132px;height:132px;border-radius:28px;object-fit:cover;border:3px solid #f0abfc;background:#18111f;box-shadow:0 12px 32px #0009;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:950}.winner-player-photo-label{font-size:13px;font-weight:950;color:#f5d0fe;text-transform:uppercase;letter-spacing:.12em}.admin-participants-visible{display:block!important}.prize-save-status{margin-top:8px;font-weight:900;color:#c4b5fd}.fold-card{padding:0;overflow:hidden}.fold-card>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px;cursor:pointer;user-select:none;background:linear-gradient(180deg,rgba(168,85,247,.10),rgba(168,85,247,.025));border:0}.fold-card>summary::-webkit-details-marker{display:none}.fold-card>summary:hover{background:rgba(168,85,247,.15)}.fold-heading{min-width:0;flex:1}.fold-heading h2{margin:6px 0 0}.fold-arrow{width:42px;height:42px;min-width:42px;display:flex;align-items:center;justify-content:center;border:1px solid #6b21a8;border-radius:14px;background:#241332;color:#f5d0fe;font-size:0;font-weight:950;transition:transform .18s ease,background .18s ease}.fold-arrow::before{content:"›";font-size:30px;line-height:1}.fold-card[open] .fold-arrow{transform:rotate(90deg);background:#6b21a8}.fold-body{padding:0 18px 18px;border-top:1px solid rgba(168,85,247,.18)}.fold-card:not([open]){min-height:78px}.fold-card:not([open]) .fold-body{display:none}.fold-card.story-card>summary{padding-bottom:18px}.fold-card .fold-body> :first-child{margin-top:16px}.fold-card .fold-body> hr:first-child{display:none}
@media(max-width:900px){.automatic-story-form{grid-template-columns:1fr}.trophy-admin-grid,.trophy-row{grid-template-columns:1fr}.scenario-create-grid,.scenario-edit-grid,.child-edit-grid{grid-template-columns:1fr 1fr}.scenario-create-grid textarea,.scenario-edit-grid textarea,.child-edit-grid textarea,.span-all{grid-column:1/-1}.auto-time-bar{grid-template-columns:1fr}.auto-time-status{grid-column:1}.admin-event-grid{grid-template-columns:1fr 1fr!important}.fold-card>summary{padding:16px}.fold-body{padding:0 16px 16px}}

/* V14 — redesign completo do painel administrativo */
body.admin-ui{
  --bg:#070914;--card:#111525;--card2:#171c31;--text:#f8fafc;--muted:#9ca8c3;
  --p:#8b5cf6;--p2:#22d3ee;--d:#ef4444;--ok:#22c55e;--b:#28324b;
  min-height:100vh;
  background:
    radial-gradient(circle at 8% -10%,rgba(139,92,246,.28),transparent 34%),
    radial-gradient(circle at 93% 8%,rgba(34,211,238,.16),transparent 28%),
    linear-gradient(160deg,#060812 0%,#0a0d19 48%,#070914 100%);
}
body.admin-ui:before,body.admin-ui:after{content:"";position:fixed;pointer-events:none;z-index:-1;border-radius:999px;filter:blur(80px);opacity:.3}
body.admin-ui:before{width:280px;height:280px;left:-90px;bottom:8%;background:#7c3aed}
body.admin-ui:after{width:240px;height:240px;right:-70px;top:18%;background:#0891b2}
.admin-ui .wrap{max-width:1500px;padding:30px 34px 54px}
.admin-ui .app-header{position:relative;overflow:hidden;align-items:center;padding:24px 28px;border:1px solid rgba(139,92,246,.34);border-radius:28px;background:linear-gradient(135deg,rgba(23,28,49,.96),rgba(13,17,31,.94));box-shadow:0 22px 70px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.05)}
.admin-ui .app-header:after{content:"";position:absolute;inset:0 auto 0 0;width:5px;background:linear-gradient(#a78bfa,#22d3ee)}
.admin-ui .app-header h1{font-size:clamp(32px,4vw,50px);letter-spacing:-.045em;background:linear-gradient(90deg,#fff,#d8b4fe 55%,#a5f3fc);-webkit-background-clip:text;background-clip:text;color:transparent}
.admin-ui .app-header .sub{margin-top:7px;font-size:14px;color:#aeb8cf}
.admin-ui .app-header .pill{border:1px solid rgba(34,197,94,.45);background:rgba(34,197,94,.10);color:#bbf7d0;padding:11px 16px;box-shadow:0 0 0 4px rgba(34,197,94,.05)}
.admin-ui .grid{grid-template-columns:minmax(0,1.38fr) minmax(360px,.62fr);gap:22px;margin-top:22px;align-items:start}
.admin-ui .card{position:relative;background:linear-gradient(180deg,rgba(17,21,37,.96),rgba(10,13,25,.96));border:1px solid rgba(93,107,145,.34);border-radius:26px;box-shadow:0 18px 55px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.035);backdrop-filter:blur(16px)}
.admin-ui .arena-card,.admin-ui .events-card{padding:24px}
.admin-ui .arena-card:before,.admin-ui .events-card:before{content:"";position:absolute;left:24px;right:24px;top:0;height:2px;border-radius:999px;background:linear-gradient(90deg,#8b5cf6,transparent)}
.admin-ui .events-card:before{background:linear-gradient(90deg,#22d3ee,transparent)}
.admin-ui .arena-card>.top{display:grid;grid-template-columns:minmax(240px,.76fr) minmax(0,1.24fr);gap:18px;align-items:start}
.admin-ui .arena-card>.top>div:first-child{padding:17px 18px;border:1px solid rgba(139,92,246,.24);border-radius:19px;background:linear-gradient(145deg,rgba(139,92,246,.10),rgba(34,211,238,.035))}
.admin-ui .arena-card .phase{color:#c4b5fd}
.admin-ui #status{font-size:21px!important;margin-top:4px}
.admin-ui #counts{margin-top:7px;line-height:1.45}
.admin-ui .controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.admin-ui button,.admin-ui .btn{min-height:44px;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:10px 13px;background:linear-gradient(180deg,#8b5cf6,#6d3ce7);box-shadow:0 8px 20px rgba(109,60,231,.18);font-size:13px;letter-spacing:.005em;transition:transform .16s ease,filter .16s ease,border-color .16s ease,box-shadow .16s ease}
.admin-ui button:hover,.admin-ui .btn:hover{transform:translateY(-1px);filter:brightness(1.08);border-color:rgba(255,255,255,.18);box-shadow:0 12px 24px rgba(0,0,0,.24)}
.admin-ui button:active,.admin-ui .btn:active{transform:translateY(0)}
.admin-ui button.ok{background:linear-gradient(180deg,#34d399,#16a34a);color:#04130b;box-shadow:0 8px 20px rgba(34,197,94,.18)}
.admin-ui button.danger{background:linear-gradient(180deg,#fb7185,#dc2626);color:white;box-shadow:0 8px 20px rgba(239,68,68,.18)}
.admin-ui button.secondary{background:linear-gradient(180deg,#2b344d,#20283e);color:#e7ecf7;box-shadow:none}
.admin-ui .two{margin:22px 0!important;padding:14px;border:1px solid rgba(93,107,145,.3);border-radius:18px;background:rgba(8,11,22,.72);grid-template-columns:minmax(0,1fr) 125px;gap:10px}
.admin-ui input,.admin-ui select,.admin-ui textarea{min-height:46px;background:#090d19;border:1px solid #303b58;border-radius:13px;color:#f8fafc;padding:12px 13px;box-shadow:inset 0 1px 0 rgba(255,255,255,.025);transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.admin-ui textarea{min-height:112px;resize:vertical}
.admin-ui input:focus,.admin-ui select:focus,.admin-ui textarea:focus{outline:none;border-color:#8b5cf6;background:#0b1020;box-shadow:0 0 0 4px rgba(139,92,246,.13)}
.admin-ui input::placeholder,.admin-ui textarea::placeholder{color:#64708c}
.admin-ui #participantsBox{margin-top:22px}
.admin-ui #participantsBox h2,.admin-ui .events-title{font-size:19px;letter-spacing:-.02em;margin:0 0 14px}
.admin-ui #participantsBox h2:after,.admin-ui .events-title:after{content:"";display:block;width:36px;height:3px;border-radius:99px;margin-top:8px;background:linear-gradient(90deg,#8b5cf6,#22d3ee)}
.admin-ui .players{grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:11px}
.admin-ui .player{min-height:72px;border:1px solid rgba(93,107,145,.32);background:linear-gradient(145deg,rgba(27,33,56,.96),rgba(16,20,36,.96));border-radius:17px;padding:12px;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}
.admin-ui .player:hover{transform:translateY(-2px);border-color:rgba(139,92,246,.55);box-shadow:0 12px 25px rgba(0,0,0,.25)}
.admin-ui .player .avatar,.admin-ui .player .fake{width:48px;height:48px;border-radius:14px;border:1px solid rgba(167,139,250,.4);box-shadow:0 7px 16px rgba(0,0,0,.25)}
.admin-ui .district{color:#a5b4fc}.admin-ui .name{font-size:14px}.admin-ui .kills{margin-top:3px}
.admin-ui .events-card{background:linear-gradient(180deg,rgba(13,21,35,.97),rgba(8,13,24,.97))}
.admin-ui .auto-time-bar{grid-template-columns:minmax(0,1fr) auto;gap:12px;margin:0 0 16px;padding:15px;border:1px solid rgba(34,211,238,.24);border-radius:18px;background:linear-gradient(145deg,rgba(34,211,238,.065),rgba(139,92,246,.045))}
.admin-ui .auto-time-field label{color:#b9f3fb;letter-spacing:.02em}
.admin-ui .auto-time-input{grid-template-columns:minmax(80px,120px) auto}
.admin-ui .auto-time-status{padding-top:3px;color:#95a6c6;font-weight:650;line-height:1.45}
.admin-ui .logs{max-height:760px;gap:11px;padding-right:4px;scrollbar-width:thin;scrollbar-color:#3b4767 transparent}
.admin-ui .logs:empty{min-height:190px;border:1px dashed rgba(93,107,145,.3);border-radius:18px;background:rgba(6,9,17,.42)}
.admin-ui .log{border:1px solid rgba(93,107,145,.3);background:linear-gradient(145deg,#11182a,#0d1322);border-radius:18px;padding:15px;box-shadow:0 10px 25px rgba(0,0,0,.18)}
.admin-ui .log.death{border-color:rgba(239,68,68,.45);background:linear-gradient(145deg,rgba(63,20,31,.82),rgba(28,13,23,.9))}
.admin-ui .fold-card{margin-top:22px!important;padding:0;overflow:hidden;border-radius:24px;border:1px solid rgba(93,107,145,.34);box-shadow:0 16px 45px rgba(0,0,0,.28)}
.admin-ui .fold-card>summary{min-height:86px;padding:18px 22px;background:linear-gradient(110deg,rgba(27,33,56,.96),rgba(14,18,32,.96));border:0;transition:background .18s ease}
.admin-ui .fold-card>summary:hover{background:linear-gradient(110deg,rgba(35,42,70,.98),rgba(17,22,39,.98))}
.admin-ui .fold-card>summary:before{content:"";width:5px;height:42px;flex:0 0 5px;border-radius:99px;background:linear-gradient(#a78bfa,#22d3ee);box-shadow:0 0 18px rgba(139,92,246,.38)}
.admin-ui .prize-fold>summary:before{background:linear-gradient(#fbbf24,#f97316)}
.admin-ui .story-fold>summary:before{background:linear-gradient(#a78bfa,#ec4899)}
.admin-ui .event-fold>summary:before{background:linear-gradient(#22d3ee,#3b82f6)}
.admin-ui .fold-heading h2{margin:4px 0 0;font-size:20px;letter-spacing:-.02em}
.admin-ui .fold-heading .phase{font-size:10px;color:#fbbf24}
.admin-ui .fold-arrow{width:44px;height:44px;border:1px solid #3a4667;border-radius:14px;background:#0d1322;color:#dbeafe;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.admin-ui .fold-arrow:before{font-size:29px}
.admin-ui .fold-card[open] .fold-arrow{background:linear-gradient(180deg,#8b5cf6,#6d3ce7);border-color:#9d78ff;box-shadow:0 8px 20px rgba(109,60,231,.25)}
.admin-ui .fold-body{padding:22px;border-top:1px solid rgba(93,107,145,.24);background:rgba(7,10,20,.58)}
.admin-ui .automatic-story-generator{margin:0 0 20px;padding:20px;border:1px solid rgba(236,72,153,.28);border-radius:20px;background:radial-gradient(circle at 95% 0,rgba(236,72,153,.16),transparent 35%),linear-gradient(145deg,rgba(92,39,117,.34),rgba(18,15,35,.94));box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}
.admin-ui .automatic-story-generator h3{font-size:20px;margin:5px 0 7px}
.admin-ui .automatic-story-form{grid-template-columns:minmax(240px,1fr) auto;gap:11px}
.admin-ui .scenario-help{border:1px solid rgba(139,92,246,.25);border-left:4px solid #8b5cf6;background:rgba(139,92,246,.07);border-radius:14px;padding:12px 14px}
.admin-ui .switch-row{border:1px solid rgba(93,107,145,.3);background:#0b1020;border-radius:15px;padding:12px 14px}
.admin-ui .switch-row:hover{border-color:rgba(139,92,246,.46)}
.admin-ui .scenario-card,.admin-ui .child-card,.admin-ui .trophy-row{border-color:rgba(93,107,145,.34);background:linear-gradient(145deg,#11172a,#0b101e);box-shadow:0 10px 26px rgba(0,0,0,.18)}
.admin-ui .scenario-head{background:linear-gradient(90deg,rgba(139,92,246,.11),rgba(34,211,238,.035));padding:15px}
.admin-ui .scenario-arrow{background:#222b43;border:1px solid #37415d}
.admin-ui .trophy-preview{border-color:rgba(251,191,36,.34);background:rgba(15,12,8,.58)}
.admin-ui hr{border:0!important;height:1px;background:linear-gradient(90deg,transparent,rgba(93,107,145,.5),transparent);margin:26px 0!important}
.admin-ui ::selection{background:#7c3aed;color:white}
@media(max-width:1120px){.admin-ui .grid{grid-template-columns:1fr}.admin-ui .arena-card>.top{grid-template-columns:1fr}.admin-ui .events-card{position:static}.admin-ui .controls{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:760px){.admin-ui .wrap{padding:16px 14px 36px}.admin-ui .app-header{padding:19px 18px}.admin-ui .app-header h1{font-size:31px}.admin-ui .controls{grid-template-columns:repeat(2,minmax(0,1fr))}.admin-ui .arena-card,.admin-ui .events-card{padding:17px}.admin-ui .fold-card>summary{min-height:76px;padding:15px 16px}.admin-ui .fold-body{padding:16px}.admin-ui .automatic-story-form{grid-template-columns:1fr}.admin-ui .two{grid-template-columns:1fr 92px}.admin-ui .players{grid-template-columns:1fr}.admin-ui .auto-time-bar{grid-template-columns:1fr}.admin-ui .auto-time-bar>button{width:100%}.admin-ui .scenario-create-grid,.admin-ui .scenario-edit-grid,.admin-ui .child-edit-grid,.admin-ui .admin-event-grid{grid-template-columns:1fr!important}}
</style></head><body class="${admin ? `admin-ui` : `public-ui`}"><div class="wrap"><div class="top app-header"><div><h1>Hunger Games da Live</h1><div class="sub">Participantes do chat, distritos, eventos, mortes e vencedor final.</div></div><div class="pill" id="statusPill">Carregando...</div></div>
<div class="grid"><section class="card arena-card"><div class="top"><div><div class="phase" id="phase">Arena</div><div style="font-size:18px;font-weight:950" id="status">Carregando...</div><div class="small" id="counts"></div>${admin ? `<div id="normalEventsStatus" class="small" style="margin-top:7px;font-weight:950"></div>` : ``}</div>${admin ? `<div class="controls"><button class="ok" onclick="act('start')">Iniciar automático</button><button class="secondary" onclick="act('next')">Próximo</button><button class="ok" onclick="act('auto_start')">Rodar sozinho</button><button class="secondary" onclick="act('auto_stop')">Parar automático</button><button class="danger" onclick="act('reset')">Resetar</button><button id="normalEventsToggle" class="danger" onclick="toggleNormalEvents()">Desativar eventos antigos</button><button class="secondary" onclick="act('adult_on')">Ligar +18</button><button class="secondary" onclick="act('adult_off')">Desligar +18</button><button class="secondary" onclick="act('add_all_chat')">Adicionar todos do chat</button><button class="secondary" onclick="refreshAvatars()">Atualizar fotos da Twitch</button><button class="secondary" onclick="openWinnerPrizePanel()">🏆 Prêmios</button><button class="secondary" onclick="seedAdultHeavy()">Adicionar +18 pesado</button></div>` : ``}</div>
${admin ? `<div class="two" style="margin:16px 0"><input id="manualName" placeholder="Adicionar participante manual"/><input id="manualDistrict" placeholder="Distrito" type="number" min="1" max="12"/><button style="grid-column:1/-1" onclick="addPlayer()">Adicionar participante</button></div>` : ``}
<div id="participantsBox" class="lobby-only admin-participants-visible"><h2>Participantes da partida</h2><div class="players" id="players"></div></div></section><aside class="card events-card"><h2 class="events-title">Eventos</h2>${admin ? `<div class="auto-time-bar"><div class="auto-time-field"><label for="autoInterval">Tempo entre os eventos automáticos</label><div class="auto-time-input"><input id="autoInterval" type="number" min="1" max="60" step="1" value="9" aria-label="Tempo entre eventos automáticos"><span>segundo(s)</span></div></div><button onclick="saveAutoInterval()">Salvar tempo</button><div id="autoIntervalStatus" class="small auto-time-status">Ao clicar em Iniciar, os eventos começam a rodar sozinhos. A página não acompanha nem rola até o evento novo.</div></div>` : ``}<div class="logs" id="logs"></div><div id="winnerPrizeBox" class="winner-prize ${admin ? `` : `public-winner-prize`} hidden"></div></aside></div>
${admin ? `<details id="winnerPrizeAdminCard" class="card fold-card prize-fold" style="margin-top:18px;border-color:#7e22ce;box-shadow:0 18px 60px #581c8730"><summary><div class="fold-heading"><div class="phase">NOVA CONFIGURAÇÃO</div><h2>🏆 Prêmio do vencedor</h2></div><span class="fold-arrow" aria-hidden="true"></span></summary><div id="winnerPrizeAdminContent" class="fold-body"><div class="small">Envie suas imagens de prêmio. Quando a partida terminar, o jogo escolhe uma delas aleatoriamente e mostra abaixo do vencedor, no final dos eventos da página pública.</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px"><label class="switch-row"><input id="winnerPrizeEnabled" type="checkbox" onchange="saveWinnerPrizeSettings(true)"><span><b>Ativar prêmio do vencedor</b><br><span class="small">Desative se não quiser usar imagens de prêmio nesta arena.</span></span></label><div class="small" style="display:flex;align-items:center;justify-content:center;border:1px solid var(--b);border-radius:14px;padding:10px;background:#0d0d16">Use <b style="margin:0 4px">{vencedor}</b> para o nome do vencedor e <b style="margin:0 4px">{premio}</b> para o nome do prêmio.</div></div><textarea id="winnerPrizeText" placeholder="🏆 {vencedor}, você ganhou! O seu prêmio é: {premio}" style="margin-top:10px"></textarea><div class="wide-actions"><button onclick="saveWinnerPrizeSettings(false)">Salvar texto e ativação</button></div><div id="winnerPrizeSaveStatus" class="prize-save-status">Configuração salva no canal e mantida nas próximas partidas.</div><hr style="border-color:var(--b);margin:24px 0"><h3>Adicionar novo prêmio</h3><div class="trophy-admin-grid"><input id="trophyTitle" placeholder="Nome do prêmio, ex: Nave alienígena dourada"><div><input id="trophyImageFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange="readTrophyImage(this,'trophyImageData','trophyImagePreview')"><input id="trophyImageData" type="hidden"></div><button onclick="addTrophy()">Adicionar prêmio</button></div><div id="trophyImagePreview" class="trophy-preview" style="margin-top:10px">Prévia da imagem</div><hr style="border-color:var(--b);margin:24px 0"><div class="top"><div><h2>Prêmios cadastrados</h2><div class="small">Você pode deixar vários ativos; o jogo sorteia um aleatoriamente quando houver vencedor.</div></div><button class="secondary" onclick="loadTrophies()">Recarregar prêmios</button></div><div id="trophiesEditor" style="display:flex;flex-direction:column;gap:12px;margin-top:14px"></div></div></details>` : ``}
${admin ? `<details class="card story-card fold-card story-fold" style="margin-top:18px"><summary><div class="fold-heading"><h2>Modo História</h2></div><span class="fold-arrow" aria-hidden="true"></span></summary><div id="storyModeContent" class="fold-body"><div class="automatic-story-generator"><div class="phase">GERADOR AUTOMÁTICO</div><h3>Criar uma história misturando várias categorias</h3><div class="small">Digite duas ou mais categorias separadas por <b>+</b> ou vírgula. Exemplo: <b>Vampiro + Terror + Apocalipse</b>. Todas entram na mesma história e se alternam nos capítulos e nas mortes.</div><div class="automatic-story-form"><div><input id="storyCategory" list="storyCategorySuggestions" placeholder="Ex.: vampiro + terror + apocalipse" maxlength="180" autocomplete="off"><datalist id="storyCategorySuggestions"><option value="Vampiro + Terror"></option><option value="Vampiro + Terror + Apocalipse"></option><option value="Terror + Zumbi"></option><option value="Apocalipse + Zumbi"></option></datalist></div><button id="generateStoryButton" onclick="generateStory()">Gerar história misturada</button></div><div id="storyGeneratorStatus" class="small automatic-story-status">As categorias são combinadas na mesma sequência. A quantidade de mortes continua sendo calculada pelos participantes vivos; mortos não voltam e o último sobrevivente permanece vencedor.</div></div><div class="scenario-help"><b>Criação manual:</b> continue usando os campos abaixo quando quiser escrever a introdução e os acontecimentos por conta própria.</div><div class="small">Na seleção de pessoas, escolha <b>Todos</b> para colocar todos os participantes vivos na mesma cena. No texto, use <b>{p}</b> ou <b>{todos}</b> para mostrar todos os nomes.</div>
<input id="scName" style="margin-top:12px" placeholder="Nome da história: Invasão alienígena"/>
<div class="scenario-create-grid"><select id="scPhase"><option value="bloodbath">Cornucópia</option><option value="day">Dia</option><option value="night">Noite</option><option value="feast">Banquete</option><option value="arena" selected>Evento da arena</option></select><select id="scType"><option value="neutral">Neutro</option><option value="death">Morte</option><option value="item">Item</option><option value="alliance">Aliança</option><option value="adult">Adulto</option></select><input id="scPlayers" class="player-count-input" type="text" value="Todos" placeholder="Número ou Todos" title="Digite qualquer número inteiro ou Todos" autocomplete="off"/><input id="scKills" placeholder="Mortes: p2"/><select id="scAdult"><option value="0">Normal</option><option value="1">+18</option></select></div>
<textarea id="scText" placeholder="Um ET invade a arena diante de {p}."></textarea><span class="small player-count-note">Digite qualquer quantidade, como 8, 20 ou 100. Para usar todos os vivos, escreva Todos. Eventos para Todos não usam o campo Mortes.</span>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><label class="switch-row"><input id="scMix" type="checkbox" checked/><span><b>Misturar com eventos normais</b><br><span class="small">Desligue para usar somente os eventos desta história.</span></span></label><label class="switch-row"><input id="scActive" type="checkbox" checked/><span><b>História ativa</b><br><span class="small">Desligue para impedir que ela seja sorteada.</span></span></label></div>
<button style="margin-top:10px" onclick="addScenario()">Criar história</button><hr style="border-color:var(--b);margin:24px 0"><div class="top"><div><h2>Histórias criadas</h2><div class="small">Clique na seta para expandir ou encolher e editar os eventos internos.</div></div><button class="secondary" onclick="loadScenarios()">Recarregar histórias</button></div><div id="scenariosEditor" style="display:flex;flex-direction:column;gap:12px;margin-top:14px"></div></div></details>
<details class="card fold-card event-fold" style="margin-top:18px"><summary><div class="fold-heading"><h2>Adicionar evento normal</h2></div><span class="fold-arrow" aria-hidden="true"></span></summary><div id="normalEventsContent" class="fold-body"><div class="small">Digite qualquer quantidade de pessoas. Use {p1}, {p2}, {p10} e assim por diante. Para todos os vivos, escreva Todos e use {p} ou {todos}. Em Mortes, use p2 ou p1,p3,p10.</div><div class="admin-event-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:12px"><select id="evPhase"><option value="bloodbath">Cornucópia</option><option value="day">Dia</option><option value="night">Noite</option><option value="feast">Banquete</option><option value="arena">Evento da arena</option></select><select id="evType"><option value="neutral">Neutro</option><option value="death">Morte</option><option value="item">Item</option><option value="alliance">Aliança</option><option value="adult">Adulto</option></select><input id="evPlayers" class="player-count-input" type="text" value="1" placeholder="Número ou Todos" title="Digite qualquer número inteiro ou Todos" autocomplete="off"/><input id="evKills" placeholder="Mortes: p2"/><select id="evAdult"><option value="0">Normal</option><option value="1">+18</option></select></div><textarea id="evText" placeholder="{p1} faz alguma coisa com {p2}."></textarea><button onclick="addEvent()">Salvar evento</button><hr style="border-color:var(--b);margin:24px 0"><div class="top"><div><h2>Editar eventos existentes</h2><div class="small">Aqui edita, desativa ou exclui os eventos que já estão cadastrados.</div></div><button class="secondary" onclick="loadEvents()">Recarregar eventos</button></div><div id="eventsEditor" style="display:flex;flex-direction:column;gap:12px;margin-top:14px"></div></div></details>` : ``}</div>
<script>
const params=new URLSearchParams(location.search),channel=params.get("channel")||"icarolinaporto",token=params.get("token")||"",admin=${admin?"true":"false"};
const statusLabels={lobby:"AGUARDANDO",running:"EM ANDAMENTO",ended:"ENCERRADA",archived:"ARQUIVADA"};
const phaseLabels={any:"Qualquer fase",bloodbath:"Cornucópia",day:"Dia",night:"Noite",feast:"Banquete",arena:"Evento da arena",story:"Modo História",reaping:"Início da arena",winner:"Vencedor"};
const typeLabels={neutral:"Neutro",death:"Morte",item:"Item",alliance:"Aliança",adult:"Adulto"};
const DEFAULT_WINNER_PRIZE_TEXT="🏆 {vencedor}, você ganhou! O seu prêmio é: {premio}";
function phaseLabel(phase,day){const p=phaseLabels[phase]||phase||"Arena";if(["day","night","feast"].includes(phase))return p+" "+(day||1);return p}
function typeLabel(type){return typeLabels[type]||type||"Neutro"}
function playerInput(id,value){const n=Number(value);const shown=n===0?"Todos":String(Number.isFinite(n)&&n>=1?Math.round(n):1);return '<input id="'+id+'" class="player-count-input" type="text" value="'+esc(shown)+'" placeholder="Número ou Todos" title="Digite qualquer número inteiro ou Todos" autocomplete="off">'}
function playerLabel(value){const n=Number(value);if(n===0)return "Todos";const amount=Number.isFinite(n)&&n>=1?Math.round(n):1;return amount===1?"1 pessoa":String(amount)+" pessoas"}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[m]))}
async function api(path,opt={}){const sep=path.includes("?")?"&":"?";const url=path+sep+"channel="+encodeURIComponent(channel)+(token?"&token="+encodeURIComponent(token):"");const r=await fetch(url,{cache:"no-store",...opt}),ct=r.headers.get("content-type")||"";return ct.includes("json")?r.json():r.text()}
function avatarHtml(p,cls="avatar"){const initial=esc(((p&&p.display_name)||"?").slice(0,1).toUpperCase());const name=esc((p&&p.display_name)||"Participante");const login=String((p&&p.username)||"").trim();const stored=String((p&&p.avatar_url)||"").trim();const src=login?("/hg/avatar/"+encodeURIComponent(login)+"?v=10"):stored;return src?'<span class="avatar-wrap"><img class="'+cls+'" src="'+esc(src)+'" alt="Foto de '+name+'" loading="eager" referrerpolicy="no-referrer" onerror="this.hidden=true;this.style.display=&quot;none&quot;;this.nextElementSibling.hidden=false;this.nextElementSibling.style.display=&quot;flex&quot;"><span class="'+cls+' fake" hidden style="display:none">'+initial+'</span></span>':'<span class="avatar-wrap"><span class="'+cls+' fake">'+initial+'</span></span>'}
function mentionedPlayers(text,players){const found=[];const lower=String(text||"").toLowerCase();players.forEach(p=>{const names=[p.display_name,p.username].map(v=>String(v||"").trim().toLowerCase()).filter(Boolean);if(names.some(nm=>lower.includes(nm))&&!found.some(x=>Number(x.id)===Number(p.id)))found.push(p)});return found}
function logParticipants(log,players){const ids=[...new Set(String(log?.participant_ids||"").split(",").map(v=>Number(v.trim())).filter(id=>Number.isFinite(id)&&id>0))];if(ids.length){const byId=new Map((players||[]).map(p=>[Number(p.id),p]));const exact=ids.map(id=>byId.get(id)).filter(Boolean);if(exact.length)return exact}return mentionedPlayers(log?.text,players||[])}
const AUTO_INTERVAL_KEY="hgAutoIntervalV60";
let autoIntervalServerSignature="",autoIntervalSaving=false;
function normalizedAutoIntervalMs(value){const seconds=Math.max(1,Math.min(60,Number(value)||9));return Math.round(seconds*1000)}
function applyServerAutoInterval(value){const ms=Math.max(1000,Math.min(60000,Number(value)||9000));const signature=String(ms);if(signature===autoIntervalServerSignature)return;autoIntervalServerSignature=signature;try{localStorage.setItem(AUTO_INTERVAL_KEY,String(ms))}catch{}const input=document.getElementById("autoInterval");if(input&&document.activeElement!==input)input.value=String(ms/1000)}
async function saveAutoInterval(){if(!admin)return;if(!token)return alert("Abra com ?token=SEU_TOKEN");if(autoIntervalSaving)return;const input=document.getElementById("autoInterval"),status=document.getElementById("autoIntervalStatus");const ms=normalizedAutoIntervalMs(input?.value);if(input)input.value=String(ms/1000);if(status)status.textContent="Salvando o tempo do automático...";autoIntervalSaving=true;try{const result=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"set_auto_interval",event_delay_ms:ms})});if(status)status.textContent=String(result)+" A tela continuará parada onde você deixou.";try{localStorage.setItem(AUTO_INTERVAL_KEY,String(ms))}catch{}await load()}catch(e){if(status)status.textContent="Não foi possível salvar o tempo."}finally{autoIntervalSaving=false}}
let timelineGameId=null,timelineInitialized=false,timelinePlayers=[];
const timelineKnownIds=new Set();
function eventCardHtml(l,players,extra=""){const ps=logParticipants(l,players);const avs=ps.length?'<div class="event-avatars">'+ps.map(p=>'<div class="event-person">'+avatarHtml(p,"avatar")+'</div>').join("")+'</div>':'';return '<div class="log '+(l.deaths?'death ':'')+extra+'" data-log-id="'+Number(l.id||0)+'"><div class="phase">'+esc(phaseLabel(l.phase,l.day_number))+'</div>'+avs+'<div class="event-text">'+esc(l.text)+'</div>'+(l.deaths?'<div class="small">Mortes: '+esc(l.deaths)+'</div>':'')+'</div>'}
function preserveViewport(action){const x=window.scrollX||0,y=window.scrollY||0;action();requestAnimationFrame(()=>{const nowX=window.scrollX||0,nowY=window.scrollY||0;if(Math.abs(nowX-x)>1||Math.abs(nowY-y)>1)window.scrollTo({left:x,top:y,behavior:"auto"})})}
function clearTimelinePlayback(){timelineKnownIds.clear()}
function renderTimelineHistory(logs,players,status){const box=document.getElementById("logs");const list=(Array.isArray(logs)?logs:[]).slice().sort((a,b)=>Number(a.id)-Number(b.id));preserveViewport(()=>{box.innerHTML=list.map(l=>eventCardHtml(l,players)).join("")||"<div class='small' id='timelineEmpty'>Sem eventos ainda.</div>";document.querySelectorAll(".event-name").forEach(e=>e.remove())});timelineKnownIds.clear();for(const l of list)timelineKnownIds.add(Number(l.id))}
function appendTimelineEvent(log){const box=document.getElementById("logs");const selector='[data-log-id="'+Number(log.id||0)+'"]';const existing=box.querySelector(selector);if(existing)return existing;let added=null;preserveViewport(()=>{document.getElementById("timelineEmpty")?.remove();box.insertAdjacentHTML("beforeend",eventCardHtml(log,timelinePlayers,"event-sync-enter"));document.querySelectorAll(".event-name").forEach(e=>e.remove());added=box.querySelector(selector)});if(added)setTimeout(()=>added.classList.remove("event-sync-enter"),450);return added}
function syncEventTimeline(gameId,logs,players,status){const id=Number(gameId||0),list=(Array.isArray(logs)?logs:[]).slice().sort((a,b)=>Number(a.id)-Number(b.id));timelinePlayers=Array.isArray(players)?players:[];if(!timelineInitialized||timelineGameId!==id){clearTimelinePlayback();timelineGameId=id;timelineInitialized=true;renderTimelineHistory(list,timelinePlayers,status);return}for(const log of list){const logId=Number(log.id||0);if(!logId||timelineKnownIds.has(logId))continue;timelineKnownIds.add(logId);appendTimelineEvent(log)}}
let loadInProgress=false,loadAgain=false;
async function load(){
  if(loadInProgress){loadAgain=true;return}
  loadInProgress=true;
  try{
    const st=await api("/hg/state");if(!st||st.error){const status=document.getElementById("status");if(status)status.textContent="Não foi possível carregar a partida.";return}const g=st.game||{},players=Array.isArray(st.players)?st.players:[],logs=Array.isArray(st.logs)?st.logs:[];applyServerAutoInterval(st.autoIntervalMs||9000);document.body.classList.toggle("hg-running",!admin&&(g.status==="running"||g.status==="ended"));document.getElementById("statusPill").textContent=(statusLabels[g.status]||"AGUARDANDO")+(g.adult_mode?" • +18":"");document.getElementById("phase").textContent=phaseLabel(g.phase||"bloodbath",g.day_number||1);document.getElementById("status").textContent=g.status==="running"?"Partida em andamento":g.status==="ended"?("Vencedor: "+(g.winner||"ninguém")):"Aguardando participantes";const alive=players.filter(p=>Number(p.alive)===1).length;document.getElementById("counts").textContent=players.length+" participantes • "+alive+" vivos • "+Number(st.eventCount||0)+(Number(g.normal_events_enabled??1)===1?" eventos ativos":" eventos de história")+(st.activeScenario?" • História: "+st.activeScenario.name:"")+(st.autoRunning?" • automático ligado":"");try{renderWinnerPrize(st.winnerPrize||{},g.winner||"",g.status||"",players);setWinnerPrizeControls(st.winnerPrize||{})}catch(e){console.error("Falha ao exibir prêmio:",e)}normalEventsCurrentlyEnabled=Number(g.normal_events_enabled??1)===1;if(admin){const toggle=document.getElementById("normalEventsToggle"),label=document.getElementById("normalEventsStatus");if(toggle){toggle.textContent=normalEventsCurrentlyEnabled?"Desativar eventos antigos":"Ativar eventos antigos";toggle.className=normalEventsCurrentlyEnabled?"danger":"ok"}if(label){label.textContent=normalEventsCurrentlyEnabled?"⚠️ Eventos normais/antigos: ATIVADOS":"✅ Modo História exclusivo: eventos normais/antigos DESATIVADOS";label.style.color=normalEventsCurrentlyEnabled?"#fca5a5":"#86efac"}}
const box=document.getElementById("participantsBox");if(box)box.classList.toggle("hidden",!admin&&g.status==="running");
const playersElement=document.getElementById("players");if(playersElement)playersElement.innerHTML=players.map(p=>{const av=avatarHtml(p);return '<div class="player '+(Number(p.alive)===1?'':'dead')+'">'+av+'<div><div class="district">Distrito '+p.district+'</div><div class="name">'+esc(p.display_name||p.username||"Participante")+'</div><div class="kills">'+(p.kills||0)+' abate(s) '+(Number(p.alive)===1?'🟢':'💀')+'</div></div></div>'}).join("")||"<div class='small'>Nenhum participante foi adicionado nesta partida.</div>";
syncEventTimeline(g.id||0,logs,players,g.status)  }catch(e){console.error("Falha ao atualizar a página:",e);const status=document.getElementById("status");if(status)status.textContent="Não foi possível atualizar a partida. Atualize a página."}finally{
    loadInProgress=false;
    if(loadAgain){loadAgain=false;queueMicrotask(load)}
  }
}

function openWinnerPrizePanel(){const box=document.getElementById("winnerPrizeAdminCard");if(!box)return;box.open=true;box.scrollIntoView({behavior:"smooth",block:"start"});box.animate([{outline:"4px solid #c084fc"},{outline:"0 solid transparent"}],{duration:1200,easing:"ease-out"})}
function safePrizeImageSrc(src){src=String(src||"").trim();return src.toLowerCase().startsWith("data:image/")?src:""}
function winnerPrizeMessage(prize,winner){const template=String(prize?.text||DEFAULT_WINNER_PRIZE_TEXT);const reward=String(prize?.trophyTitle||"prêmio surpresa");return template.replace(/\{winner\}/gi,winner||"vencedor").replace(/\{vencedor\}/gi,winner||"vencedor").replace(/\{premio\}/gi,reward)}
function renderWinnerPrize(prize,winner,status,players=[]){const box=document.getElementById("winnerPrizeBox");if(!box)return;const winnerName=String(winner||"").trim();const ended=status==="ended"&&winnerName;box.classList.toggle("hidden",!ended);if(!ended){box.innerHTML="";return}const winnerKey=winnerName.toLowerCase();const winnerPlayer=(Array.isArray(players)?players:[]).find(p=>String(p?.display_name||"").trim().toLowerCase()===winnerKey||String(p?.username||"").trim().toLowerCase()===winnerKey)||null;const winnerPhoto='<div class="winner-player-photo"><div class="winner-player-photo-label">Vencedor</div>'+avatarHtml(winnerPlayer||{display_name:winnerName},"winner-player-avatar")+'</div>';const enabled=Number(prize?.enabled??1)===1;const img=safePrizeImageSrc(prize?.trophyImage);const reward=String(prize?.trophyTitle||"Prêmio surpresa");const winnerTitle='<div class="winner-prize-text">🏆 '+esc(winnerName)+' venceu a arena!</div>';if(enabled&&img){box.innerHTML=winnerTitle+winnerPhoto+'<div class="winner-prize-text">'+esc(winnerPrizeMessage(prize,winnerName))+'</div><div class="winner-prize-title">🎁 '+esc(reward)+'</div><img src="'+img+'" alt="Prêmio do vencedor"><div class="winner-prize-sub">O prêmio foi escolhido aleatoriamente entre as imagens ativas.</div>';return}const reason=enabled?'Nenhuma imagem de prêmio ativa foi encontrada.':'O sistema de prêmio está desativado.';box.innerHTML=winnerTitle+winnerPhoto+'<div class="winner-prize-sub">'+esc(reason)+'</div>'}
let winnerPrizeControlsInitialized=false,winnerPrizeSettingsSaving=false;
function setWinnerPrizeControls(prize){if(!admin||winnerPrizeControlsInitialized)return;const enabled=document.getElementById("winnerPrizeEnabled"),text=document.getElementById("winnerPrizeText");if(enabled)enabled.checked=Number(prize?.enabled??1)===1;if(text)text.value=String(prize?.text||DEFAULT_WINNER_PRIZE_TEXT).replace(/\{winner\}/gi,"{vencedor}");winnerPrizeControlsInitialized=true}
async function saveWinnerPrizeSettings(silent=false){if(!token)return alert("Abra com ?token=SEU_TOKEN");if(winnerPrizeSettingsSaving)return;winnerPrizeSettingsSaving=true;const status=document.getElementById("winnerPrizeSaveStatus"),enabled=document.getElementById("winnerPrizeEnabled")?.checked?"1":"0",text=(document.getElementById("winnerPrizeText")?.value||DEFAULT_WINNER_PRIZE_TEXT).replace(/\{winner\}/gi,"{vencedor}");if(status)status.textContent="Salvando...";try{const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"set_winner_prize_settings",enabled,text})});if(status)status.textContent=String(t);if(!silent)alert(t)}catch(e){if(status)status.textContent="Não foi possível salvar. Tente novamente.";if(!silent)alert("Não foi possível salvar a configuração do prêmio.")}finally{winnerPrizeSettingsSaving=false}}
function trophyRow(t){const img=safePrizeImageSrc(t.image_data);return '<div class="trophy-row"><div class="preview">'+(img?'<img src="'+img+'" alt="Prêmio">':'<div class="small">Sem imagem</div>')+'</div><div><input id="tr_title_'+t.id+'" value="'+esc(t.title||"")+'" placeholder="Nome do prêmio"><div class="wide-actions" style="margin-top:8px"><label class="switch-row"><input id="tr_active_'+t.id+'" type="checkbox" '+(t.active?"checked":"")+'><span>Prêmio ativo</span></label><input id="tr_file_'+t.id+'" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange="readTrophyImage(this,&quot;tr_data_'+t.id+'&quot;,&quot;tr_preview_'+t.id+'&quot;)"><input id="tr_data_'+t.id+'" type="hidden"></div><div id="tr_preview_'+t.id+'" class="trophy-preview" style="margin-top:10px;min-height:90px">Selecione outra imagem apenas se quiser trocar a atual.</div><div class="actions"><button onclick="saveTrophy('+t.id+')">Salvar prêmio</button><button class="danger" onclick="deleteTrophy('+t.id+')">Excluir</button></div></div></div>'}
async function loadTrophies(){if(!admin)return;const box=document.getElementById("trophiesEditor");if(!box)return;box.innerHTML="<div class='small'>Carregando prêmios...</div>";try{const rows=await api("/hg/trophies");if(!Array.isArray(rows)){box.innerHTML="<div class='small'>Não foi possível carregar os prêmios.</div>";return}box.innerHTML=rows.map(trophyRow).join("")||"<div class='small'>Nenhum prêmio cadastrado ainda.</div>"}catch(e){console.error("Falha ao carregar prêmios:",e);box.innerHTML="<div class='small'>Não foi possível carregar os prêmios. Atualize a página.</div>"}}
function readTrophyImage(input,hiddenId,previewId){const file=input?.files?.[0],hidden=document.getElementById(hiddenId),preview=document.getElementById(previewId);if(!file){if(hidden)hidden.value="";if(preview)preview.innerHTML="Prévia da imagem";return}if(file.size>8*1024*1024){alert("A imagem é grande demais. Escolha uma imagem de até 8 MB.");input.value="";if(hidden)hidden.value="";return}const reader=new FileReader();reader.onload=()=>{const original=String(reader.result||"");const img=new Image();img.onload=()=>{try{const limite=1400,escala=Math.min(1,limite/Math.max(img.width||1,img.height||1)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round((img.width||1)*escala));canvas.height=Math.max(1,Math.round((img.height||1)*escala));canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);let data=canvas.toDataURL("image/webp",.86);if(!data.startsWith("data:image/webp"))data=canvas.toDataURL("image/jpeg",.88);if(hidden)hidden.value=data;if(preview)preview.innerHTML='<img src="'+data+'" alt="Prévia do prêmio">'}catch{if(hidden)hidden.value=original;if(preview)preview.innerHTML='<img src="'+original+'" alt="Prévia do prêmio">'}};img.onerror=()=>{alert("Não foi possível abrir essa imagem.");input.value="";if(hidden)hidden.value=""};img.src=original};reader.onerror=()=>alert("Não foi possível ler essa imagem.");reader.readAsDataURL(file)}
async function addTrophy(){const title=document.getElementById("trophyTitle")?.value?.trim()||"";const image_data=document.getElementById("trophyImageData")?.value||"";if(!title)return alert("Digite o nome do prêmio.");if(!image_data)return alert("Escolha a imagem do prêmio.");const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"add_trophy",title,image_data,active:"1"})});alert(t);document.getElementById("trophyTitle").value="";document.getElementById("trophyImageFile").value="";document.getElementById("trophyImageData").value="";document.getElementById("trophyImagePreview").innerHTML="Prévia da imagem";await loadTrophies()}
async function saveTrophy(id){const title=document.getElementById("tr_title_"+id)?.value?.trim()||"";if(!title)return alert("Digite o nome do prêmio.");const image_data=document.getElementById("tr_data_"+id)?.value||"";const active=document.getElementById("tr_active_"+id)?.checked?"1":"0";const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"update_trophy",id,title,image_data,active})});alert(t);await loadTrophies();await load()}
async function deleteTrophy(id){if(!confirm("Excluir este prêmio?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_trophy",id})});alert(t);await loadTrophies();await load()}

let actionBusy=false;
let normalEventsCurrentlyEnabled=true;
async function toggleNormalEvents(){
  if(!token)return alert("Abra com ?token=SEU_TOKEN");
  if(actionBusy)return;
  actionBusy=true;
  const turningOff=normalEventsCurrentlyEnabled;
  try{
    const action=turningOff?"normal_events_off":"normal_events_on";
    const t=await api("/hg/admin?action="+encodeURIComponent(action));
    if(turningOff){
      clearTimelinePlayback();
      timelineInitialized=false;
    }
    alert(t);
    await load();
  }finally{actionBusy=false}
}
async function act(a){if(!token)return alert("Abra com ?token=SEU_TOKEN");if(actionBusy)return;actionBusy=true;try{const t=await api("/hg/admin?action="+encodeURIComponent(a));alert(t);await load()}finally{actionBusy=false}}
async function seedAdultHeavy(){if(!confirm("Adicionar pacote de eventos +18 pesado ao banco?"))return;const t=await api("/hg/admin?action=seed_adult_heavy");alert(t);load();if(admin)loadEvents()}
async function addPlayer(){const name=document.getElementById("manualName").value.trim(),d=document.getElementById("manualDistrict").value.trim();if(!name)return alert("Digite o nome do participante.");const t=await api("/hg/admin?action=add_player&name="+encodeURIComponent(name)+"&district="+encodeURIComponent(d));alert(t);document.getElementById("manualName").value="";await load()}
async function refreshAvatars(){if(!admin)return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"refresh_avatars"})});alert(t);await load()}
async function addEvent(){const body={action:"add_event",phase:evPhase.value,type:evType.value,players:evPlayers.value,kills:evKills.value,adult:evAdult.value,text:evText.value};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);evText.value="";load();if(admin)loadEvents()}
function eventRow(e){return '<div class="log" style="max-width:none;margin:0"><div class="phase">ID '+e.id+' • '+esc(phaseLabels[e.phase]||e.phase)+' • '+esc(typeLabel(e.type))+' • '+esc(playerLabel(e.players))+' • '+(e.adult?"+18":"Normal")+' • '+(e.active?"Ativo":"Desativado")+'</div><div style="display:grid;grid-template-columns:120px 120px 80px 1fr 100px 100px;gap:8px;margin:8px 0"><select id="phase_'+e.id+'"><option value="bloodbath" '+(e.phase==="bloodbath"?"selected":"")+'>Cornucópia</option><option value="day" '+(e.phase==="day"?"selected":"")+'>Dia</option><option value="night" '+(e.phase==="night"?"selected":"")+'>Noite</option><option value="feast" '+(e.phase==="feast"?"selected":"")+'>Banquete</option><option value="arena" '+(e.phase==="arena"?"selected":"")+'>Evento da arena</option></select><select id="type_'+e.id+'"><option value="neutral" '+(e.type==="neutral"?"selected":"")+'>Neutro</option><option value="death" '+(e.type==="death"?"selected":"")+'>Morte</option><option value="item" '+(e.type==="item"?"selected":"")+'>Item</option><option value="alliance" '+(e.type==="alliance"?"selected":"")+'>Aliança</option><option value="adult" '+(e.type==="adult"?"selected":"")+'>Adulto</option></select>'+playerInput("players_"+e.id,e.players)+'<input id="kills_'+e.id+'" placeholder="Mortes" value="'+esc(e.kills||"")+'"><select id="adult_'+e.id+'"><option value="0" '+(!e.adult?"selected":"")+'>Normal</option><option value="1" '+(e.adult?"selected":"")+'>+18</option></select><select id="active_'+e.id+'"><option value="1" '+(e.active?"selected":"")+'>Ativo</option><option value="0" '+(!e.active?"selected":"")+'>Desativado</option></select></div><textarea id="text_'+e.id+'">'+esc(e.text)+'</textarea><div class="controls" style="margin-top:8px"><button onclick="saveEvent('+e.id+')">Salvar edição</button><button class="danger" onclick="deleteEvent('+e.id+')">Excluir</button></div></div>'}
async function loadEvents(){if(!admin)return;const box=document.getElementById("eventsEditor");if(!box)return;box.innerHTML="<div class='small'>Carregando eventos...</div>";const evs=await api("/hg/events");if(!Array.isArray(evs)){box.innerHTML="<div class='small'>Erro ao carregar eventos.</div>";return}box.innerHTML=evs.map(eventRow).join("")||"<div class='small'>Sem eventos cadastrados.</div>"}
async function saveEvent(id){const body={action:"update_event",id,phase:document.getElementById("phase_"+id).value,type:document.getElementById("type_"+id).value,players:document.getElementById("players_"+id).value,kills:document.getElementById("kills_"+id).value,adult:document.getElementById("adult_"+id).value,active:document.getElementById("active_"+id).value,text:document.getElementById("text_"+id).value};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);loadEvents();load()}
async function deleteEvent(id){if(!confirm("Excluir este evento?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_event",id})});alert(t);loadEvents();load()}
const openScenarios=new Set();
function phaseOptions(value,allowAny=false){const items=[];if(allowAny)items.push(["any","Qualquer fase"]);items.push(["bloodbath","Cornucópia"],["day","Dia"],["night","Noite"],["feast","Banquete"],["arena","Evento da arena"]);return items.map(x=>'<option value="'+x[0]+'" '+(value===x[0]?"selected":"")+'>'+x[1]+'</option>').join("")}
function typeOptions(value){return [["neutral","Neutro"],["death","Morte"],["item","Item"],["alliance","Aliança"],["adult","Adulto"]].map(x=>'<option value="'+x[0]+'" '+(value===x[0]?"selected":"")+'>'+x[1]+'</option>').join("")}
function toggleScenario(id){const body=document.getElementById("scenario_body_"+id),arrow=document.getElementById("scenario_arrow_"+id);if(!body)return;const opening=body.classList.contains("collapsed");body.classList.toggle("collapsed",!opening);arrow.textContent=opening?"▼":"▶";if(opening)openScenarios.add(id);else openScenarios.delete(id)}
async function generateStory(){const input=document.getElementById("storyCategory"),button=document.getElementById("generateStoryButton"),status=document.getElementById("storyGeneratorStatus");const category=String(input?.value||"").trim();if(!category){if(status)status.textContent="Digite as categorias, por exemplo: Vampiro + Terror + Apocalipse.";input?.focus();return}if(button){button.disabled=true;button.textContent="Misturando categorias..."}if(status)status.textContent="Criando uma única história com “"+category+"”, incluindo acontecimentos e mortes...";try{const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"generate_story",category})});if(status)status.textContent=String(t);if(String(t).startsWith("✅")){clearTimelinePlayback();timelineInitialized=false;await loadScenarios();await load()}}catch(e){if(status)status.textContent="Erro ao criar a história automática."}finally{if(button){button.disabled=false;button.textContent="Gerar história misturada"}}}
async function addScenario(){const g=id=>document.getElementById(id);const body={action:"add_scenario",name:g("scName").value,phase:g("scPhase").value,type:g("scType").value,players:g("scPlayers").value,kills:g("scKills").value,adult:g("scAdult").value,text:g("scText").value,mix_with_normal:g("scMix").checked?"1":"0",active:g("scActive").checked?"1":"0"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);if(String(t).startsWith("✅")){g("scName").value="";g("scText").value=""}await loadScenarios();load()}
function scenarioChildRow(c,sid){return '<div class="child-card"><div class="phase">EVENTO DA HISTÓRIA ID '+c.id+' • '+esc(phaseLabels[c.phase]||c.phase)+' • '+esc(typeLabel(c.type))+' • '+esc(playerLabel(c.players))+' • '+(c.active?"Ativo":"Desativado")+'</div><div class="child-edit-grid"><select id="sce_phase_'+c.id+'">'+phaseOptions(c.phase,true)+'</select><select id="sce_type_'+c.id+'">'+typeOptions(c.type)+'</select>'+playerInput("sce_players_"+c.id,c.players)+'<input id="sce_kills_'+c.id+'" placeholder="Mortes: p2" value="'+esc(c.kills||"")+'"><select id="sce_adult_'+c.id+'"><option value="0" '+(!c.adult?"selected":"")+'>Normal</option><option value="1" '+(c.adult?"selected":"")+'>+18</option></select></div><textarea id="sce_text_'+c.id+'">'+esc(c.text)+'</textarea><div class="wide-actions"><label class="switch-row"><input id="sce_active_'+c.id+'" type="checkbox" '+(c.active?"checked":"")+'><span>Evento decorrente ativo</span></label><button onclick="saveScenarioEvent('+c.id+','+sid+')">Salvar evento interno</button><button class="danger" onclick="deleteScenarioEvent('+c.id+','+sid+')">Excluir</button></div></div>'}
async function saveScenarioOptions(id){const mix=document.getElementById("sc_mix_"+id),active=document.getElementById("sc_active_"+id),status=document.getElementById("sc_options_status_"+id);if(!mix||!active)return;if(status)status.textContent="Salvando opções...";mix.disabled=true;active.disabled=true;try{const exclusive=!mix.checked&&active.checked;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"update_scenario_options",id,mix_with_normal:mix.checked?"1":"0",active:active.checked?"1":"0"})});if(exclusive){clearTimelinePlayback();timelineInitialized=false}if(status)status.textContent=String(t);openScenarios.add(Number(id));await load()}catch(e){if(status)status.textContent="Erro ao salvar as opções."}finally{mix.disabled=false;active.disabled=false}}
function scenarioRow(s){const opened=openScenarios.has(Number(s.id));const children=(s.events||[]).map(c=>scenarioChildRow(c,s.id)).join("")||'<div class="small">Nenhum evento decorrente criado. Use o formulário abaixo.</div>';return '<div class="scenario-card"><div class="scenario-head" onclick="toggleScenario('+s.id+')"><button class="scenario-arrow" id="scenario_arrow_'+s.id+'">'+(opened?"▼":"▶")+'</button><div class="scenario-title"><div style="font-weight:950;font-size:17px">'+esc(s.name)+'</div><div class="scenario-flags"><span class="flag">ID '+s.id+'</span><span class="flag">'+esc(phaseLabels[s.phase]||s.phase)+'</span><span class="flag">'+(s.mix_with_normal?"Mistura com normais":"Somente esta história")+'</span><span class="flag">'+(s.active?"Ativo":"Desativado")+'</span><span class="flag">'+esc(playerLabel(s.players))+'</span><span class="flag">'+(s.events||[]).length+' decorrente(s)</span></div></div></div><div id="scenario_body_'+s.id+'" class="scenario-body '+(opened?"":"collapsed")+'"><input id="sc_name_'+s.id+'" value="'+esc(s.name)+'"><div class="scenario-edit-grid"><select id="sc_phase_'+s.id+'">'+phaseOptions(s.phase,false)+'</select><select id="sc_type_'+s.id+'">'+typeOptions(s.type)+'</select>'+playerInput("sc_players_"+s.id,s.players)+'<input id="sc_kills_'+s.id+'" placeholder="Mortes: p2" value="'+esc(s.kills||"")+'"><select id="sc_adult_'+s.id+'"><option value="0" '+(!s.adult?"selected":"")+'>Normal</option><option value="1" '+(s.adult?"selected":"")+'>+18</option></select></div><textarea id="sc_text_'+s.id+'">'+esc(s.text)+'</textarea><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><label class="switch-row"><input id="sc_mix_'+s.id+'" type="checkbox" onchange="saveScenarioOptions('+s.id+')" '+(s.mix_with_normal?"checked":"")+'><span><b>Misturar com eventos normais</b><br><span class="small">Desligado: bloqueia os eventos antigos e usa somente esta história.</span></span></label><label class="switch-row"><input id="sc_active_'+s.id+'" type="checkbox" onchange="saveScenarioOptions('+s.id+')" '+(s.active?"checked":"")+'><span><b>História ativa</b><br><span class="small">Controla se o início pode ser sorteado.</span></span></label></div><div id="sc_options_status_'+s.id+'" class="small" style="margin-top:8px;color:#c4b5fd">As duas chaves são salvas automaticamente.</div><div class="wide-actions"><button onclick="saveScenario('+s.id+')">Salvar história</button><button class="secondary" onclick="restartScenario('+s.id+')">Reiniciar história agora</button><button class="danger" onclick="deleteScenario('+s.id+')">Excluir tudo</button></div><hr style="border-color:var(--b);margin:18px 0"><h3>Adicionar evento decorrente</h3><div class="small">No modo exclusivo, os acontecimentos seguem a ordem cadastrada e não esperam Dia ou Noite.</div><div class="child-edit-grid"><select id="new_sce_phase_'+s.id+'">'+phaseOptions("any",true)+'</select><select id="new_sce_type_'+s.id+'">'+typeOptions("neutral")+'</select>'+playerInput("new_sce_players_"+s.id,1)+'<input id="new_sce_kills_'+s.id+'" placeholder="Mortes: p2"><select id="new_sce_adult_'+s.id+'"><option value="0">Normal</option><option value="1">+18</option></select></div><textarea id="new_sce_text_'+s.id+'" placeholder="{p1} tenta conversar com o ET. Use {p} para Todos."></textarea><span class="small player-count-note">Digite qualquer número ou escreva Todos. Use {p} ou {todos} para colocar todos os vivos nesta cena.</span><button onclick="addScenarioEvent('+s.id+')">Adicionar dentro desta história</button><hr style="border-color:var(--b);margin:18px 0"><h3>Eventos decorrentes cadastrados</h3><div class="child-list">'+children+'</div></div></div>'}
async function loadScenarios(){if(!admin)return;const box=document.getElementById("scenariosEditor");if(!box)return;box.innerHTML="<div class='small'>Carregando histórias...</div>";const rows=await api("/hg/scenarios");if(!Array.isArray(rows)){box.innerHTML="<div class='small'>Erro ao carregar histórias.</div>";return}box.innerHTML=rows.map(scenarioRow).join("")||"<div class='small'>Nenhuma história criada.</div>"}
async function saveScenario(id){const body={action:"update_scenario",id,name:document.getElementById("sc_name_"+id).value,phase:document.getElementById("sc_phase_"+id).value,type:document.getElementById("sc_type_"+id).value,players:document.getElementById("sc_players_"+id).value,kills:document.getElementById("sc_kills_"+id).value,adult:document.getElementById("sc_adult_"+id).value,text:document.getElementById("sc_text_"+id).value,mix_with_normal:document.getElementById("sc_mix_"+id).checked?"1":"0",active:document.getElementById("sc_active_"+id).checked?"1":"0"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);openScenarios.add(Number(id));loadScenarios();load()}
async function restartScenario(id){if(!confirm("Reiniciar esta história na partida atual e voltar para a introdução?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"restart_scenario",id})});clearTimelinePlayback();timelineInitialized=false;alert(t);await load()}
async function deleteScenario(id){if(!confirm("Excluir esta história e TODOS os eventos que estão dentro dela?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_scenario",id})});alert(t);openScenarios.delete(Number(id));loadScenarios();load()}
async function addScenarioEvent(id){const body={action:"add_scenario_event",scenario_id:id,phase:document.getElementById("new_sce_phase_"+id).value,type:document.getElementById("new_sce_type_"+id).value,players:document.getElementById("new_sce_players_"+id).value,kills:document.getElementById("new_sce_kills_"+id).value,adult:document.getElementById("new_sce_adult_"+id).value,text:document.getElementById("new_sce_text_"+id).value,active:"1"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);openScenarios.add(Number(id));loadScenarios();load()}
async function saveScenarioEvent(id,sid){const body={action:"update_scenario_event",id,phase:document.getElementById("sce_phase_"+id).value,type:document.getElementById("sce_type_"+id).value,players:document.getElementById("sce_players_"+id).value,kills:document.getElementById("sce_kills_"+id).value,adult:document.getElementById("sce_adult_"+id).value,text:document.getElementById("sce_text_"+id).value,active:document.getElementById("sce_active_"+id).checked?"1":"0"};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);openScenarios.add(Number(sid));loadScenarios();load()}
async function deleteScenarioEvent(id,sid){if(!confirm("Excluir este evento decorrente?"))return;const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"delete_scenario_event",id})});alert(t);openScenarios.add(Number(sid));loadScenarios();load()}
load();if(admin){loadEvents();loadScenarios();loadTrophies()}setInterval(load,800);
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
app.get("/hg/avatar/:username", avatarRoute);

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

app.get("/hg/trophies", async (req, res) => {
  try {
    if (!checkBase(req, res)) return;
    await ensureTables();
    const db = await getPool();
    const [rows] = await db.query("SELECT id,title,image_data,active,created_at,updated_at FROM hg_trophies ORDER BY active DESC, id DESC");
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
