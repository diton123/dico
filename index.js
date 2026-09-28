// 디톤 프로필 조회 봇 - 서버 (Node.js / discord.js v14 / Express)
// 기능: 봇 상태메시지 변경, 서버 선택 후 전체 멤버 조회(프로필/배너/상태메시지/접속상태)
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, ActivityType, Events, EmbedBuilder } = require('discord.js');

// ─────────────────────────────────────────────
// 환경변수 (Railway > Variables 탭에서 설정)
//   DISCORD_TOKEN   : 디스코드 봇 토큰 (필수)
//   ADMIN_PASSWORD  : 웹사이트 로그인 비밀번호 (필수)
//   BOT_STATUS_TEXT : 봇 시작 시 기본 상태메시지 (선택)
//   PORT            : Railway가 자동 지정
// ─────────────────────────────────────────────
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const PORT = Number(process.env.PORT) || 3000;

// 어떤 변수가 문제인지 정확히 알려주는 진단 (변수 값은 절대 출력하지 않고 이름만 출력)
const missing = [];
if (!TOKEN) missing.push('DISCORD_TOKEN');
if (!ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD');

if (missing.length) {
  console.error(`[오류] 다음 변수가 없거나 값이 비어 있습니다: ${missing.join(', ')}`);
  const similar = Object.keys(process.env).filter(
    (k) => !k.startsWith('RAILWAY_') && /DISCORD|ADMIN|PASS|TOKEN/i.test(k)
  );
  console.error(
    `[진단] 비슷한 이름의 변수: ${similar.length ? similar.map((k) => JSON.stringify(k)).join(', ') : '없음'}`
  );
  console.error('[진단] 이름은 정확히 DISCORD_TOKEN, ADMIN_PASSWORD 여야 하며, 변수를 추가한 뒤 Deploy 버튼으로 적용해야 합니다.');
  process.exit(1);
}

// ─────────────────────────────────────────────
// 디스코드 클라이언트
// GuildMembers, GuildPresences 는 특권 인텐트입니다.
// 개발자 포털 > Bot 메뉴에서 반드시 켜야 합니다.
// ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates, // 음성 활동 시간 집계
    GatewayIntentBits.GuildMessages, // 채팅 수 집계 (메시지 내용은 읽지 않음)
  ],
});

// ─────────────────────────────────────────────
// 봇 상태메시지 관리
// ─────────────────────────────────────────────
const ACTIVITY_TYPES = {
  custom: ActivityType.Custom,
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};
const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

// 서버 재시작 시 초기값으로 돌아갑니다. (기본 문구는 BOT_STATUS_TEXT 변수로 지정 가능)
const botState = {
  text: (process.env.BOT_STATUS_TEXT || '디톤 프로필 조회 봇').slice(0, 128),
  type: 'custom',
  status: 'online',
};

function applyBotPresence() {
  const text = botState.text.trim();
  let activities = [];

  if (text) {
    if (botState.type === 'custom') {
      // 커스텀 상태는 state 필드에 문구를 넣습니다.
      activities = [{ name: 'Custom Status', type: ActivityType.Custom, state: text }];
    } else {
      activities = [{ name: text, type: ACTIVITY_TYPES[botState.type] }];
    }
  }

  client.user.setPresence({ activities, status: botState.status });
}

// ─────────────────────────────────────────────
// 멤버 직렬화 유틸
// ─────────────────────────────────────────────
const ACTIVITY_LABELS = {
  [ActivityType.Playing]: '플레이 중',
  [ActivityType.Streaming]: '방송 중',
  [ActivityType.Listening]: '듣는 중',
  [ActivityType.Watching]: '시청 중',
  [ActivityType.Competing]: '경쟁 중',
};

function extractCustomStatus(presence) {
  const act = presence?.activities?.find((a) => a.type === ActivityType.Custom);
  if (!act) return null;
  const emoji = act.emoji
    ? { name: act.emoji.name || null, id: act.emoji.id || null, animated: Boolean(act.emoji.animated) }
    : null;
  if (!act.state && !emoji) return null;
  return { text: act.state || null, emoji };
}

function extractActivities(presence) {
  return (presence?.activities || [])
    .filter((a) => a.type !== ActivityType.Custom)
    .map((a) => ({
      type: ACTIVITY_LABELS[a.type] || '활동 중',
      name: a.name,
      details: a.details || null,
      state: a.state || null,
    }));
}

