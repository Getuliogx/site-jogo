
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

let pool = null;
let ready = false;
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

async function ensureTables() {
  if (ready) return;
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

  const [count] = await db.query("SELECT COUNT(*) AS total FROM hg_events");
  if (Number(count?.[0]?.total || 0) === 0) {
    await db.query("INSERT INTO hg_events (phase,type,players,text,kills,adult) VALUES ?", [DEFAULT_EVENTS.map(e => [e[0],e[1],e[2],e[3],e[4],e[5]])]);
  }

  ready = true;
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
  const game = await currentGame(channel, true);
  if (game.status !== "lobby") return "A partida já começou. Espere resetar.";
  const db = await getPool();
  const max = Number(process.env.HG_MAX_PLAYERS || 24);
  const [cnt] = await db.query("SELECT COUNT(*) total FROM hg_players WHERE game_id=?", [game.id]);
  const [ex] = await db.query("SELECT * FROM hg_players WHERE game_id=? AND username=? LIMIT 1", [game.id, username]);
  if (!ex.length && Number(cnt?.[0]?.total || 0) >= max) return `A arena já está cheia (${max}).`;

  const dist = distRaw ? district(distRaw) : (ex.length ? ex[0].district : await autoDistrict(game.id));
  const avatar = ex.length ? (ex[0].avatar_url || "") : await getTwitchAvatar(username);

  await db.query(`
    INSERT INTO hg_players (game_id,channel,username,display_name,district,avatar_url,alive)
    VALUES (?,?,?,?,?,?,1)
    ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), district=VALUES(district), avatar_url=COALESCE(NULLIF(VALUES(avatar_url),''),avatar_url), alive=1
  `, [game.id, channel, username, display || username, dist, avatar || ""]);

  return `✅ ${display || username} entrou no Distrito ${dist}.`;
}

async function leave(channel, username) {
  const game = await currentGame(channel, false);
  if (!game || game.status !== "lobby") return "Só dá para sair antes da partida começar.";
  const db = await getPool();
  await db.query("DELETE FROM hg_players WHERE game_id=? AND username=?", [game.id, username]);
  return `✅ ${username} saiu da arena.`;
}

async function changeDistrict(channel, username, distRaw) {
  const game = await currentGame(channel, false);
  if (!game || game.status !== "lobby") return "Só dá para trocar distrito antes da partida começar.";
  const db = await getPool();
  const [r] = await db.query("UPDATE hg_players SET district=? WHERE game_id=? AND username=?", [district(distRaw), game.id, username]);
  if (!r.affectedRows) return `Você ainda não entrou. Use !hg entrar ${district(distRaw)}`;
  return `✅ ${username} foi para o Distrito ${district(distRaw)}.`;
}

async function addManual(channel, name, distRaw) {
  const display = String(name || "").trim().replace(/\s+/g, " ");
  if (!display) return "Faltou o nome.";
  return join(channel, nick(display) || `player${Date.now()}`, display, distRaw);
}

async function start(channel) {
  const game = await currentGame(channel, true);
  if (game.status === "running") return "A partida já está rodando.";
  const db = await getPool();
  const [players] = await db.query("SELECT * FROM hg_players WHERE game_id=?", [game.id]);
  if (players.length < 2) return "Precisa de pelo menos 2 participantes.";
  await db.query("UPDATE hg_players SET alive=1,kills=0 WHERE game_id=?", [game.id]);
  await db.query("UPDATE hg_games SET status='running',phase='bloodbath',day_number=1,winner=NULL WHERE id=?", [game.id]);
  await db.query("INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,'reaping',0,?,'')", [game.id, channel, `🎲 A arena começou com ${players.length} participantes.`]);
  return `🔥 Partida iniciada com ${players.length} participantes.`;
}

