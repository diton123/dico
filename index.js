// 디톤 프로필 조회 봇 - 서버 (Node.js / discord.js v14 / Express)
// 기능: 봇 상태메시지 변경, 서버 선택 후 전체 멤버 조회(프로필/배너/상태메시지/접속상태)
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Client, GatewayIntentBits, ActivityType, Events } = require('discord.js');

// ─────────────────────────────────────────────
// 환경변수 (Railway > Variables 탭에서 설정)
//   DISCORD_TOKEN   : 디스코드 봇 토큰 (필수)
//   ADMIN_PASSWORD  : 웹사이트 로그인 비밀번호 (필수)
//   BOT_STATUS_TEXT : 봇 시작 시 기본 상태메시지 (선택)
//   PORT            : Railway가 자동 지정
// ─────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN || !ADMIN_PASSWORD) {
  console.error('[오류] Railway Variables 탭에 DISCORD_TOKEN, ADMIN_PASSWORD 를 설정해 주세요.');
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

app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

// ─────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  console.log(`[봇 준비 완료] ${c.user.tag} / 서버 ${c.guilds.cache.size}개`);
  applyBotPresence();
});

client.on('error', (err) => console.error('[클라이언트 오류]', err));
process.on('unhandledRejection', (err) => console.error('[처리되지 않은 Promise 거부]', err));

app.listen(PORT, () => console.log(`[웹서버 시작] 포트 ${PORT}`));

client.login(TOKEN).catch((err) => {
  console.error('[로그인 실패] 토큰과 인텐트 설정을 확인하세요.', err);
  process.exit(1);
});