function serializeMember(member) {
  const presence = member.presence;
  const hex = member.displayHexColor;
  return {
    id: member.id,
    username: member.user.username,
    globalName: member.user.globalName || null,
    displayName: member.displayName,
    bot: member.user.bot,
    avatar: member.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }),
    status: presence?.status || 'offline', // online | idle | dnd | offline
    clientStatus: presence?.clientStatus || {}, // { desktop, mobile, web }
    custom: extractCustomStatus(presence),
    activities: extractActivities(presence),
    roleColor: hex && hex !== '#000000' ? hex : null,
    joinedAt: member.joinedTimestamp || null,
  };
}

// ─────────────────────────────────────────────
// 서버 멤버 로딩 (서버당 최초 1회만 게이트웨이로 전체 요청,
// 이후에는 실시간 이벤트로 갱신되는 캐시를 사용)
// ─────────────────────────────────────────────
const fetchedGuilds = new Set();
const inflightFetch = new Map();

async function ensureMembers(guild) {
  if (fetchedGuilds.has(guild.id)) return;

  if (!inflightFetch.has(guild.id)) {
    const job = guild.members
      .fetch({ withPresences: true, time: 120000 })
      .then(() => {
        fetchedGuilds.add(guild.id);
      })
      .finally(() => {
        inflightFetch.delete(guild.id);
      });
    inflightFetch.set(guild.id, job);
  }
  await inflightFetch.get(guild.id);
}

// 배너는 유저 강제 조회(API 호출)가 필요하므로 10분간 캐시합니다.
const BANNER_TTL = 10 * 60 * 1000;
const bannerCache = new Map();

async function fetchUserFull(userId) {
  const cached = bannerCache.get(userId);
  if (cached && Date.now() - cached.at < BANNER_TTL) return cached.user;
  const user = await client.users.fetch(userId, { force: true });
  bannerCache.set(userId, { user, at: Date.now() });
  return user;
}