async function reset(channel) {
  const old = await currentGame(channel, false);
  await newLobby(channel, old?.adult_mode || (process.env.HG_ADULT_DEFAULT === "1" ? 1 : 0));
  return "✅ Arena resetada. Use !hg entrar.";
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
function fill(text, players) {
  let out = String(text || "");
  players.forEach((p, idx) => {
    out = out.replace(new RegExp(`\\{p${idx+1}\\}`, "g"), p.display_name || p.username);
  });
  return out;
}
function killIndexes(kills) {
  return String(kills || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).map(s => {
    const m = s.match(/^p([1-9])$/);
    return m ? Number(m[1])-1 : -1;
  }).filter(n => n >= 0);
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

async function nextRound(channel) {
  const game = await currentGame(channel, false);
  if (!game) return "Nenhuma partida criada.";
  if (game.status === "lobby") return "A partida ainda não começou. Use !hg iniciar.";
  if (game.status === "ended") return `A partida já acabou. Vencedor: ${game.winner || "ninguém"}.`;

  const db = await getPool();
  let alive = await alivePlayers(game.id);
  if (alive.length <= 1) {
    const winner = alive[0]?.display_name || null;
    await db.query("UPDATE hg_games SET status='ended',winner=? WHERE id=?", [winner, game.id]);
    return winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor.";
  }

  const phase = game.phase || "bloodbath";
  const day = Number(game.day_number || 1);
  const title = phaseName(phase, day);
  const phases = (phase === "day" || phase === "night") ? [phase, "arena"] : [phase];
  const [events] = await db.query(
    `SELECT * FROM hg_events WHERE active=1 AND phase IN (${phases.map(()=>"?").join(",")}) AND (adult=0 OR ?=1) ORDER BY RAND()`,
    [...phases, Number(game.adult_mode) === 1 ? 1 : 0]
  );
  if (!events.length) return "Sem eventos para essa fase.";

  await db.query("INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,?,?,?,'')", [game.id, channel, phase, day, `📍 ${title}`]);

  const available = shuffle(alive);
  while (available.length > 0) {
    const aliveNow = await alivePlayers(game.id);
    if (aliveNow.length <= 1) break;

    const possible = events.filter(ev => Number(ev.players || 1) <= available.length);
    if (!possible.length) break;

    const deathEvents = possible.filter(ev => String(ev.kills || "").trim());
    const pool = aliveNow.length > 2 && deathEvents.length && Math.random() < 0.38 ? deathEvents : possible;
    const ev = random(pool);
    const count = Math.max(1, Math.min(Number(ev.players || 1), available.length));
    const group = available.splice(0, count);

    let deaths = [];
    for (const idx of killIndexes(ev.kills)) if (group[idx]) deaths.push(group[idx]);
    if (aliveNow.length - deaths.length < 1) deaths = deaths.slice(0, Math.max(0, aliveNow.length - 1));

    const text = fill(ev.text, group);
    const deathNames = deaths.map(p => p.display_name || p.username);

    for (const dead of deaths) {
      await db.query("UPDATE hg_players SET alive=0 WHERE id=?", [dead.id]);
      const killer = group.find(p => p.id !== dead.id);
      if (killer) await db.query("UPDATE hg_players SET kills=kills+1 WHERE id=?", [killer.id]);
    }

    await db.query("INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,?,?,?,?)", [game.id, channel, phase, day, text, deathNames.join(", ")]);
  }

  alive = await alivePlayers(game.id);
  if (alive.length <= 1) {
    const winner = alive[0]?.display_name || null;
    await db.query("UPDATE hg_games SET status='ended',winner=? WHERE id=?", [winner, game.id]);
    await db.query("INSERT INTO hg_logs (game_id,channel,phase,day_number,text,deaths) VALUES (?,?,'winner',?,?, '')", [game.id, channel, day, winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor."]);
    return winner ? `🏆 ${winner} venceu a arena!` : "A partida acabou sem vencedor.";
  }

  const np = nextPhase(phase, day);
  await db.query("UPDATE hg_games SET phase=?,day_number=? WHERE id=?", [np.phase, np.day, game.id]);
  return `✅ ${title} gerado. Restam ${alive.length} vivos.`;
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
  if (/^(resetar|reset|limpar)$/i.test(q)) return { action: "reset" };
  if (/^(\+18|18\+|adulto|adult)\s*(on|ligar|liga)?$/i.test(q)) return { action: "adult_on" };
  if (/^(\+18|18\+|adulto|adult)\s*(off|desligar|desliga)$/i.test(q)) return { action: "adult_off" };
  m = original.match(/^(add|adicionar)\s+(.+?)(?:\s+(?:distrito\s*)?(\d{1,2}))?$/i);
  if (m) return { action: "manual_add", name: m[2], district: m[3] || null };
  return { action: "unknown" };
}

function help() {
  return "Comandos: !hg entrar | !hg entrar 5 | !hg distrito 5 | !hg sair | !hg iniciar | !hg proximo | !hg resetar | !hg +18 on/off";
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

    if (cmd.action === "start") return send(res, await start(ch));
    if (cmd.action === "next") return send(res, await nextRound(ch));
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

    if (["start","next","reset","adult_on","adult_off","add_player","add_event"].includes(action) && !isAdmin(req)) {
      return send(res, "Usuário não autorizado.");
    }

    if (action === "start") return send(res, await start(ch));
    if (action === "next") return send(res, await nextRound(ch));
    if (action === "reset") return send(res, await reset(ch));
    if (action === "adult_on") return send(res, await adult(ch, true));
    if (action === "adult_off") return send(res, await adult(ch, false));
    if (action === "add_player") return send(res, await addManual(ch, req.query.name || req.body?.name, req.query.district || req.body?.district));

    if (action === "add_event") {
      await ensureTables();
      const db = await getPool();
      const phase = String(req.body?.phase || req.query.phase || "day").trim();
      const type = String(req.body?.type || req.query.type || "neutral").trim();
      const players = Math.max(1, Math.min(4, Number(req.body?.players || req.query.players || 1)));
      const text = String(req.body?.text || req.query.text || "").trim();
      const kills = String(req.body?.kills || req.query.kills || "").trim();
      const adultFlag = String(req.body?.adult ?? req.query.adult ?? "0") === "1" ? 1 : 0;
      if (!text) return send(res, "Faltou o texto do evento.");
      await db.query("INSERT INTO hg_events (phase,type,players,text,kills,adult) VALUES (?,?,?,?,?,?)", [phase,type,players,text,kills,adultFlag]);
      return send(res, "✅ Evento adicionado.");
    }

    return send(res, "Ação inválida.");
  } catch (e) {
    console.error(e);
    return send(res, `Erro admin HG: ${e.message}`);
  }
}

async function state(req, res) {
  try {
    const ch = channelFrom(req);
    const game = await currentGame(ch, true);
    const db = await getPool();
    const [players] = await db.query("SELECT * FROM hg_players WHERE game_id=? ORDER BY district ASC, alive DESC, id ASC", [game.id]);
    const [logs] = await db.query("SELECT * FROM hg_logs WHERE game_id=? ORDER BY id DESC LIMIT 150", [game.id]);
    const [events] = await db.query("SELECT COUNT(*) total, SUM(adult=1) adultTotal FROM hg_events WHERE active=1");
    res.json({
      game,
      players,
      logs: logs.reverse(),
      eventCount: Number(events?.[0]?.total || 0),
      adultEventCount: Number(events?.[0]?.adultTotal || 0)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

function page(admin = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hunger Games da Live</title>
<style>
:root{--bg:#07070c;--card:#141421;--card2:#1c1c2d;--text:#f8f7ff;--muted:#aaa6c8;--p:#a855f7;--d:#ef4444;--ok:#22c55e;--b:#303044}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#2a1247,#080810 46%,#050509);color:var(--text);font-family:Inter,system-ui,Arial,sans-serif}.wrap{max-width:1280px;margin:auto;padding:22px}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start}h1{margin:0;font-size:clamp(30px,4vw,54px);letter-spacing:-.05em}.sub,.small{color:var(--muted)}.pill{border:1px solid var(--b);background:#141421d9;border-radius:999px;padding:9px 13px;font-weight:900}
.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-top:20px}@media(max-width:900px){.grid{grid-template-columns:1fr}}.card{background:#141421dd;border:1px solid var(--b);border-radius:26px;padding:18px;box-shadow:0 16px 50px #0008}.controls{display:flex;gap:8px;flex-wrap:wrap}
button,.btn{border:0;border-radius:14px;padding:11px 14px;font-weight:950;color:white;background:var(--p);cursor:pointer}.danger{background:var(--d)}.ok{background:var(--ok);color:#061208}.secondary{background:#303044}
input,select,textarea{width:100%;background:#0d0d16;color:var(--text);border:1px solid var(--b);border-radius:14px;padding:11px;font:inherit}textarea{min-height:90px}.players{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.player{border:1px solid var(--b);background:var(--card2);border-radius:18px;padding:12px;display:flex;gap:12px;align-items:center}.dead{opacity:.45;filter:grayscale(1)}.avatar{width:46px;height:46px;border-radius:14px;object-fit:cover;background:#333}.fake{display:flex;align-items:center;justify-content:center;background:#402060;font-weight:950}
.district{color:#d8b4fe;font-weight:950;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.name{font-weight:950}.kills{font-size:12px;color:var(--muted)}.logs{display:flex;flex-direction:column;gap:10px;max-height:680px;overflow:auto}.log{border:1px solid var(--b);background:#11111c;border-radius:18px;padding:12px;line-height:1.45}.death{border-color:#7f1d1d;background:#1c1014}.phase{color:#f0abfc;font-weight:950;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.two{display:grid;grid-template-columns:1fr 100px;gap:8px}
</style></head><body><div class="wrap"><div class="top"><div><h1>Hunger Games da Live</h1><div class="sub">Participantes do chat, distritos, eventos, mortes e vencedor final.</div></div><div class="pill" id="statusPill">Carregando...</div></div>
<div class="grid"><section class="card"><div class="top"><div><div class="phase" id="phase">Arena</div><div style="font-size:18px;font-weight:950" id="status">Carregando...</div><div class="small" id="counts"></div></div>${admin ? `<div class="controls"><button class="ok" onclick="act('start')">Iniciar</button><button class="secondary" onclick="act('next')">Próximo</button><button class="danger" onclick="act('reset')">Resetar</button><button class="secondary" onclick="act('adult_on')">+18 ON</button><button class="secondary" onclick="act('adult_off')">+18 OFF</button></div>` : ``}</div>
${admin ? `<div class="two" style="margin:16px 0"><input id="manualName" placeholder="Adicionar participante manual"/><input id="manualDistrict" placeholder="Distrito" type="number" min="1" max="12"/><button style="grid-column:1/-1" onclick="addPlayer()">Adicionar participante</button></div>` : ``}
<h2>Participantes</h2><div class="players" id="players"></div></section><aside class="card"><h2>Eventos</h2><div class="logs" id="logs"></div></aside></div>
${admin ? `<section class="card" style="margin-top:18px"><h2>Adicionar evento próprio</h2><div class="small">Use {p1}, {p2}, {p3}, {p4}. Para matar alguém coloque kills: p2 ou p1,p3.</div><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:12px"><select id="evPhase"><option>bloodbath</option><option>day</option><option>night</option><option>feast</option><option>arena</option></select><select id="evType"><option>neutral</option><option>death</option><option>item</option><option>alliance</option><option>adult</option></select><input id="evPlayers" type="number" min="1" max="4" value="1"/><input id="evKills" placeholder="kills: p2"/><select id="evAdult"><option value="0">Normal</option><option value="1">+18</option></select></div><textarea id="evText" placeholder="{p1} faz alguma coisa com {p2}."></textarea><button onclick="addEvent()">Salvar evento</button></section>` : ``}</div>
<script>
const params=new URLSearchParams(location.search),channel=params.get("channel")||"carolinaporto",token=params.get("token")||"",admin=${admin?"true":"false"};
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[m]))}
async function api(path,opt={}){const sep=path.includes("?")?"&":"?";const url=path+sep+"channel="+encodeURIComponent(channel)+(token?"&token="+encodeURIComponent(token):"");const r=await fetch(url,opt),ct=r.headers.get("content-type")||"";return ct.includes("json")?r.json():r.text()}
async function load(){const st=await api("/hg/state"),g=st.game||{};document.getElementById("statusPill").textContent=(g.status||"lobby").toUpperCase()+(g.adult_mode?" • +18":"");document.getElementById("phase").textContent=(g.phase||"bloodbath")+" • dia "+(g.day_number||1);document.getElementById("status").textContent=g.status==="running"?"Partida rolando":g.status==="ended"?("Vencedor: "+(g.winner||"ninguém")):"Lobby aberto";const alive=st.players.filter(p=>p.alive).length;document.getElementById("counts").textContent=st.players.length+" participantes • "+alive+" vivos • "+st.eventCount+" eventos";
document.getElementById("players").innerHTML=st.players.map(p=>{const av=p.avatar_url?'<img class="avatar" src="'+esc(p.avatar_url)+'">':'<div class="avatar fake">'+esc((p.display_name||"?").slice(0,1).toUpperCase())+'</div>';return '<div class="player '+(p.alive?'':'dead')+'">'+av+'<div><div class="district">Distrito '+p.district+'</div><div class="name">'+esc(p.display_name)+'</div><div class="kills">'+(p.kills||0)+' kill(s) '+(p.alive?'🟢':'💀')+'</div></div></div>'}).join("")||"<div class='small'>Ninguém entrou ainda.</div>";
document.getElementById("logs").innerHTML=st.logs.map(l=>'<div class="log '+(l.deaths?'death':'')+'"><div class="phase">'+esc(l.phase)+' '+(l.day_number?'• '+l.day_number:'')+'</div><div>'+esc(l.text)+'</div>'+(l.deaths?'<div class="small">Mortes: '+esc(l.deaths)+'</div>':'')+'</div>').join("")||"<div class='small'>Sem eventos ainda.</div>"}
async function act(a){if(!token)return alert("Abra com ?token=SEU_TOKEN");const t=await api("/hg/admin?action="+encodeURIComponent(a));alert(t);load()}
async function addPlayer(){const name=document.getElementById("manualName").value.trim(),d=document.getElementById("manualDistrict").value.trim();if(!name)return alert("Nome vazio");const t=await api("/hg/admin?action=add_player&name="+encodeURIComponent(name)+"&district="+encodeURIComponent(d));alert(t);load()}
async function addEvent(){const body={action:"add_event",phase:evPhase.value,type:evType.value,players:evPlayers.value,kills:evKills.value,adult:evAdult.value,text:evText.value};const t=await api("/hg/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});alert(t);evText.value="";load()}
load();setInterval(load,2500);
</script></body></html>`;
}

app.get("/", (_req, res) => res.type("text/plain").send("OK - Hunger Games da Live separado"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/hg", command);
app.post("/hg", command);
app.get("/hg/admin", adminAction);
app.post("/hg/admin", adminAction);
app.get("/hg/state", state);
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
app.listen(PORT, () => console.log("HG Live separado rodando na porta " + PORT));