// ─────────────────────────────────────────────
// 웹 인증 (비밀번호 로그인 + 세션 쿠키)
// 멤버 정보가 노출되고 봇을 제어하므로 반드시 필요합니다.
// ─────────────────────────────────────────────
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // 토큰 -> 만료시각
const loginAttempts = new Map(); // IP -> { count, until }

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function setSessionCookie(req, res, token, maxAgeMs) {
  const parts = [
    `session=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of sessions) if (exp < now) sessions.delete(token);
  for (const [ip, rec] of loginAttempts) if (rec.until && rec.until < now) loginAttempts.delete(ip);
}, 60 * 60 * 1000).unref();

// ─────────────────────────────────────────────
// Express 앱
// ─────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Railway 프록시 뒤에서 https/IP 인식
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/session', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const record = loginAttempts.get(ip) || { count: 0, until: 0 };

  if (record.until > Date.now()) {
    const minutes = Math.ceil((record.until - Date.now()) / 60000);
    return res.status(429).json({ error: `시도 횟수를 초과했습니다. ${minutes}분 후 다시 시도하세요.` });
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    record.count += 1;
    if (record.count >= 5) {
      record.count = 0;
      record.until = Date.now() + 10 * 60 * 1000;
    }
    loginAttempts.set(ip, record);
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  setSessionCookie(req, res, token, SESSION_TTL);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).session;
  if (token) sessions.delete(token);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

// 여기부터는 로그인 필요
app.use('/api', (req, res, next) => {
  if (!isAuthed(req)) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!client.isReady()) return res.status(503).json({ error: '봇이 아직 준비 중입니다. 잠시 후 다시 시도하세요.' });
  next();
});

// 봇 정보 + 현재 상태 설정
app.get('/api/bot', (req, res) => {
  res.json({
    id: client.user.id,
    tag: client.user.tag,
    avatar: client.user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }),
    guildCount: client.guilds.cache.size,
    state: botState,
  });
});

// 봇 상태메시지 변경
app.post('/api/bot/status', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 128) : '';
  const type = Object.prototype.hasOwnProperty.call(ACTIVITY_TYPES, req.body?.type) ? req.body.type : 'custom';
  const status = PRESENCE_STATUSES.includes(req.body?.status) ? req.body.status : 'online';

  botState.text = text;
  botState.type = type;
  botState.status = status;

  try {
    applyBotPresence();
  } catch (err) {
    console.error('[상태 변경 오류]', err);
    return res.status(500).json({ error: '상태를 변경하지 못했습니다.' });
  }
  res.json({ ok: true, state: botState });
});

// 서버 목록
app.get('/api/guilds', (req, res) => {
  const guilds = client.guilds.cache
    .map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
      icon: g.iconURL({ extension: 'png', size: 64, forceStatic: true }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  res.json({ guilds });
});

// 서버의 모든 멤버 (프로필, 상태메시지, 접속상태)
app.get('/api/guilds/:gid/members', async (req, res) => {
  const guild = client.guilds.cache.get(req.params.gid);
  if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

  try {
    await ensureMembers(guild);
  } catch (err) {
    console.error('[멤버 조회 오류]', err);
    return res.status(502).json({
      error: '멤버 목록을 불러오지 못했습니다. 대형 서버는 최초 1회 시간이 걸릴 수 있으니 잠시 후 다시 시도하세요.',
    });
  }

  res.json({
    guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount },
    members: guild.members.cache.map(serializeMember),
  });
});

// 멤버 상세 (배너, 역할, 가입일 등)
app.get('/api/guilds/:gid/members/:uid', async (req, res) => {
  const guild = client.guilds.cache.get(req.params.gid);
  if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

  try {
    let member = guild.members.cache.get(req.params.uid);
    if (!member) member = await guild.members.fetch(req.params.uid);

    const user = await fetchUserFull(req.params.uid);

    const roles = member.roles.cache
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, color: r.hexColor && r.hexColor !== '#000000' ? r.hexColor : null }));

    res.json({
      ...serializeMember(member),
      avatarLarge: member.displayAvatarURL({ size: 512 }),
      banner: user.bannerURL({ size: 1024 }) || null,
      memberBanner: typeof member.bannerURL === 'function' ? member.bannerURL({ size: 1024 }) || null : null,
      accentColor: user.hexAccentColor || null,
      createdAt: user.createdTimestamp,
      badges: user.flags ? user.flags.toArray() : [],
      roles,
    });
  } catch (err) {
    if (err?.code === 10007 || err?.code === 10013) {
      return res.status(404).json({ error: '해당 유저를 찾을 수 없습니다.' });
    }
    console.error('[멤버 상세 오류]', err);
    res.status(500).json({ error: '상세 정보를 불러오지 못했습니다.' });
  }
});

// ═════════════════════════════════════════════
// 활동 통계 (음성 시간 / 채팅 수) - 한국 시간(KST) 기준 "오늘"
//  - 봇이 켜져 있는 동안만 기록되며, 배포 이전 활동은 집계할 수 없습니다.
//  - 저장 위치: DATA_DIR (Railway Volume을 연결하면 재배포 후에도 유지됩니다)
// ═════════════════════════════════════════════
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PERSISTENT = Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

let stats = { trackingSince: null, days: {} };
let statsDirty = false;

function loadStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      stats = { trackingSince: parsed.trackingSince || null, days: parsed.days || {} };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[통계 불러오기 오류]', err.message);
  }
  if (!stats.trackingSince) {
    stats.trackingSince = new Date().toISOString();
    statsDirty = true;
  }
}

function saveStatsSync() {
  if (!statsDirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats));
    fs.renameSync(tmp, STATS_FILE);
    statsDirty = false;
  } catch (err) {
    console.error('[통계 저장 오류]', err.message);
  }
}

// 한국 시간(UTC+9) 기준 날짜 키 (예: 2026-09-28)
function todayKey(ts = Date.now()) {
  return new Date(ts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pruneOldDays() {
  const cutoff = todayKey(Date.now() - 14 * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(stats.days)) {
    if (key < cutoff) {
      delete stats.days[key];
      statsDirty = true;
    }
  }
}

function dayBucket(guildId, key = todayKey()) {
  if (!stats.days[key]) stats.days[key] = {};
  if (!stats.days[key][guildId]) stats.days[key][guildId] = { chat: {}, voice: {} };
  return stats.days[key][guildId];
}

// 읽기 전용 조회 (없으면 빈 값 반환, 새로 만들지 않음)
function readBucket(guildId, key = todayKey()) {
  return (stats.days[key] && stats.days[key][guildId]) || { chat: {}, voice: {} };
}

// ── 채팅 집계 ──
client.on(Events.MessageCreate, (msg) => {
  if (!msg.guild || msg.author.bot || msg.webhookId || msg.system) return;
  const bucket = dayBucket(msg.guild.id);
  bucket.chat[msg.author.id] = (bucket.chat[msg.author.id] || 0) + 1;
  statsDirty = true;
});

// ── 음성 집계 ──
// voiceSessions: "서버ID:유저ID" -> 마지막으로 시간을 반영한 시각(ms)
const voiceSessions = new Map();

function creditSession(guildId, userId, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const last = voiceSessions.get(key);
  if (last === undefined) return;
  const seconds = Math.round((now - last) / 1000);
  if (seconds > 0) {
    const bucket = dayBucket(guildId, todayKey(now));
    bucket.voice[userId] = (bucket.voice[userId] || 0) + seconds;
    statsDirty = true;
  }
  voiceSessions.set(key, now);
}

function creditGuildSessions(guildId) {
  for (const key of [...voiceSessions.keys()]) {
    const [gid, uid] = key.split(':');
    if (gid === guildId) creditSession(gid, uid);
  }
}

function isCountableVoice(state) {
  // 잠수(AFK) 채널은 활동 시간에서 제외합니다.
  return Boolean(state.channelId) && state.channelId !== state.guild.afkChannelId;
}

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  const guildId = newState.guild.id;
  const key = `${guildId}:${member.id}`;

  creditSession(guildId, member.id); // 이전 상태까지의 시간을 먼저 반영
  if (isCountableVoice(newState)) {
    if (!voiceSessions.has(key)) voiceSessions.set(key, Date.now());
  } else {
    voiceSessions.delete(key);
  }
});

async function initVoiceSessions() {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!isCountableVoice(state)) continue;
      const member = state.member || (await guild.members.fetch(state.id).catch(() => null));
      if (!member || member.user.bot) continue;
      voiceSessions.set(`${guild.id}:${member.id}`, now);
    }
  }
}

// 30초마다 진행 중인 통화 시간을 반영 (자정 경계 처리 + 재시작 시 손실 최소화)
setInterval(() => {
  for (const key of [...voiceSessions.keys()]) {
    const [gid, uid] = key.split(':');
    creditSession(gid, uid);
  }
}, 30 * 1000).unref();

// 20초마다 파일 저장
setInterval(() => {
  pruneOldDays();
  saveStatsSync();
}, 20 * 1000).unref();

function shutdown() {
  for (const key of [...voiceSessions.keys()]) {
    const [gid, uid] = key.split(':');
    creditSession(gid, uid);
  }
  saveStatsSync();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loadStats();

// ═════════════════════════════════════════════
// 백그라운드 작업 (DM 공지 발송, 봇 DM 청소)
//  - 오래 걸리는 작업이라 진행 상황을 조회할 수 있게 작업으로 관리합니다.
//  - 동시에 하나만 실행할 수 있습니다.
// ═════════════════════════════════════════════
const jobs = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createJob(type, title, total) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    type,
    title,
    status: 'running', // running | done | cancelled | error
    total: total || null,
    processed: 0,
    success: 0,
    failed: 0,
    failures: [],
    error: null,
    cancel: false,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  if (jobs.size > 20) {
    for (const [id, j] of jobs) {
      if (j.status !== 'running') {
        jobs.delete(id);
        break;
      }
    }
  }
  return job;
}

function runningJob() {
  for (const job of jobs.values()) if (job.status === 'running') return job;
  return null;
}

function finishJob(job, status) {
  job.status = status;
  job.finishedAt = Date.now();
}

function dmFailReason(err) {
  if (err && err.code === 50007) return 'DM 수신 차단';
  if (err && err.code === 10013) return '알 수 없는 유저';
  return (err && err.message ? String(err.message) : '전송 실패').slice(0, 60);
}

async function runAnnounce(job, guild, members, message) {
  const embed = new EmbedBuilder()
    .setTitle('📢 공지')
    .setDescription(message)
    .setColor(0x8b9cff)
    .setFooter({ text: guild.name })
    .setTimestamp();

  try {
    for (const member of members) {
      if (job.cancel) break;
      try {
        await member.send({ embeds: [embed] });
        job.success += 1;
      } catch (err) {
        job.failed += 1;
        if (job.failures.length < 30) job.failures.push({ name: member.displayName, reason: dmFailReason(err) });
      }
      job.processed += 1;
      await sleep(1200); // 디스코드 제한을 피하기 위해 천천히 발송
    }
    finishJob(job, job.cancel ? 'cancelled' : 'done');
  } catch (err) {
    console.error('[공지 발송 오류]', err);
    job.error = '발송 중 오류가 발생했습니다.';
    finishJob(job, 'error');
  }
}

async function runDmClean(job, userId) {
  try {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    let before;
    let scanned = 0;

    while (!job.cancel && scanned < 3000) {
      const batch = await dm.messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      before = batch.last().id;
      scanned += batch.size;

      for (const msg of batch.values()) {
        if (job.cancel) break;
        if (msg.author.id !== client.user.id) continue;
        try {
          await msg.delete();
          job.success += 1;
        } catch (err) {
          job.failed += 1;
        }
        job.processed += 1;
        await sleep(400);
      }
      if (batch.size < 100) break;
    }
    finishJob(job, job.cancel ? 'cancelled' : 'done');
  } catch (err) {
    console.error('[DM 청소 오류]', err);
    job.error = err && err.code === 10013 ? '존재하지 않는 유저입니다.' : 'DM을 삭제하지 못했습니다. 유저 ID를 확인하세요.';
    finishJob(job, 'error');
  }
}

// ═════════════════════════════════════════════
// 추가 API
// ═════════════════════════════════════════════
function findGuild(req, res) {
  const guild = client.guilds.cache.get(req.params.gid);
  if (!guild) res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
  return guild;
}

function smallAvatar(member) {
  return member.displayAvatarURL({ extension: 'png', size: 64, forceStatic: true });
}

// 오늘 활동: 음성체크(현재 통화방), 오늘음성, 오늘채팅, 오늘랭킹 TOP 10
app.get('/api/guilds/:gid/activity', async (req, res) => {
  const guild = findGuild(req, res);
  if (!guild) return;

  try {
    await ensureMembers(guild);
  } catch (err) {
    console.error('[멤버 로딩 오류]', err); // 이름 표시용이므로 실패해도 계속 진행
  }

  creditGuildSessions(guild.id);
  const bucket = readBucket(guild.id);
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

  const rooms = guild.channels.cache
    .filter((c) => typeof c.isVoiceBased === 'function' && c.isVoiceBased())
    .map((c) => ({
      id: c.id,
      name: c.name,
      members: c.members
        .filter((m) => !m.user.bot)
        .map((m) => ({ id: m.id, name: m.displayName, avatar: smallAvatar(m) })),
    }))
    .filter((r) => r.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length);

  const toRank = (map) =>
    Object.entries(map)
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, value]) => {
        const member = guild.members.cache.get(id);
        return {
          id,
          name: member ? member.displayName : `유저 ${id}`,
          avatar: member ? smallAvatar(member) : 'https://cdn.discordapp.com/embed/avatars/0.png',
          value: Math.round(value),
        };
      });

  res.json({
    date: todayKey(),
    trackingSince: stats.trackingSince,
    persistent: PERSISTENT,
    totals: {
      voiceNow: rooms.reduce((n, r) => n + r.members.length, 0),
      voiceSeconds: Math.round(sum(bucket.voice)),
      chatCount: sum(bucket.chat),
    },
    rooms,
    ranking: { voice: toRank(bucket.voice), chat: toRank(bucket.chat) },
  });
});

// 오늘 미활동 멤버 (type=chat: 채팅 기록 없음 / type=voice: 통화방 기록 없음)
app.get('/api/guilds/:gid/inactive', async (req, res) => {
  const guild = findGuild(req, res);
  if (!guild) return;
  const type = req.query.type === 'voice' ? 'voice' : 'chat';

  try {
    await ensureMembers(guild);
  } catch (err) {
    console.error('[멤버 로딩 오류]', err);
    return res.status(502).json({ error: '멤버 목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요.' });
  }

  creditGuildSessions(guild.id);
  const bucket = readBucket(guild.id);
  const map = type === 'chat' ? bucket.chat : bucket.voice;
  const humans = guild.members.cache.filter((m) => !m.user.bot);

  const members = humans
    .filter((m) => {
      if (map[m.id] > 0) return false;
      if (type === 'voice' && voiceSessions.has(`${guild.id}:${m.id}`)) return false; // 지금 통화 중이면 활동으로 간주
      return true;
    })
    .map((m) => ({ id: m.id, displayName: m.displayName, username: m.user.username, avatar: smallAvatar(m) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));

  res.json({
    type,
    date: todayKey(),
    trackingSince: stats.trackingSince,
    persistent: PERSISTENT,
    humans: humans.size,
    total: members.length,
    members,
  });
});

// 공지 대상 역할 목록 (봇 제외 인원수 포함)
app.get('/api/guilds/:gid/roles', async (req, res) => {
  const guild = findGuild(req, res);
  if (!guild) return;

  try {
    await ensureMembers(guild);
  } catch (err) {
    console.error('[멤버 로딩 오류]', err);
    return res.status(502).json({ error: '멤버 목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요.' });
  }

  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, count: r.members.filter((m) => !m.user.bot).size }))
    .filter((r) => r.count > 0);

  res.json({ humans: guild.members.cache.filter((m) => !m.user.bot).size, roles });
});

// DM 공지 발송 (roleId 없으면 서버 전체 멤버, 있으면 해당 역할 멤버)
app.post('/api/guilds/:gid/announce', async (req, res) => {
  const guild = findGuild(req, res);
  if (!guild) return;

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: '공지 내용을 입력하세요.' });
  if (message.length > 1500) return res.status(400).json({ error: '공지는 1500자까지 보낼 수 있습니다.' });
  if (runningJob()) return res.status(409).json({ error: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 시도하세요.' });

  try {
    await ensureMembers(guild);
  } catch (err) {
    console.error('[멤버 로딩 오류]', err);
    return res.status(502).json({ error: '멤버 목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요.' });
  }

  const roleId = typeof req.body?.roleId === 'string' && req.body.roleId ? req.body.roleId : null;
  let role = null;
  if (roleId) {
    role = guild.roles.cache.get(roleId);
    if (!role) return res.status(404).json({ error: '역할을 찾을 수 없습니다.' });
  }

  const targets = [...guild.members.cache.values()].filter(
    (m) => !m.user.bot && (!role || m.roles.cache.has(role.id))
  );
  if (!targets.length) return res.status(400).json({ error: '공지를 받을 멤버가 없습니다.' });

  const job = createJob('announce', `공지 발송 (${role ? '@' + role.name : '전체 멤버'})`, targets.length);
  runAnnounce(job, guild, targets, message); // 백그라운드 실행
  res.json({ jobId: job.id, total: targets.length });
});

// 봇이 특정 유저에게 보낸 DM 모두 삭제
app.post('/api/dm-clean', (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!/^\d{15,25}$/.test(userId)) return res.status(400).json({ error: '올바른 유저 ID를 입력하세요. (숫자 17~20자리)' });
  if (runningJob()) return res.status(409).json({ error: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 시도하세요.' });

  const job = createJob('dmclean', '봇 DM 삭제', null);
  runDmClean(job, userId); // 백그라운드 실행
  res.json({ jobId: job.id });
});

// 작업 목록 / 상태 / 중지
app.get('/api/jobs', (req, res) => {
  res.json({ jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (job.status === 'running') job.cancel = true;
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

// ─────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  console.log(`[봇 준비 완료] ${c.user.tag} / 서버 ${c.guilds.cache.size}개`);
  applyBotPresence();
  initVoiceSessions().catch((err) => console.error('[음성 세션 초기화 오류]', err));
});

client.on('error', (err) => console.error('[클라이언트 오류]', err));
process.on('unhandledRejection', (err) => console.error('[처리되지 않은 Promise 거부]', err));

app.listen(PORT, () => console.log(`[웹서버 시작] 포트 ${PORT}`));

client.login(TOKEN).catch((err) => {
  console.error('[로그인 실패] 토큰과 인텐트 설정을 확인하세요.', err);
  process.exit(1);
});
