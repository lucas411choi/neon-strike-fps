import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { applyExperienceProgress, getHitMultiplier, isValidPassword, isValidUsername, normalizeUsername } from '../src/shared-rules.js';
import { STORE_SKINS, STORE_BUNDLES, STORE_ROLL_COST, TRAINING_QUEST_TARGET, TRAINING_QUEST_REWARD, getStoreSkin, getStoreBundle } from '../src/store-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '8kb' }));

// Persistent accounts use the external PostgreSQL URL in DATABASE_URL (recommended: Neon pooled connection string).
// Local development uses a private JSON file so auth can be exercised without a database.
const { Pool } = pg;
const authPool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
}) : null;
authPool?.on('error', err => console.error('[accounts] postgres pool error:', err?.message || err));
const scryptAsync = promisify(scryptCallback);
const localAuthPath = path.join(rootDir, '.neon-strike-auth.local.json');
const localAuth = { nextId: 1, accounts: [], sessions: [] };
let localWriteQueue = Promise.resolve();
let authStorageReady = false;
const authRateBuckets = new Map();
const trainingAwardAt = new Map();
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const XP_TRAINING_TARGET = 10;

function normalizeAccountId(value) { return String(value ?? '').trim().toLowerCase(); }
function parseJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}
function normalizeRepeatQuestProgress(value) {
  const parsed = parseJsonValue(value, {});
  return {
    pistolKills: Math.max(0, Math.floor(Number(parsed?.pistolKills) || 0)) % 6,
    knifeInspects: Math.max(0, Math.floor(Number(parsed?.knifeInspects) || 0)) % 100,
  };
}
const REPEAT_QUEST_RULES = Object.freeze({
  pistolKills: { target: 6, reward: 67 },
  knifeInspects: { target: 100, reward: 15 },
});
async function incrementRepeatQuest(accountId, questId, amount = 1) {
  const rule = REPEAT_QUEST_RULES[questId];
  if (!rule || !accountId) return null;
  return mutateAccountState(accountId, model => {
    const progress = normalizeRepeatQuestProgress(model.repeatQuestProgress);
    progress[questId] += Math.max(1, Math.min(10, Math.floor(Number(amount) || 1)));
    let completions = 0;
    while (progress[questId] >= rule.target) {
      progress[questId] -= rule.target;
      model.neonPoints += rule.reward;
      completions += 1;
    }
    model.repeatQuestProgress = progress;
    return { ok: true, questId, progress: progress[questId], target: rule.target, completions, reward: completions * rule.reward };
  });
}

function normalizeAccountPublic(row) {
  if (!row) return null;
  const level = Math.max(1, Number(row.level) || 1);
  return {
    id: Number(row.id), username: String(row.username), level, xp: Number(row.xp || 0), nextLevelXp: level * 150,
    neonPoints: Math.max(0, Number(row.neon_points ?? row.neonPoints) || 0),
    ownedSkins: parseJsonValue(row.owned_skins ?? row.ownedSkins, []),
    equippedSkins: parseJsonValue(row.equipped_skins ?? row.equippedSkins, {}),
    trainingQuestProgress: Math.max(0, Number(row.training_quest_progress ?? row.trainingQuestProgress) || 0),
    repeatQuestProgress: normalizeRepeatQuestProgress(row.repeat_quest_progress ?? row.repeatQuestProgress),
    ownedProfiles: parseJsonValue(row.owned_profiles ?? row.ownedProfiles, ['default']),
    ownedNameColors: parseJsonValue(row.owned_name_colors ?? row.ownedNameColors, ['default']),
    profileId: String(row.profile_id ?? row.profileId ?? 'default'),
    nameColor: String(row.name_color ?? row.nameColor ?? 'default'),
  };
}
function accountStoreModel(row) {
  return {
    level: Math.max(1, Number(row.level) || 1), xp: Math.max(0, Number(row.xp) || 0),
    neonPoints: Math.max(0, Number(row.neon_points ?? row.neonPoints) || 0),
    ownedSkins: parseJsonValue(row.owned_skins ?? row.ownedSkins, []),
    equippedSkins: parseJsonValue(row.equipped_skins ?? row.equippedSkins, {}),
    trainingQuestProgress: Math.max(0, Number(row.training_quest_progress ?? row.trainingQuestProgress) || 0),
    repeatQuestProgress: normalizeRepeatQuestProgress(row.repeat_quest_progress ?? row.repeatQuestProgress),
    redeemedCodes: parseJsonValue(row.redeemed_codes ?? row.redeemedCodes, []),
    dailyShopIds: parseJsonValue(row.daily_shop_ids ?? row.dailyShopIds, []),
    dailyShopExpiresAt: row.daily_shop_expires_at ?? row.dailyShopExpiresAt ?? null,
    ownedProfiles: parseJsonValue(row.owned_profiles ?? row.ownedProfiles, ['default']),
    ownedNameColors: parseJsonValue(row.owned_name_colors ?? row.ownedNameColors, ['default']),
    profileId: String(row.profile_id ?? row.profileId ?? 'default'),
    nameColor: String(row.name_color ?? row.nameColor ?? 'default'),
  };
}

function hashSessionToken(token) { return createHash('sha256').update(String(token || '')).digest('hex'); }
function accountRateAllowed(req, action, max=8, windowMs=10*60*1000) {
  const now = Date.now();
  const key = `${action}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  let record = authRateBuckets.get(key);
  if (!record || record.until <= now) record = { count: 0, until: now + windowMs };
  record.count += 1;
  authRateBuckets.set(key, record);
  if (authRateBuckets.size > 3000) for (const [k,v] of authRateBuckets) if (v.until <= now) authRateBuckets.delete(k);
  return record.count <= max;
}
function persistLocalAuth() {
  const snapshot = JSON.stringify(localAuth, null, 2);
  localWriteQueue = localWriteQueue.catch(() => {}).then(async () => {
    const temp = `${localAuthPath}.tmp`;
    await fs.writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, localAuthPath);
  });
  return localWriteQueue;
}
async function initializeAccountStorage() {
  if (authPool) {
    const ddl = `
      CREATE TABLE IF NOT EXISTS ns_accounts (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(20) NOT NULL UNIQUE,
        password_salt CHAR(32) NOT NULL,
        password_hash CHAR(128) NOT NULL,
        level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
        xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
        neon_points INTEGER NOT NULL DEFAULT 0 CHECK (neon_points >= 0),
        owned_skins JSONB NOT NULL DEFAULT '[]'::jsonb,
        equipped_skins JSONB NOT NULL DEFAULT '{}'::jsonb,
        training_quest_progress INTEGER NOT NULL DEFAULT 0 CHECK (training_quest_progress >= 0 AND training_quest_progress < 67),
        repeat_quest_progress JSONB NOT NULL DEFAULT '{"pistolKills":0,"knifeInspects":0}'::jsonb,
        redeemed_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
        daily_shop_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        daily_shop_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS neon_points INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS owned_skins JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS equipped_skins JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS training_quest_progress INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS repeat_quest_progress JSONB NOT NULL DEFAULT '{"pistolKills":0,"knifeInspects":0}'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS redeemed_codes JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS daily_shop_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS daily_shop_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS owned_profiles JSONB NOT NULL DEFAULT '["default"]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS owned_name_colors JSONB NOT NULL DEFAULT '["default"]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS profile_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS name_color TEXT NOT NULL DEFAULT 'default';
      CREATE TABLE IF NOT EXISTS ns_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES ns_accounts(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ns_sessions_account_idx ON ns_sessions(account_id);
      CREATE INDEX IF NOT EXISTS ns_sessions_expiry_idx ON ns_sessions(expires_at);
    `;
    let lastError;
    for (let attempt=0; attempt<6; attempt++) {
      try { await authPool.query(ddl); authStorageReady = true; console.log('[accounts] PostgreSQL ready'); return; }
      catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1))); }
    }
    console.error('[accounts] PostgreSQL schema setup failed:', lastError?.message || lastError);
    return;
  }
  if (isProduction) {
    console.error('[accounts] DATABASE_URL is missing. Add the Neon PostgreSQL connection string in the Render service Environment settings before enabling durable accounts.');
    return;
  }
  try {
    const raw = await fs.readFile(localAuthPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.accounts) && Array.isArray(parsed.sessions)) {
      localAuth.accounts = parsed.accounts;
      localAuth.sessions = parsed.sessions;
      for (const account of localAuth.accounts) {
        account.neon_points = Math.max(0, Number(account.neon_points ?? account.neonPoints) || 0);
        account.owned_skins = parseJsonValue(account.owned_skins ?? account.ownedSkins, []);
        account.equipped_skins = parseJsonValue(account.equipped_skins ?? account.equippedSkins, {});
        account.training_quest_progress = Math.max(0, Number(account.training_quest_progress ?? account.trainingQuestProgress) || 0) % TRAINING_QUEST_TARGET;
        account.repeat_quest_progress = normalizeRepeatQuestProgress(account.repeat_quest_progress ?? account.repeatQuestProgress);
        account.redeemed_codes = parseJsonValue(account.redeemed_codes ?? account.redeemedCodes, []);
        account.daily_shop_ids = parseJsonValue(account.daily_shop_ids ?? account.dailyShopIds, []);
        account.daily_shop_expires_at = account.daily_shop_expires_at ?? account.dailyShopExpiresAt ?? null;
        account.owned_profiles = parseJsonValue(account.owned_profiles ?? account.ownedProfiles, ['default']);
        account.owned_name_colors = parseJsonValue(account.owned_name_colors ?? account.ownedNameColors, ['default']);
        account.profile_id = String(account.profile_id ?? account.profileId ?? 'default');
        account.name_color = String(account.name_color ?? account.nameColor ?? 'default');
      }
      localAuth.nextId = Number(parsed.nextId) || (Math.max(0, ...localAuth.accounts.map(a=>Number(a.id)||0)) + 1);
    }
  } catch (error) { if (error?.code !== 'ENOENT') console.warn('[accounts] local data could not be loaded:', error?.message || error); }
  authStorageReady = true;
  console.log('[accounts] local development file store ready');
}
async function findAccountByUsername(username) {
  if (authPool) {
    const result = await authPool.query('SELECT id, username, password_salt, password_hash, level, xp, neon_points, owned_skins, equipped_skins, training_quest_progress, repeat_quest_progress, redeemed_codes,owned_profiles,owned_name_colors,profile_id,name_color FROM ns_accounts WHERE username=$1 LIMIT 1', [username]);
    return result.rows[0] || null;
  }
  return localAuth.accounts.find(row => row.username === username) || null;
}
async function insertAccount(username, passwordSalt, passwordHash) {
  if (authPool) {
    const result = await authPool.query(
      `INSERT INTO ns_accounts (username,password_salt,password_hash,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,repeat_quest_progress,redeemed_codes) VALUES ($1,$2,$3,1,0,0,'[]'::jsonb,'{}'::jsonb,0,'{"pistolKills":0,"knifeInspects":0}'::jsonb,'[]'::jsonb) RETURNING id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,repeat_quest_progress`,
      [username,passwordSalt,passwordHash]
    );
    return result.rows[0];
  }
  if (localAuth.accounts.some(row => row.username === username)) {
    const error = new Error('duplicate username'); error.code = '23505'; throw error;
  }
  const account = { id: localAuth.nextId++, username, password_salt: passwordSalt, password_hash: passwordHash, level: 1, xp: 0, neon_points: 0, owned_skins: [], equipped_skins: {}, training_quest_progress: 0, repeat_quest_progress:{pistolKills:0,knifeInspects:0}, redeemed_codes: [], daily_shop_ids: [], daily_shop_expires_at: null, owned_profiles:['default'], owned_name_colors:['default'], profile_id:'default', name_color:'default', created_at: new Date().toISOString() };
  localAuth.accounts.push(account); await persistLocalAuth(); return account;
}
async function createAuthSession(accountId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  if (authPool) await authPool.query('INSERT INTO ns_sessions (token_hash,account_id,expires_at) VALUES ($1,$2,$3)', [tokenHash, accountId, expiresAt]);
  else { localAuth.sessions = localAuth.sessions.filter(s => new Date(s.expires_at).getTime() > Date.now()); localAuth.sessions.push({ token_hash: tokenHash, account_id: Number(accountId), expires_at: expiresAt.toISOString() }); await persistLocalAuth(); }
  return token;
}
async function accountForToken(token) {
  if (!authStorageReady || !token || String(token).length > 160) return null;
  const tokenHash = hashSessionToken(token);
  if (authPool) {
    const result = await authPool.query(
      `SELECT a.id,a.username,a.level,a.xp,a.neon_points,a.owned_skins,a.equipped_skins,a.training_quest_progress,a.repeat_quest_progress,a.daily_shop_ids,a.daily_shop_expires_at,a.owned_profiles,a.owned_name_colors,a.profile_id,a.name_color FROM ns_sessions s JOIN ns_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }
  const now = Date.now();
  const session = localAuth.sessions.find(s => s.token_hash === tokenHash && new Date(s.expires_at).getTime() > now);
  return session ? (localAuth.accounts.find(a => Number(a.id) === Number(session.account_id)) || null) : null;
}
async function deleteAuthSession(token) {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  if (authPool) { await authPool.query('DELETE FROM ns_sessions WHERE token_hash=$1', [tokenHash]); return; }
  localAuth.sessions = localAuth.sessions.filter(s => s.token_hash !== tokenHash);
  await persistLocalAuth();
}
function getRequestToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}
async function accountFromToken(token) {
  if (!token || !authStorageReady) return null;
  try { return await accountForToken(token); }
  catch (error) { console.warn('[accounts] socket authentication failed:', error?.message || error); return null; }
}
async function awardAccountXP(accountId, amount) {
  const award = Math.max(0, Math.min(250, Math.floor(Number(amount) || 0)));
  if (!award || !authStorageReady) return null;
  if (authPool) {
    const client = await authPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,repeat_quest_progress,owned_profiles,owned_name_colors,profile_id,name_color FROM ns_accounts WHERE id=$1 FOR UPDATE', [accountId]);
      if (!result.rows.length) { await client.query('ROLLBACK'); return null; }
      const progression = applyExperienceProgress(result.rows[0].level, result.rows[0].xp, award);
      const updated = await client.query('UPDATE ns_accounts SET level=$2,xp=$3,updated_at=NOW() WHERE id=$1 RETURNING id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,repeat_quest_progress,owned_profiles,owned_name_colors,profile_id,name_color', [accountId,progression.level,progression.xp]);
      await client.query('COMMIT');
      return normalizeAccountPublic(updated.rows[0]);
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }
  const account = localAuth.accounts.find(row => Number(row.id) === Number(accountId));
  if (!account) return null;
  const progression = applyExperienceProgress(account.level, account.xp, award);
  account.level = progression.level; account.xp = progression.xp; account.updated_at = new Date().toISOString();
  await persistLocalAuth();
  return normalizeAccountPublic(account);
}
async function mutateAccountState(accountId, mutator) {
  if (!authStorageReady) return { ok:false, status:503, error:'계정 저장소가 준비되지 않았습니다.' };
  if (authPool) {
    const client = await authPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'SELECT id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,repeat_quest_progress,redeemed_codes,daily_shop_ids,daily_shop_expires_at,owned_profiles,owned_name_colors,profile_id,name_color FROM ns_accounts WHERE id=$1 FOR UPDATE',
        [accountId]
      );
      if (!result.rows.length) { await client.query('ROLLBACK'); return { ok:false, status:404, error:'계정을 찾을 수 없습니다.' }; }
      const model = accountStoreModel(result.rows[0]);
      const outcome = mutator(model) || { ok:true };
      if (!outcome.ok) { await client.query('ROLLBACK'); return outcome; }
      const updated = await client.query(
        `UPDATE ns_accounts SET level=$2,xp=$3,neon_points=$4,owned_skins=$5::jsonb,equipped_skins=$6::jsonb,training_quest_progress=$7,redeemed_codes=$8::jsonb,daily_shop_ids=$9::jsonb,daily_shop_expires_at=$10,owned_profiles=$11::jsonb,owned_name_colors=$12::jsonb,profile_id=$13,name_color=$14,repeat_quest_progress=$15::jsonb,updated_at=NOW()
         WHERE id=$1 RETURNING id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,repeat_quest_progress,owned_profiles,owned_name_colors,profile_id,name_color`,
        [accountId,model.level,model.xp,model.neonPoints,JSON.stringify(model.ownedSkins),JSON.stringify(model.equippedSkins),model.trainingQuestProgress,JSON.stringify(model.redeemedCodes),JSON.stringify(model.dailyShopIds||[]),model.dailyShopExpiresAt||new Date(0).toISOString(),JSON.stringify(model.ownedProfiles||['default']),JSON.stringify(model.ownedNameColors||['default']),model.profileId||'default',model.nameColor||'default',JSON.stringify(model.repeatQuestProgress||{pistolKills:0,knifeInspects:0})]
      );
      await client.query('COMMIT');
      return { ...outcome, ok:true, account:normalizeAccountPublic(updated.rows[0]) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }
  const row = localAuth.accounts.find(item => Number(item.id) === Number(accountId));
  if (!row) return { ok:false, status:404, error:'계정을 찾을 수 없습니다.' };
  const model = accountStoreModel(row);
  const outcome = mutator(model) || { ok:true };
  if (!outcome.ok) return outcome;
  Object.assign(row, {
    level:model.level, xp:model.xp, neon_points:model.neonPoints,
    owned_skins:model.ownedSkins, equipped_skins:model.equippedSkins,
    training_quest_progress:model.trainingQuestProgress, repeat_quest_progress:model.repeatQuestProgress, redeemed_codes:model.redeemedCodes,
    daily_shop_ids:model.dailyShopIds||[], daily_shop_expires_at:model.dailyShopExpiresAt||null,
    owned_profiles:model.ownedProfiles||['default'], owned_name_colors:model.ownedNameColors||['default'],
    profile_id:model.profileId||'default', name_color:model.nameColor||'default',
    updated_at:new Date().toISOString(),
  });
  await persistLocalAuth();
  return { ...outcome, ok:true, account:normalizeAccountPublic(row) };
}
function apiStorageUnavailable(res) {
  if (authStorageReady) return false;
  res.status(503).json({ error: '계정 데이터베이스가 준비되지 않았습니다. Neon PostgreSQL을 만든 뒤 Render 환경변수 DATABASE_URL에 연결 문자열을 설정하세요.' });
  return true;
}
function accountRequiredMessage(res) {
  res.status(401).json({ error:'계정에 로그인해야 이용할 수 있습니다.' });
}
app.get('/healthz', (_req, res) => res.json({ ok: true, app: 'NEON STRIKE', time: Date.now(), accounts: authStorageReady ? 'ready' : 'unavailable' }));

app.post('/api/account/register', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (!accountRateAllowed(req, 'register', 6)) return res.status(429).json({ error: '가입 요청이 많습니다. 잠시 후 다시 시도하세요.' });
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || '');
  if (!isValidUsername(username)) return res.status(400).json({ error: '아이디는 영문, 숫자, 밑줄로 3~20자여야 합니다.' });
  if (!isValidPassword(password)) return res.status(400).json({ error: '비밀번호는 8~128자여야 합니다.' });
  try {
    const passwordSalt = randomBytes(16).toString('hex');
    const passwordHash = (await scryptAsync(password, passwordSalt, 64)).toString('hex');
    const account = await insertAccount(username, passwordSalt, passwordHash);
    const token = await createAuthSession(account.id);
    res.status(201).json({ token, account: normalizeAccountPublic(account) });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    console.error('[accounts] register failed:', error?.message || error);
    res.status(500).json({ error: '회원가입 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
  }
});
app.post('/api/account/login', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (!accountRateAllowed(req, 'login', 10)) return res.status(429).json({ error: '로그인 시도가 많습니다. 잠시 후 다시 시도하세요.' });
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || '');
  if (!isValidUsername(username) || !password || password.length > 128) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  try {
    const account = await findAccountByUsername(username);
    if (!account) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    const actual = Buffer.from((await scryptAsync(password, account.password_salt, 64)).toString('hex'), 'hex');
    const expected = Buffer.from(String(account.password_hash), 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    const token = await createAuthSession(account.id);
    res.json({ token, account: normalizeAccountPublic(account) });
  } catch (error) {
    console.error('[accounts] login failed:', error?.message || error);
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
  }
});
app.get('/api/account/me', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  const token = getRequestToken(req);
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  try {
    const account = await accountForToken(token);
    if (!account) return res.status(401).json({ error: '로그인 시간이 만료되었습니다. 다시 로그인하세요.' });
    res.json({ account: normalizeAccountPublic(account) });
  } catch (error) { console.error('[accounts] profile failed:', error?.message || error); res.status(500).json({ error: '계정 정보를 불러오지 못했습니다.' }); }
});
app.post('/api/account/cosmetics', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  try {
    const account = await accountForToken(getRequestToken(req));
    if (!account) return accountRequiredMessage(res);
    const profileId = String(req.body?.profileId || 'default');
    const nameColor = String(req.body?.nameColor || 'default');
    if (!['default','pumpkin','oni'].includes(profileId) || !['default','orange','green'].includes(nameColor)) return res.status(400).json({ error:'선택한 프로필 또는 이름 색상이 올바르지 않습니다.' });
    const result = await mutateAccountState(account.id, model => {
      if (!(model.ownedProfiles||['default']).includes(profileId)) return { ok:false, status:403, error:'보유하지 않은 프로필입니다. 해당 프리미엄 번들에서 획득할 수 있습니다.' };
      if (!(model.ownedNameColors||['default']).includes(nameColor)) return { ok:false, status:403, error:'보유하지 않은 이름 색상입니다. 해당 프리미엄 번들에서 획득할 수 있습니다.' };
      model.profileId = profileId; model.nameColor = nameColor;
      return { ok:true, profileId, nameColor };
    });
    if (!result.ok) return res.status(result.status||500).json({ error:result.error||'프로필 저장에 실패했습니다.' });
    res.json({ account:result.account, profileId:result.profileId, nameColor:result.nameColor });
  } catch (error) { console.error('[account] cosmetics failed:', error?.message||error); res.status(500).json({ error:'프로필 설정을 저장하지 못했습니다.' }); }
});

app.post('/api/account/logout', async (req, res) => {
  if (!authStorageReady) return res.json({ ok: true });
  try { await deleteAuthSession(getRequestToken(req)); res.json({ ok: true }); }
  catch (error) { console.error('[accounts] logout failed:', error?.message || error); res.status(500).json({ error: '로그아웃 중 오류가 발생했습니다.' }); }
});
app.post('/api/account/xp', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  const token = getRequestToken(req);
  if (!token) return res.status(401).json({ error: 'XP를 저장하려면 로그인하세요.' });
  if (req.body?.reason !== 'training_hit') return res.status(400).json({ error: '허용되지 않은 XP 획득 사유입니다.' });
  try {
    const account = await accountForToken(token);
    if (!account) return res.status(401).json({ error: '로그인 시간이 만료되었습니다. 다시 로그인하세요.' });
    const now = Date.now(), last = trainingAwardAt.get(Number(account.id)) || 0;
    const cooldownMs = 900;
    if (now - last < cooldownMs) return res.status(429).json({ error: 'XP 지급 대기 중입니다.', retryAfterMs: Math.max(100, cooldownMs - (now - last)) });
    trainingAwardAt.set(Number(account.id), now);
    const result = await mutateAccountState(account.id, model => {
      const progression = applyExperienceProgress(model.level, model.xp, XP_TRAINING_TARGET);
      model.level = progression.level; model.xp = progression.xp;
      model.trainingQuestProgress += 1;
      let questReward = 0, questCompletions = 0;
      while (model.trainingQuestProgress >= TRAINING_QUEST_TARGET) {
        model.trainingQuestProgress -= TRAINING_QUEST_TARGET;
        model.neonPoints += TRAINING_QUEST_REWARD;
        questReward += TRAINING_QUEST_REWARD; questCompletions++;
      }
      return { ok:true, awardedXP:XP_TRAINING_TARGET, questProgress:model.trainingQuestProgress, questTarget:TRAINING_QUEST_TARGET, questReward, questCompletions, reason:'training_hit' };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '경험치 저장에 실패했습니다.' });
    res.json({ account:result.account, awardedXP:result.awardedXP, questProgress:result.questProgress, questTarget:result.questTarget, questReward:result.questReward, questCompletions:result.questCompletions, reason:result.reason });
  } catch (error) { console.error('[accounts] training XP/quest failed:', error?.message || error); res.status(500).json({ error: 'XP 저장에 실패했습니다.' }); }
});


app.post('/api/quests/training-knife-inspect', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (req.body?.reason !== 'training_knife_inspect') return res.status(400).json({ error: '잘못된 퀘스트 진행 요청입니다.' });
  if (!accountRateAllowed(req, 'quest-knife-inspect', 240, 60_000)) return res.status(429).json({ error: '관찰 퀘스트 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  try {
    const account = await accountForToken(getRequestToken(req));
    if (!account) return accountRequiredMessage(res);
    const result = await incrementRepeatQuest(account.id, 'knifeInspects', 1);
    if (!result?.ok) return res.status(result?.status || 500).json({ error: result?.error || '관찰 퀘스트 진행도를 저장하지 못했습니다.' });
    res.json({ account: result.account, questId: result.questId, progress: result.progress, target: result.target, completions: result.completions, reward: result.reward });
  } catch (error) {
    console.error('[quests] knife inspect progress failed:', error?.message || error);
    res.status(500).json({ error: '관찰 퀘스트 진행도를 저장하지 못했습니다.' });
  }
});

app.get('/api/store/state', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  try {
    const token = getRequestToken(req);
    const account = await accountForToken(token);
    if (!account) return accountRequiredMessage(res);
    const result = await mutateAccountState(account.id, model => {
      const now = Date.now();
      const expires = Date.parse(model.dailyShopExpiresAt || '');
      if (!Array.isArray(model.dailyShopIds) || model.dailyShopIds.length !== 3 || !Number.isFinite(expires) || expires <= now) {
        const pool = STORE_SKINS.map(skin => skin.id);
        for (let i=pool.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
        model.dailyShopIds = pool.slice(0,3);
        model.dailyShopExpiresAt = new Date(now + 24*60*60*1000).toISOString();
      }
      return { ok:true, dailySkinIds:[...model.dailyShopIds], dailyExpiresAt:model.dailyShopExpiresAt };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '상점 정보를 저장하지 못했습니다.' });
    res.set('Cache-Control','no-store');
    res.json({ account:result.account, dailyDate:result.dailyExpiresAt, dailyExpiresAt:result.dailyExpiresAt, dailySkinIds:result.dailySkinIds, rollCost:STORE_ROLL_COST, questTarget:TRAINING_QUEST_TARGET, questReward:TRAINING_QUEST_REWARD });
  } catch (error) { console.error('[store] state failed:', error?.message || error); res.status(500).json({ error:'상점 정보를 불러오지 못했습니다.' }); }
});

app.post('/api/store/buy', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (!accountRateAllowed(req,'store-buy',18,60_000)) return res.status(429).json({ error:'구매 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  try {
    const token = getRequestToken(req);
    const account = await accountForToken(token);
    if (!account) return accountRequiredMessage(res);
    const productType = String(req.body?.productType || '');
    const productId = String(req.body?.productId || '');
    let cost = 0, skinIds = [], profileIds = [], nameColorIds = [], productName = '';
    if (productType === 'bundle') {
      const bundle = getStoreBundle(productId);
      if (!bundle) return res.status(400).json({ error:'존재하지 않는 번들입니다.' });
      cost = bundle.price; skinIds = bundle.skinIds; profileIds = bundle.profileIds || []; nameColorIds = bundle.nameColorIds || []; productName = bundle.displayName;
    } else if (productType === 'daily') {
      const skin = getStoreSkin(productId);
      if (!skin) return res.status(400).json({ error:'존재하지 않는 스킨입니다.' });
      cost = skin.price; skinIds = [skin.id]; productName = skin.displayName;
    } else return res.status(400).json({ error:'구매 유형이 올바르지 않습니다.' });
    const result = await mutateAccountState(account.id, model => {
      const owned = new Set(model.ownedSkins);
      if (productType === 'daily' && (!(model.dailyShopIds||[]).includes(productId) || !Number.isFinite(Date.parse(model.dailyShopExpiresAt||'')) || Date.parse(model.dailyShopExpiresAt)<=Date.now())) return { ok:false, status:409, error:'오늘의 스킨 목록이 만료됐습니다. 상점을 새로고침하세요.' };
      const missing = skinIds.filter(id => !owned.has(id));
      const missingProfiles = profileIds.filter(id => !(model.ownedProfiles||['default']).includes(id));
      const missingNameColors = nameColorIds.filter(id => !(model.ownedNameColors||['default']).includes(id));
      if (!missing.length && !missingProfiles.length && !missingNameColors.length) return { ok:false, status:409, error:'이미 보유한 상품입니다.' };
      let actualCost = cost;
      if (productType === 'bundle') {
        const bundle = getStoreBundle(productId);
        const alreadyOwnedCount = bundle.skinIds.filter(id => owned.has(id)).length;
        actualCost = Math.max(0, bundle.price - alreadyOwnedCount * 60);
      }
      if (model.neonPoints < actualCost) return { ok:false, status:400, error:`네온 포인트가 부족합니다. ${actualCost} NP가 필요합니다.` };
      model.neonPoints -= actualCost;
      model.ownedSkins = [...owned, ...missing];
      model.ownedProfiles = [...new Set([...(model.ownedProfiles||['default']), ...missingProfiles])];
      model.ownedNameColors = [...new Set([...(model.ownedNameColors||['default']), ...missingNameColors])];
      return { ok:true, productName, purchasedSkinIds:missing, purchasedProfileIds:missingProfiles, purchasedNameColorIds:missingNameColors, cost:actualCost };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '구매에 실패했습니다.' });
    res.json({ account:result.account, productName:result.productName, purchasedSkinIds:result.purchasedSkinIds, purchasedProfileIds:result.purchasedProfileIds||[], purchasedNameColorIds:result.purchasedNameColorIds||[], cost:result.cost });
  } catch (error) { console.error('[store] purchase failed:', error?.message || error); res.status(500).json({ error:'구매 처리 중 오류가 발생했습니다.' }); }
});

app.post('/api/store/roll', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (!accountRateAllowed(req,'store-roll',10,60_000)) return res.status(429).json({ error:'뽑기 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  try {
    const token = getRequestToken(req);
    const account = await accountForToken(token);
    if (!account) return accountRequiredMessage(res);
    let selectedSkin = null;
    const result = await mutateAccountState(account.id, model => {
      const owned = new Set(Array.isArray(model.ownedSkins) ? model.ownedSkins : []);
      if (model.neonPoints < STORE_ROLL_COST) return { ok:false, status:400, error:`네온 포인트가 부족합니다. ${STORE_ROLL_COST} NP가 필요합니다.` };
      const unowned = STORE_SKINS.filter(skin => !owned.has(skin.id));
      if (!unowned.length) return { ok:false, status:409, error:'현재 모든 스킨을 모두 보유하고 있습니다.' };
      selectedSkin = unowned[Math.floor(Math.random() * unowned.length)];
      model.neonPoints -= STORE_ROLL_COST;
      model.ownedSkins = [...owned, selectedSkin.id];
      return { ok:true, skinId:selectedSkin.id, cost:STORE_ROLL_COST };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '뽑기에 실패했습니다.' });
    const awardedSkin = selectedSkin || getStoreSkin(result.skinId);
    if (!awardedSkin?.id || !awardedSkin?.rarity) return res.status(500).json({ error:'스킨 지급 결과를 확인하지 못했습니다. 네온 포인트가 차감되지 않았는지 계정에서 확인하세요.' });
    res.set('Cache-Control','no-store');
    res.json({ ok:true, account:result.account, skin:awardedSkin, skinId:awardedSkin.id, cost:result.cost ?? STORE_ROLL_COST });
  } catch (error) { console.error('[store] roll failed:', error?.message || error); res.status(500).json({ error:'스킨 뽑기 중 오류가 발생했습니다.' }); }
});

app.post('/api/store/redeem', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (!accountRateAllowed(req,'store-redeem',8,60_000)) return res.status(429).json({ error:'코드 입력이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  try {
    const token = getRequestToken(req);
    const account = await accountForToken(token);
    if (!account) return accountRequiredMessage(res);
    const code = String(req.body?.code || '').trim().toLowerCase();
    if (code !== 'test_neon_strike') return res.status(400).json({ error:'유효하지 않은 코드입니다.' });
    const result = await mutateAccountState(account.id, model => {
      if (model.redeemedCodes.includes(code)) return { ok:false, status:409, error:'이 코드는 이미 사용했습니다.' };
      model.redeemedCodes = [...model.redeemedCodes, code];
      model.neonPoints += 10000;
      return { ok:true, reward:10000 };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '코드를 사용할 수 없습니다.' });
    res.json({ account:result.account, reward:result.reward, message:'10,000 네온 포인트를 지급했습니다.' });
  } catch (error) { console.error('[store] redeem failed:', error?.message || error); res.status(500).json({ error:'코드 처리 중 오류가 발생했습니다.' }); }
});

app.post('/api/store/equip', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  try {
    const token = getRequestToken(req);
    const account = await accountForToken(token);
    if (!account) return accountRequiredMessage(res);
    const weaponId = String(req.body?.weaponId || '');
    const skinId = String(req.body?.skinId || '');
    if (!['pistol','revolver','smg','shotgun','rifle','dmr','sniper','lmg','burst','knife'].includes(weaponId)) return res.status(400).json({ error:'무기 종류가 올바르지 않습니다.' });
    const result = await mutateAccountState(account.id, model => {
      if (!skinId) { delete model.equippedSkins[weaponId]; return { ok:true, equippedSkinId:null, weaponId }; }
      const skin = getStoreSkin(skinId);
      if (!skin || skin.weaponId !== weaponId) return { ok:false, status:400, error:'이 무기에 사용할 수 없는 스킨입니다.' };
      if (!model.ownedSkins.includes(skinId)) return { ok:false, status:403, error:'보유한 스킨만 장착할 수 있습니다.' };
      model.equippedSkins = { ...model.equippedSkins, [weaponId]:skinId };
      return { ok:true, equippedSkinId:skinId, weaponId };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '스킨 장착에 실패했습니다.' });
    res.json({ account:result.account, weaponId:result.weaponId, equippedSkinId:result.equippedSkinId });
  } catch (error) { console.error('[store] equip failed:', error?.message || error); res.status(500).json({ error:'스킨 장착 중 오류가 발생했습니다.' }); }
});


if (isProduction) {
  app.use(express.static(distDir, { maxAge: '1h', etag: true }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/socket.io') || req.path.startsWith('/healthz')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: false },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e5,
  connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: true },
});

io.engine.on('connection_error', error => console.warn('[Socket.IO] connection error:', error?.code || '', error?.message || ''));

const PORT = Number(process.env.PORT || 3000);
const BUY_MS = 12_000;
const ROUND_MS = 90_000;
const NEXT_ROUND_MS = 5_000;
const WINS_TO_MATCH = 6;
const STARTING_CREDITS = 450;
// Generous, cumulative round economy: later rounds fund more expensive loadouts and shields.
const ROUND_WIN_REWARD = 1550;
const ROUND_LOSS_REWARD = 950;
const KILL_REWARD = 150;
const ROUND_WIN_STEP = 250;
const ROUND_LOSS_STEP = 150;
const KILL_REWARD_STEP = 25;
// Server-authoritative weapon definitions. Keep IDs and balance in sync with src/main.js.
// These entries were missing in the previous build, causing ReferenceError inside the
// buy/equip/fire Socket.IO handlers and making every online shot fail before damage.
const MAX_SHOT_DISTANCE = 500;
const weapons = Object.freeze({
  pistol:   { slot: 'sidearm', price: 0,    damage: 10, rate: 0.32, distanceSpread: 0.00014, recoil:0.012 },
  revolver: { slot: 'sidearm', price: 550,  damage: 30, rate: 0.52, distanceSpread: 0.00007, recoil:0.018 },
  smg:      { slot: 'primary', price: 850,  damage: 7, rate: 0.12, distanceSpread: 0.00042, recoil:0.042 },
  shotgun:  { slot: 'primary', price: 1100, damage: 6.5, rate: 0.86, pellets: 10, spread: 0.105, distanceSpread: 0.00110, recoil:0.075 },
  rifle:    { slot: 'primary', price: 1950, damage: 15, rate: 0.13, distanceSpread: 0.00013, recoil:0.023 },
  dmr:      { slot: 'primary', price: 2200, damage: 20, rate: 0.32, distanceSpread: 0.00004, recoil:0.010 },
  sniper:   { slot: 'primary', price: 3000, damage: 78, rate: 1.12, distanceSpread: 0.000015, recoil:0.012 },
  lmg:      { slot: 'primary', price: 2500, damage: 16, rate: 0.115, distanceSpread: 0.00038, recoil:0.048 },
  burst:    { slot: 'primary', price: 1600, damage: 14, rate: 0.30, distanceSpread: 0.00016, recoil:0.024, burstCount: 3, burstGap: 0.055 },
  knife:    { slot: 'melee', price: 0, damage: 40, rate: 0.48, range: 2.65, distanceSpread: 0, recoil:0.002 },
});
const rooms = new Map();
const mapCoverBoxes = {
  arena: [
    {x:0,z:-34,w:70,d:1.4,h:5},{x:0,z:34,w:70,d:1.4,h:5},{x:-34,z:0,w:1.4,d:70,h:5},{x:34,z:0,w:1.4,d:70,h:5},
    {x:-15,z:-12,w:7,d:3,h:2.6},{x:-3,z:-14,w:4,d:4,h:1.5},{x:10,z:-12,w:7,d:3,h:2.8},
    {x:-19,z:0,w:3,d:8,h:2.2},{x:-8,z:-1,w:5,d:3,h:1.4},{x:6,z:2,w:4,d:5,h:2.4},{x:19,z:0,w:3,d:8,h:2.2},
    {x:-13,z:15,w:8,d:3,h:2.6},{x:0,z:13,w:5,d:4,h:1.5},{x:13,z:15,w:8,d:3,h:2.6},{x:-2,z:0,w:2,d:2,h:3.6},
    ...[-20,20].flatMap(z=>[ {x:-18,z,w:10,d:1.35,h:6.2},{x:0,z,w:14,d:1.35,h:6.2},{x:18,z,w:10,d:1.35,h:6.2} ]),
    {x:-10,z:-8,w:1.6,d:10,h:6.8},{x:10,z:8,w:1.6,d:10,h:6.8},
    {x:-28,z:-27,w:.7,d:.7,h:4},{x:28,z:27,w:.7,d:.7,h:4},{x:-28,z:27,w:.7,d:.7,h:4},{x:28,z:-27,w:.7,d:.7,h:4}
  ],
  palace: [
    {x:0,z:-47.3,w:95,d:1.5,h:3.2},{x:0,z:47.3,w:95,d:1.5,h:3.2},{x:-47.3,z:0,w:1.5,d:95,h:3.2},{x:47.3,z:0,w:1.5,d:95,h:3.2},
    {x:0,z:-27,w:30,d:10,h:4.8},{x:0,z:-21.75,w: .62,d:.72,h:5.9},
    {x:-24,z:-17,w:9,d:6,h:3.6},{x:24,z:-17,w:9,d:6,h:3.6},
    ...[-7,4,16,28].flatMap(z=>[{x:-20,z,w:10,d:1.2,h:1.18},{x:20,z,w:10,d:1.2,h:1.18},{x:-8,z:z+2,w:4,d:1.1,h:.92},{x:8,z:z-2,w:4,d:1.1,h:.92}]),
    ...[-33,33].flatMap(z=>[ {x:-24,z,w:10,d:1.35,h:5.8},{x:0,z,w:13,d:1.35,h:5.8},{x:24,z,w:10,d:1.35,h:5.8} ]),
  ],
  city: [
    ...[-59, -15, 15].map(a=>({x:(a===-59?-37:a===-15?0:37),z:-59.8,w:a===-59?44: a===-15?10:44,d:1.5,h:7})),
    ...[-59, -15, 15].map(a=>({x:(a===-59?-37:a===-15?0:37),z:59.8,w:a===-59?44: a===-15?10:44,d:1.5,h:7})),
    ...[-59, -15, 15].map(a=>({x:-59.8,z:(a===-59?-37:a===-15?0:37),w:1.5,d:a===-59?44:a===-15?10:44,h:7})),
    ...[-59, -15, 15].map(a=>({x:59.8,z:(a===-59?-37:a===-15?0:37),w:1.5,d:a===-59?44:a===-15?10:44,h:7})),
    {x:-31,z:-29,w:14,d:16,h:7},{x:31,z:18,w:13,d:15,h:5.5},
    ...[[-43,-6,12,17,8],[-16,-31,9,12,5],[18,-31,15,12,8],[45,-17,10,16,7],[-45,22,13,18,9],[13,40,18,10,6],[43,39,15,13,8],[-12,39,13,11,6]].map(([x,z,w,d,h])=>({x,z,w,d,h})),
    ...[[-20,-4],[20,4],[-19,20],[19,-19]].map(([x,z])=>({x,z,w:10,d:6,h:3.4})),
    {x:0,z:29,w:11,d:7,h:1.65},{x:-5.1,z:29,w:1,d:9,h:2.5},{x:5.1,z:29,w:1,d:9,h:2.5},
    ...[[-8,-17],[8,17],[-8,39],[8,-39]].map(([x,z])=>({x,z,w:4,d:1.4,h:1.35})),
    // Short high cover at the spawn sight line, leaving wide routes around each segment.
    ...[-43,43].flatMap(z=>[ {x:-18,z,w:11,d:1.55,h:7.1},{x:0,z,w:14,d:1.55,h:7.1},{x:18,z,w:11,d:1.55,h:7.1} ]),
  ]
};
function isShotBlocked(origin, direction, maxDistance, mapId='arena') {
  let nearest = maxDistance;
  for (const box of mapCoverBoxes[mapId] || mapCoverBoxes.arena) {
    let tMin = 0, tMax = maxDistance;
    for (const axis of ['x','z']) {
      const d = direction[axis], p = origin[axis], half = box[axis === 'x' ? 'w' : 'd'] / 2;
      const min = box[axis] - half, max = box[axis] + half;
      if (Math.abs(d) < 1e-7) { if (p < min || p > max) { tMin = Infinity; break; } }
      else {
        let a = (min-p)/d, b = (max-p)/d;
        if (a>b) [a,b] = [b,a];
        tMin = Math.max(tMin,a); tMax = Math.min(tMax,b);
      }
    }
    if (tMin <= tMax && tMax >= 0 && tMin < nearest) {
      const t = Math.max(0,tMin), y = origin.y + direction.y*t;
      if (y >= 0 && y <= box.h) nearest = t;
    }
  }
  return nearest < maxDistance - .12;
}
function mapBounds(mapId){return mapId==='city'?66:mapId==='palace'?45.5:31.8;}
function mapSpawn(mapId){return mapId==='city'?52:mapId==='palace'?40:27;}

function code6() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function safeName(name) { return String(name || 'PLAYER').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'PLAYER'; }
function safeSessionId(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100); }
function compatible(rule, device) { return rule === 'crossplay' || rule === device; }
function isTeamsMode(room) { return room?.teamMode === '2v2'; }
function roomRequiredPlayers(room) { return isTeamsMode(room) ? 4 : 2; }
function roomTeamCounts(room) {
  const counts={red:0,blue:0};
  for (const player of room?.players?.values?.() || []) if (player.team==='red'||player.team==='blue') counts[player.team]++;
  return counts;
}
function roomIsReady(room) {
  if (!room || room.players.size !== roomRequiredPlayers(room) || [...room.players.values()].some(p=>p.connected===false)) return false;
  const counts=roomTeamCounts(room);
  return isTeamsMode(room) ? counts.red===2&&counts.blue===2 : counts.red===1&&counts.blue===1;
}
function roomScoreSnapshot(room) {
  return Object.fromEntries([...room.players.entries()].map(([id,p])=>[id,isTeamsMode(room)?(room.teamScores?.[p.team]||0):(p.score||0)]));
}
function publicPlayer(p) { return { x:p.x, y:p.y||0, z:p.z, yaw:p.yaw, pitch:p.pitch, name:p.name, level:p.level||1, profileId:p.profileId||'default', nameColor:p.nameColor||'default', team:p.team||'red', hp:p.hp, armor:p.armor, weapon:p.weapon, skinId:p.equippedSkins?.[p.weapon]||null, equippedSkins:p.equippedSkins||{}, device:p.device, score:p.score }; }
function playerById(room, id) { return room?.players.get(id); }
function roomLobbySnapshot(room) {
  return { code:room.code, hostId:room.hostId, phase:room.phase, map:room.map||'arena', mode:room.mode||'classic', teamMode:room.teamMode||'1v1', players:[...room.players.entries()].map(([id,p])=>({id,...publicPlayer(p),connected:p.connected!==false})), maxPlayers:roomRequiredPlayers(room), teamCounts:roomTeamCounts(room) };
}
function emitRoomLobby(room) { if(room&&rooms.has(room.code))io.to(room.code).emit('roomLobby',roomLobbySnapshot(room)); }
function selfPayload(p) { return { money:p.money, hp:p.hp, armor:p.armor, armorTier:p.armorTier, weapon:p.weapon, skinId:p.equippedSkins?.[p.weapon]||null, ownedWeapons:[...(p.ownedWeapons||['pistol','knife'])], boughtPrimary:p.boughtPrimary, armorPurchased:p.armorPurchased, team:p.team||'red', x:p.x, y:p.y||0, z:p.z, yaw:p.yaw, pitch:p.pitch }; }
function playersSnapshot(room) { return Object.fromEntries([...room.players.entries()].map(([id,p])=>[id,publicPlayer(p)])); }
function emitState(room) {
  const players = playersSnapshot(room);
  for (const [id,p] of room.players) {
    io.to(id).emit('roundState', {
      code: room.code, map: room.map || 'arena', mode:room.mode||'classic', teamMode:room.teamMode||'1v1', phase: room.phase, round: room.round, endsAt: room.phaseEndsAt,
      roundEndsAt: room.liveEndsAt, scores: roomScoreSnapshot(room), teamScores:room.teamScores||{red:0,blue:0},
      self: selfPayload(p), players,
    });
  }
}
function resetPlayerForRound(room, p, index) {
  p.hp = 100;
  p.armor = Math.max(0, p.armor);
  if (p.armor <= 0) p.armorTier = 'none';
  if(room.mode==='knife') { p.ownedWeapons=['knife']; p.weapon='knife'; }
  else { p.ownedWeapons=['pistol','knife']; p.weapon='pistol'; }
  if(room.mode==='unlimited') p.money=999999;
  p.boughtPrimary = false;
  p.armorPurchased = p.armorTier === 'heavy';
  p.lastFireAt = 0;
  p.recoilHeat = 0;
  p.dead = false;
  const spawn=mapSpawn(room.map);
  if (isTeamsMode(room)) {
    const sidePlayers=[...room.players.values()].filter(candidate=>candidate.team===p.team);
    const sideIndex=Math.max(0,sidePlayers.indexOf(p));
    p.x=sideIndex===0?-4:4;
    p.y=0;
    p.z=p.team==='red'?spawn:-spawn;
    p.yaw=p.team==='red'?0:Math.PI;
  } else {
    p.x = index === 0 ? -3 : 3;
    p.y = 0;
    p.z = index === 0 ? spawn : -spawn;
    p.yaw = index === 0 ? 0 : Math.PI;
  }
  p.pitch = 0;
}
function beginRound(room) {
  if (!rooms.has(room.code) || !roomIsReady(room)) return;
  room.phaseBeforeDisconnect=null;room.remainingPhaseMs=0;
  if (room.timer) clearTimeout(room.timer);
  room.round += 1;
  room.phase = 'buy';
  room.phaseEndsAt = Date.now() + BUY_MS;
  room.liveEndsAt = room.phaseEndsAt + ROUND_MS;
  [...room.players.values()].forEach((p,i)=>resetPlayerForRound(room,p,i));
  if(room.mode==='knife') {
    room.phase='live'; room.phaseEndsAt=Date.now()+ROUND_MS; room.liveEndsAt=room.phaseEndsAt;
    emitState(room); io.to(room.code).emit('roundPhase',{phase:'live',round:room.round,endsAt:room.phaseEndsAt,mode:room.mode});
    room.timer=setTimeout(()=>resolveTimedRound(room),ROUND_MS);
    return;
  }
  room.phase='buy'; room.phaseEndsAt=Date.now()+BUY_MS; room.liveEndsAt=room.phaseEndsAt+ROUND_MS;
  emitState(room);
  room.timer = setTimeout(() => startLive(room), BUY_MS);
}
function startLive(room) {
  if (!rooms.has(room.code) || !roomIsReady(room) || room.phase !== 'buy') return;
  room.phase = 'live';
  room.phaseEndsAt = Date.now() + ROUND_MS;
  room.liveEndsAt = room.phaseEndsAt;
  io.to(room.code).emit('roundPhase', { phase:'live', round:room.round, endsAt:room.phaseEndsAt });
  room.timer = setTimeout(() => resolveTimedRound(room), ROUND_MS);
}
function resolveTimedRound(room) {
  if (!room || room.phase !== 'live' || !roomIsReady(room)) return;
  if (isTeamsMode(room)) {
    const totals={red:0,blue:0};
    for (const player of room.players.values()) if (player.hp>0) totals[player.team]+=player.hp+player.armor*.25;
    if (Math.abs(totals.red-totals.blue)<1) endRound(room,null,'시간 종료 · 팀 체력 동률');
    else {
      const winningTeam=totals.red>totals.blue?'red':'blue';
      const winner=[...room.players.entries()].find(([,player])=>player.team===winningTeam&&player.hp>0)?.[0]||null;
      endRound(room,winner,`시간 종료 · ${winningTeam==='red'?'레드':'블루'} 팀 체력 우세`);
    }
    return;
  }
  const entries = [...room.players.entries()];
  const [idA,a] = entries[0], [idB,b] = entries[1];
  const ratioA = a.hp + a.armor * .25, ratioB = b.hp + b.armor * .25;
  if (Math.abs(ratioA-ratioB)<1) endRound(room,null,'시간 종료 · 체력 동률');
  else endRound(room,ratioA>ratioB?idA:idB,'시간 종료 · 체력 우세');
}
function restoreRoomPhaseAfterDisconnect(room) {
  if (!room?.phaseBeforeDisconnect) return;
  const phase = room.phaseBeforeDisconnect;
  const remaining = Math.max(1000, Number(room.remainingPhaseMs) || 1000);
  room.phaseBeforeDisconnect = null;
  room.remainingPhaseMs = 0;
  room.phase = phase;
  if (phase === 'buy') {
    room.phaseEndsAt = Date.now() + remaining;
    room.liveEndsAt = room.phaseEndsAt + ROUND_MS;
    room.timer = setTimeout(() => startLive(room), remaining);
  } else if (phase === 'live') {
    room.phaseEndsAt = Date.now() + remaining;
    room.liveEndsAt = room.phaseEndsAt;
    room.timer = setTimeout(() => resolveTimedRound(room), remaining);
  } else if (phase === 'waiting') {
    room.phaseEndsAt = 0;
    room.liveEndsAt = 0;
  }
}
function emitKillPresentation(room,killerId,victimId,skinId=null) {
  const killer=room?.players.get(killerId),victim=room?.players.get(victimId);
  if(!killer||!victim)return;
  const killPayload={killerId,victimId,durationMs:5000,skinId:skinId||killer.equippedSkins?.[killer.weapon]||null,
    killer:{x:killer.x,y:killer.y||0,z:killer.z,yaw:killer.yaw,pitch:killer.pitch,weapon:killer.weapon,name:killer.name},
    victim:{x:victim.x,y:victim.y||0,z:victim.z,yaw:victim.yaw,pitch:victim.pitch,name:victim.name}};
  io.to(victimId).emit('killCamStart',killPayload);
  io.to(killerId).emit('killerKillEffect',killPayload);
  io.to(killerId).emit('killerFreedom',{durationMs:5000,killerId});
}
function endRound(room, winnerId, reason='적 처치', killInfo=null) {
  if (!room || room.phase !== 'live') return;
  if (room.timer) clearTimeout(room.timer);
  room.phase='ended';room.lastWinnerId=winnerId;room.lastReason=reason;
  const winner = winnerId ? room.players.get(winnerId) : null;
  const winnerTeam = winner?.team || null;
  room.lastWinnerTeam=winnerTeam;
  let matchOver=false;
  if (isTeamsMode(room)) {
    if (winnerTeam) room.teamScores[winnerTeam]=(room.teamScores[winnerTeam]||0)+1;
    for (const player of room.players.values()) player.score=room.teamScores[player.team]||0;
    matchOver=!!winnerTeam&&(room.teamScores[winnerTeam]||0)>=WINS_TO_MATCH;
  } else {
    if (winner) winner.score += 1;
    matchOver = [...room.players.values()].some(p=>p.score>=WINS_TO_MATCH);
  }
  const scoreSnapshot=roomScoreSnapshot(room);
  const winningPlayers=winner ? [...room.players.values()].filter(p=>isTeamsMode(room)?p.team===winnerTeam:p.id===winnerId) : [];
  for (const player of winningPlayers) if(player.accountId) {
    void (async () => {
      let profile = await awardAccountXP(player.accountId, 50);
      if (matchOver) profile = await awardAccountXP(player.accountId, 200);
      if (profile) io.to(player.id).emit('accountUpdated', { account: profile });
    })().catch(error => console.error('[accounts] online XP award failed:', error?.message || error));
  }
  for (const [id,p] of room.players) {
    const won = !!winner && (isTeamsMode(room)?p.team===winnerTeam:id===winnerId);
    const roundBonus=Math.max(0,room.round-1);
    const reward = won?(ROUND_WIN_REWARD+roundBonus*ROUND_WIN_STEP):(ROUND_LOSS_REWARD+roundBonus*ROUND_LOSS_STEP);
    if(room.mode==='unlimited') p.money=999999; else p.money += reward;
    io.to(id).emit('roundResult', {
      winnerId, winnerTeam, reason, scores:scoreSnapshot, teamScores:room.teamScores||null,
      selfMoney:p.money, reward, matchOver, round:room.round, nextRoundInMs:0, killCamMs:killInfo?5000:0,
    });
  }
  if (matchOver) {
    room.phase='matchover';room.lastMatchOver=true;
    return;
  }
  room.timer=null;
}
function closeRoom(room) {
  if (room?.timer) clearTimeout(room.timer);
  if (room) { for (const p of room.players.values()) if (p.reconnectTimer) clearTimeout(p.reconnectTimer); rooms.delete(room.code); }
}
function leaveRoom(socket, announce=true) {
  const code=socket.data.roomCode;
  if (!code) return;
  const room=rooms.get(code);
  socket.data.roomCode=null;
  socket.leave(code);
  if (!room) return;
  const existing=room.players.get(socket.id);
  if(existing?.reconnectTimer)clearTimeout(existing.reconnectTimer);
  room.players.delete(socket.id);
  if (announce) io.to(code).emit('playerLeft',{id:socket.id});
  if (room.players.size===0) closeRoom(room);
  else {
    if (room.timer) clearTimeout(room.timer);
    room.timer=null;room.phase='waiting';room.phaseEndsAt=0;room.liveEndsAt=0;
    if(!room.players.has(room.hostId))room.hostId=room.players.keys().next().value;
    io.to(code).emit('roomMessage',{message:'상대가 나갔습니다. 새 플레이어가 참가하거나 다시 연결할 때까지 대기합니다.'});
    emitRoomLobby(room);
  }
}
function suspendDisconnectedSocket(socket) {
  const code=socket.data.roomCode;
  const room=rooms.get(code);
  if(!room)return;
  const p=room.players.get(socket.id);
  if(!p)return;
  p.connected=false;
  if(room.timer)clearTimeout(room.timer);
  room.timer=null;
  // Pause the current round rather than resetting the match when a network blip occurs.
  if(!room.phaseBeforeDisconnect){
    room.phaseBeforeDisconnect=room.phase;
    const deadline=room.phase==='buy'?room.phaseEndsAt:room.phase==='live'?room.liveEndsAt:0;
    room.remainingPhaseMs=deadline?Math.max(1000,deadline-Date.now()):0;
  }
  io.to(code).emit('roomMessage',{message:`${p.name} 연결이 끊겼습니다. 현재 라운드를 보존하고 90초 동안 재연결을 기다립니다.`});
  if(p.reconnectTimer)clearTimeout(p.reconnectTimer);
  p.reconnectTimer=setTimeout(()=>{
    const currentRoom=rooms.get(code);if(!currentRoom)return;
    const entry=[...currentRoom.players.entries()].find(([,candidate])=>candidate.sessionId===p.sessionId);
    if(!entry)return;
    const [oldId,stale]=entry;currentRoom.players.delete(oldId);stale.reconnectTimer=null;
    io.to(code).emit('playerLeft',{id:oldId});
    if(currentRoom.timer)clearTimeout(currentRoom.timer);
    currentRoom.timer=null;currentRoom.phase='waiting';currentRoom.phaseEndsAt=0;currentRoom.liveEndsAt=0;currentRoom.phaseBeforeDisconnect=null;currentRoom.remainingPhaseMs=0;
    if(currentRoom.players.size===0)closeRoom(currentRoom);
    else { if(!currentRoom.players.has(currentRoom.hostId))currentRoom.hostId=currentRoom.players.keys().next().value; io.to(code).emit('roomMessage',{message:'상대의 재연결 시간이 만료되었습니다. 새 플레이어가 참가할 수 있습니다.'}); emitRoomLobby(currentRoom); }
  },90000);
  p.reconnectTimer.unref?.();
}

function resumePlayer(socket,payload) {
  const code=String(payload?.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
  const sessionId=safeSessionId(payload?.sessionId);
  const room=rooms.get(code);
  if(!room||!sessionId){socket.emit('roomError',{message:'재연결 정보를 찾을 수 없습니다. 새 방을 만들거나 방 코드로 다시 참가하세요.'});return;}
  const entry=[...room.players.entries()].find(([,p])=>p.sessionId===sessionId);
  if(!entry){socket.emit('roomError',{message:'재연결 대기 시간이 끝났습니다. 방 코드를 다시 입력해 주세요.'});return;}
  const [oldId,p]=entry;
  if(p.reconnectTimer)clearTimeout(p.reconnectTimer);
  p.reconnectTimer=null;p.connected=true;p.id=socket.id;
  if(room.hostId===oldId)room.hostId=socket.id;
  if(oldId!==socket.id)room.players.delete(oldId);
  room.players.set(socket.id,p);socket.data.roomCode=code;socket.data.sessionId=sessionId;socket.join(code);
  if(oldId!==socket.id)io.to(code).emit('playerLeft',{id:oldId});
  socket.emit('roomResumed',{code,map:room.map,rule:room.rule,mode:room.mode,teamMode:room.teamMode,phase:room.phase,round:room.round});
  socket.emit('playersSnapshot',playersSnapshot(room));
  if(room.phase==='waiting')emitRoomLobby(room);
  if(room.phase!=='waiting'&&room.players.size===roomRequiredPlayers(room)&&[...room.players.values()].every(candidate=>candidate.connected!==false)){
    restoreRoomPhaseAfterDisconnect(room);
    io.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    if(room.phase==='waiting')emitRoomLobby(room);
    else if(room.phase==='ended'||room.phase==='matchover'){
      for(const [pid,player] of room.players){io.to(pid).emit('roundResult',{winnerId:room.lastWinnerId??null,reason:room.lastReason||'라운드 종료',scores:roomScoreSnapshot(room),teamScores:room.teamScores||null,winnerTeam:room.lastWinnerTeam||null,selfMoney:player.money,reward:0,matchOver:room.phase==='matchover',round:room.round,nextRoundInMs:0});}
    } else emitState(room);
  }
}

io.on('connection', socket => {
  socket.on('error', error => console.warn('[Socket.IO] socket error:', socket.id, error?.message || error));
  if (socket.data.roomCode === undefined) socket.data.roomCode=null;
  socket.on('createRoom', async payload => {
    const authenticatedAccount = await accountFromToken(payload?.authToken);
    const name=safeName(payload?.name), device=payload?.device==='mobile'?'mobile':'pc', sessionId=safeSessionId(payload?.sessionId);
    const requestedRule=['pc','mobile','crossplay'].includes(payload?.rule)?payload.rule:'crossplay';
    const requestedMap=['arena','palace','city'].includes(payload?.map)?payload.map:'arena';
    if (!compatible(requestedRule,device)) {
      socket.emit('roomError',{message:requestedRule==='pc'?'PC끼리 모드는 PC를 선택해야 합니다.':'모바일끼리 모드는 모바일을 선택해야 합니다.'});return;
    }
    leaveRoom(socket,false);
    const code=code6();
    const p={id:socket.id,sessionId,name,device,accountId:authenticatedAccount?.id??null,level:Math.max(1,Number(authenticatedAccount?.level)||1),profileId:String(authenticatedAccount?.profile_id??authenticatedAccount?.profileId??'default'),nameColor:String(authenticatedAccount?.name_color??authenticatedAccount?.nameColor??'default'),equippedSkins:parseJsonValue(authenticatedAccount?.equipped_skins??authenticatedAccount?.equippedSkins,{}),team:'red',connected:true,x:0,y:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol','knife'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0,activeBurstId:null,burstNextSeq:1,burstStartedAt:0,reconnectTimer:null};
    const room={code,rule:requestedRule,map:requestedMap,mode:'classic',teamMode:'1v1',teamScores:{red:0,blue:0},hostId:socket.id,players:new Map([[socket.id,p]]),phase:'waiting',round:0,phaseEndsAt:0,liveEndsAt:0,timer:null,hasStarted:false};
    rooms.set(code,room);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomCreated',{code,rule:requestedRule,device,map:room.map,mode:room.mode,hostId:room.hostId});
    emitRoomLobby(room);
  });
  socket.on('joinRoom', async payload => {
    const authenticatedAccount = await accountFromToken(payload?.authToken);
    const code=String(payload?.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    const room=rooms.get(code);
    if (!room) {socket.emit('roomError',{message:'방을 찾을 수 없습니다. 코드가 정확한지 확인하세요.'});return;}
    if (room.phase!=='waiting') {socket.emit('roomError',{message:'이미 게임이 시작된 방에는 참가할 수 없습니다.'});return;}
    if (room.players.size>=roomRequiredPlayers(room)) {socket.emit('roomError',{message:`이미 ${roomRequiredPlayers(room)}명이 참가한 방입니다.`});return;}
    const device=payload?.device==='mobile'?'mobile':'pc';
    const sessionId=safeSessionId(payload?.sessionId);
    if (!compatible(room.rule,device)) {
      const message=room.rule==='pc'?'이 방은 PC끼리 대전하는 방입니다. PC 기기 선택 후 참가하세요.':room.rule==='mobile'?'이 방은 모바일끼리 대전하는 방입니다. 모바일 기기 선택 후 참가하세요.':'기기 설정을 확인하세요.';
      socket.emit('roomError',{message});return;
    }
    leaveRoom(socket,false);
    const name=safeName(payload?.name);
    const counts=roomTeamCounts(room);const assignedTeam=counts.red<=counts.blue?'red':'blue';
    const p={id:socket.id,sessionId,name,device,accountId:authenticatedAccount?.id??null,level:Math.max(1,Number(authenticatedAccount?.level)||1),profileId:String(authenticatedAccount?.profile_id??authenticatedAccount?.profileId??'default'),nameColor:String(authenticatedAccount?.name_color??authenticatedAccount?.nameColor??'default'),equippedSkins:parseJsonValue(authenticatedAccount?.equipped_skins??authenticatedAccount?.equippedSkins,{}),team:assignedTeam,connected:true,x:0,y:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol','knife'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0,activeBurstId:null,burstNextSeq:1,burstStartedAt:0,reconnectTimer:null};
    room.players.set(socket.id,p);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomJoined',{code,rule:room.rule,device,map:room.map,mode:room.mode,hostId:room.hostId});
    socket.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    socket.emit('playersSnapshot',playersSnapshot(room));
    emitRoomLobby(room);
  });
  socket.on('updateRoomSettings',payload=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||socket.id!==room.hostId||room.phase!=='waiting')return;
    const requestedTeamMode=payload?.teamMode==='2v2'?'2v2':'1v1';
    const requestedLimit=requestedTeamMode==='2v2'?4:2;
    if(room.players.size>requestedLimit){socket.emit('roomError',{message:'현재 참가 인원이 많아 모드를 변경할 수 없습니다. 먼저 인원을 줄여 주세요.'});return;}
    const mode=['classic','unlimited','knife'].includes(payload?.mode)?payload.mode:room.mode;
    const map=['arena','palace','city'].includes(payload?.map)?payload.map:room.map;
    if(requestedTeamMode!==room.teamMode){
      room.teamMode=requestedTeamMode;
      [...room.players.values()].forEach((player,index)=>{player.team=index%2===0?'red':'blue';});
    }
    room.mode=mode;room.map=map;emitRoomLobby(room);
  });
  socket.on('assignPlayerTeam',payload=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||socket.id!==room.hostId||room.phase!=='waiting'||room.teamMode!=='2v2')return;
    const targetId=String(payload?.playerId||'');const team=payload?.team==='blue'?'blue':'red';
    const target=room.players.get(targetId);if(!target)return;
    if(target.team===team)return;
    const full=[...room.players.entries()].filter(([id,player])=>id!==targetId&&player.team===team);
    target.team=team;
    if(full.length>=2){const [swapId,swapPlayer]=full[full.length-1];swapPlayer.team=payload?.swap==='none'?swapPlayer.team:(team==='red'?'blue':'red');}
    emitRoomLobby(room);
  });
  socket.on('startMatch',()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||socket.id!==room.hostId||room.phase!=='waiting')return;
    if(!roomIsReady(room)){socket.emit('roomError',{message:room.teamMode==='2v2'?'4명이 참가하고 레드 2명·블루 2명으로 팀을 배치해야 시작할 수 있습니다.':'두 명이 참가해야 시작할 수 있습니다.'});emitRoomLobby(room);return;}
    room.hasStarted=true;io.to(room.code).emit('matchStarting',{map:room.map,mode:room.mode,teamMode:room.teamMode,hostId:room.hostId});beginRound(room);
  });
  socket.on('resumeRoom', payload => resumePlayer(socket,payload));
  socket.on('weaponInspect', payload => {
    const room=rooms.get(socket.data.roomCode);const player=playerById(room,socket.id);
    if(!room||!player||player.connected===false||!['live','buy'].includes(room.phase))return;
    const weaponId=String(payload?.weaponId||'');const skinId=String(payload?.skinId||'');
    if(weaponId!=='sniper'||player.weapon!=='sniper'||skinId!=='prime_sniper'||player.equippedSkins?.sniper!=='prime_sniper')return;
    const now=Date.now();if(now-(player.lastInspectAt||0)<900)return;player.lastInspectAt=now;
    io.to(room.code).emit('weaponInspect',{id:socket.id,weaponId,skinId,startedAt:now});
  });
  socket.on('move', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);if(!p||p.connected===false||!payload)return;
    const x=Number(payload.x),y=Number(payload.y??0),z=Number(payload.z),yaw=Number(payload.yaw),pitch=Number(payload.pitch);
    if (![x,y,z,yaw,pitch].every(Number.isFinite))return;
    const bound=mapBounds(room.map);p.x=Math.max(-bound,Math.min(bound,x));p.y=Math.max(0,Math.min(8,y));p.z=Math.max(-bound,Math.min(bound,z));p.yaw=Math.max(-Math.PI*2,Math.min(Math.PI*2,yaw));p.pitch=Math.max(-1.35,Math.min(1.35,pitch));
    socket.to(room.code).emit('playerMoved',{id:socket.id,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:p.pitch,name:p.name,hp:p.hp,team:p.team,weapon:p.weapon,skinId:p.equippedSkins?.[p.weapon]||null,equippedSkins:p.equippedSkins||{},device:p.device});
  });
  socket.on('footstep', () => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);if(!room||!p||p.connected===false||room.phase!=='live')return;
    const now=Date.now();if(now-(p.lastFootstepAt||0)<330)return;p.lastFootstepAt=now;
    socket.to(room.code).emit('footstep',{id:socket.id,x:p.x,z:p.z});
  });
  socket.on('buy', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);
    if(!room||!p||room.phase!=='buy'){socket.emit('buyResult',{ok:false,message:'구매 단계에서만 살 수 있습니다.'});return;}
    if(room.mode==='knife'){socket.emit('buyResult',{ok:false,message:'나이프 모드에서는 칼만 사용할 수 있습니다.'});return;}
    const unlimited=room.mode==='unlimited';
    if(payload?.kind==='armor'){
      const tier=payload?.tier==='heavy'?'heavy':'light';
      const gear=tier==='heavy'?{cost:1000,value:110,name:'중량 보호막'}:{cost:400,value:60,name:'경량 보호막'};
      if(tier==='light'&&p.armorTier!=='none'){socket.emit('buyResult',{ok:false,message:'이미 보호막을 보유 중입니다. 중량 보호막으로 강화할 수 있습니다.'});return;}
      if(tier==='heavy'&&p.armorTier==='heavy'){socket.emit('buyResult',{ok:false,message:'이미 중량 보호막을 보유하고 있습니다.'});return;}
      if(p.money<gear.cost){socket.emit('buyResult',{ok:false,message:'크레딧이 부족합니다.'});return;}
      if(!unlimited)p.money-=gear.cost;p.armor=gear.value;p.armorTier=tier;p.armorPurchased=tier==='heavy';
      socket.emit('buyResult',{ok:true,message:`${gear.name} 장착 완료`,money:p.money,armor:p.armor,armorTier:p.armorTier,armorPurchased:p.armorPurchased,weapon:p.weapon,boughtPrimary:p.boughtPrimary});
      return;
    }
    const id=String(payload?.weaponId||'');const w=weapons[id];
    if(id==='knife'){socket.emit('buyResult',{ok:false,message:'칼은 항상 지급됩니다.'});return;}
    if(!w){socket.emit('buyResult',{ok:false,message:'알 수 없는 무기입니다.'});return;}
    p.ownedWeapons ||= ['pistol','knife'];
    if(p.ownedWeapons.includes(id)){
      p.weapon=id;
      socket.emit('buyResult',{ok:true,message:`${id.toUpperCase()} 장착`,money:p.money,armor:p.armor,armorTier:p.armorTier,weapon:p.weapon,ownedWeapons:p.ownedWeapons,boughtPrimary:p.boughtPrimary,armorPurchased:p.armorPurchased});
      return;
    }
    if(w.slot==='primary'&&p.boughtPrimary){socket.emit('buyResult',{ok:false,message:'이번 구매 단계에 새 주무기는 하나만 살 수 있습니다.'});return;}
    if(p.money<w.price){socket.emit('buyResult',{ok:false,message:'크레딧이 부족합니다.'});return;}
    if(w.slot==='primary'){
      if(!unlimited)p.money-=w.price;p.boughtPrimary=true;
      p.ownedWeapons=p.ownedWeapons.filter(ownedId=>weapons[ownedId]?.slot!=='primary');
      p.ownedWeapons.push(id);
    } else {
      if(id!=='pistol'&&!unlimited)p.money-=w.price;
      p.ownedWeapons.push(id);
    }
    p.weapon=id;
    socket.emit('buyResult',{ok:true,message:`${id.toUpperCase()} 구매/장착 완료`,money:p.money,armor:p.armor,armorTier:p.armorTier,weapon:p.weapon,ownedWeapons:p.ownedWeapons,boughtPrimary:p.boughtPrimary,armorPurchased:p.armorPurchased});
  });
  socket.on('equipWeapon', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);const id=String(payload?.weaponId||'');
    if(!room||!p||!['buy','live'].includes(room.phase)){socket.emit('equipResult',{ok:false,message:'현재는 무기를 교체할 수 없습니다.'});return;}
    if(room.mode==='knife'&&id!=='knife'){socket.emit('equipResult',{ok:false,message:'나이프 모드에서는 칼만 사용할 수 있습니다.'});return;}
    p.ownedWeapons ||= ['pistol','knife'];
    if(!weapons[id]||!p.ownedWeapons.includes(id)){socket.emit('equipResult',{ok:false,message:'구매한 무기만 장착할 수 있습니다.'});return;}
    p.weapon=id;
    socket.emit('equipResult',{ok:true,weapon:id,ownedWeapons:p.ownedWeapons});
    socket.to(room.code).emit('playerWeapon',{id:socket.id,weapon:id,skinId:p.equippedSkins?.[id]||null});
  });
  socket.on('fire', payload => {
    try {
    const room=rooms.get(socket.data.roomCode);const shooter=playerById(room,socket.id);
    if(!room||!shooter||shooter.connected===false||room.phase!=='live'||shooter.hp<=0)return;
    const id=String(payload?.weaponId||'');const w=weapons[id];if(!w||id!==shooter.weapon||!(shooter.ownedWeapons||['pistol','knife']).includes(id))return;
    const now=Date.now();
    const previousFireAt=Number(shooter.lastFireAt)||0;
    if(id==='burst'){
      const burstId=Number(payload?.burstId),seq=Number(payload?.burstSeq);
      if(!Number.isInteger(burstId)||burstId<1||!Number.isInteger(seq)||seq<0||seq>2)return;
      if(seq===0){if(now-previousFireAt<w.rate*1000*.72)return;shooter.activeBurstId=burstId;shooter.burstNextSeq=1;shooter.burstStartedAt=now;}
      else{if(shooter.activeBurstId!==burstId||seq!==shooter.burstNextSeq||now-shooter.burstStartedAt>360)return;shooter.burstNextSeq++;if(seq===2)shooter.activeBurstId=null;}
    }else{if(now-previousFireAt < w.rate*1000*.72)return;}
    const elapsedSincePrevious = previousFireAt ? now - previousFireAt : Infinity;
    shooter.recoilHeat = elapsedSincePrevious < w.rate*1000*1.55 ? Math.min(4.2,(shooter.recoilHeat||0)+(w.recoil||.01)*19) : Math.max(0,(shooter.recoilHeat||0)*.25);
    shooter.lastFireAt=now;
    const o=payload?.origin,d=payload?.direction;
    if(!o||!d||![o.x,o.y,o.z,d.x,d.y,d.z].every(v=>Number.isFinite(Number(v))))return;
    const dirLen=Math.hypot(Number(d.x),Number(d.y),Number(d.z));if(dirLen<.7||dirLen>1.3)return;
    const origin={x:Number(o.x),y:Number(o.y),z:Number(o.z)};const direction={x:Number(d.x)/dirLen,y:Number(d.y)/dirLen,z:Number(d.z)/dirLen};
    const enemyEntries=[...room.players.entries()].filter(([id2,p])=>id2!==socket.id&&p.hp>0&&(!isTeamsMode(room)||p.team!==shooter.team));
    const inRangeEntries=id==='knife'?enemyEntries.filter(([,target])=>Math.hypot((Number(target.x)||0)-origin.x,(Number(target.y)||0)+1.08-origin.y,(Number(target.z)||0)-origin.z)<=(Number(w.range)||2.65)):enemyEntries;
    let end={x:origin.x+direction.x*MAX_SHOT_DISTANCE,y:origin.y+direction.y*MAX_SHOT_DISTANCE,z:origin.z+direction.z*MAX_SHOT_DISTANCE};
    const hitsByTarget=new Map();let closestHitDistance=Infinity;
    const pelletCount=id==='shotgun'?(w.pellets||10):1;
    const rightLen=Math.hypot(direction.z,direction.x)||1;const right={x:direction.z/rightLen,y:0,z:-direction.x/rightLen};
    const up={x:right.y*direction.z-right.z*direction.y,y:right.z*direction.x-right.x*direction.z,z:right.x*direction.y-right.y*direction.x};
    const upLen=Math.hypot(up.x,up.y,up.z)||1;up.x/=upLen;up.y/=upLen;up.z/=upLen;
    const ellipsoidDistance=(rayDirection,center,radii,maxDistance)=>{
      const ox=(origin.x-center.x)/radii.x, oy=(origin.y-center.y)/radii.y, oz=(origin.z-center.z)/radii.z;
      const dx=rayDirection.x/radii.x, dy=rayDirection.y/radii.y, dz=rayDirection.z/radii.z;
      const a=dx*dx+dy*dy+dz*dz,b=2*(ox*dx+oy*dy+oz*dz),c=ox*ox+oy*oy+oz*oz-1,disc=b*b-4*a*c;
      if(a<1e-9||disc<0)return null;const root=Math.sqrt(disc);let t=(-b-root)/(2*a);if(t<0)t=(-b+root)/(2*a);return t>=0&&t<=maxDistance?t:null;
    };
    const maxBloom=inRangeEntries.reduce((max,[,target])=>{
      const distance=Math.hypot((Number(target.x)||0)-origin.x,(Number(target.y)||0)+1.05-origin.y,(Number(target.z)||0)-origin.z);
      return Math.max(max,id==='knife'?0:Math.max(0,distance-8)*(w.distanceSpread||.0001)+(shooter.recoilHeat||0)*(w.recoil||.01)*.11);
    },0);
    for(let pellet=0;pellet<pelletCount;pellet++){
      let rayDirection=direction;
      if(id!=='knife'&&(id==='shotgun'||maxBloom>0.00001)){
        const baseSpread=id==='shotgun'?(w.spread||.105):0;
        const angle=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*(baseSpread+maxBloom);
        const x=direction.x+right.x*Math.cos(angle)*r+up.x*Math.sin(angle)*r;
        const y=direction.y+right.y*Math.cos(angle)*r+up.y*Math.sin(angle)*r;
        const z=direction.z+right.z*Math.cos(angle)*r+up.z*Math.sin(angle)*r;const len=Math.hypot(x,y,z)||1;rayDirection={x:x/len,y:y/len,z:z/len};
      }
      let nearest=null;
      for(const [targetId,target] of inRangeEntries){
        const baseY=Number(target.y)||0,tx=Number(target.x)||0,tz=Number(target.z)||0;
        const parts=[
          {part:'head',center:{x:tx,y:baseY+1.67,z:tz},radii:{x:.23,y:.25,z:.23},multiplier:getHitMultiplier('head')},
          {part:'torso',center:{x:tx,y:baseY+1.08,z:tz},radii:{x:.40,y:.43,z:.30},multiplier:getHitMultiplier('torso')},
          {part:'legs',center:{x:tx,y:baseY+.39,z:tz},radii:{x:.34,y:.40,z:.31},multiplier:getHitMultiplier('legs')},
        ];
        const maxDistance=id==='knife'?(Number(w.range)||2.65):MAX_SHOT_DISTANCE;
        for(const part of parts){
          const distance=ellipsoidDistance(rayDirection,part.center,part.radii,maxDistance);
          if(distance==null||isShotBlocked(origin,rayDirection,distance,room.map))continue;
          if(!nearest||distance<nearest.distance)nearest={id:targetId,p:target,part:part.part,multiplier:part.multiplier,distance,rayDirection};
        }
      }
      if(nearest){
        const pelletDamage=id==='knife'?40:w.damage*(nearest.multiplier||1);
        const previous=hitsByTarget.get(nearest.id)||{id:nearest.id,p:nearest.p,damage:0,part:nearest.part};
        previous.damage+=pelletDamage;previous.part=nearest.part;hitsByTarget.set(nearest.id,previous);
        if(nearest.distance<closestHitDistance){closestHitDistance=nearest.distance;end={x:origin.x+nearest.rayDirection.x*nearest.distance,y:origin.y+nearest.rayDirection.y*nearest.distance,z:origin.z+nearest.rayDirection.z*nearest.distance};}
      }
    }
    // One tracer per trigger; distance affects spread, not maximum firearm range.
    io.to(room.code).emit('shotFx',{id:socket.id,weaponId:id,origin,end,skinId:shooter.equippedSkins?.[id]||null});
    if(!hitsByTarget.size)return;
    let finalKillInfo=null;
    for(const hit of hitsByTarget.values()){
      if(room.phase!=='live')break;
      const t=hit.p;const damage=hit.damage;let left=damage;
      if(t.armor>0){const absorbRatio=t.armorTier==='heavy'?.60:.35;const absorbed=Math.min(t.armor,damage*absorbRatio);t.armor-=absorbed;left-=absorbed;if(t.armor<=0){t.armor=0;t.armorTier='none';}}
      t.hp=Math.max(0,t.hp-left);
      const killed=t.hp<=0;
      if(killed){t.dead=true;shooter.money+=KILL_REWARD+Math.max(0,room.round-1)*KILL_REWARD_STEP;}
      io.to(room.code).emit('damage',{attackerId:socket.id,targetId:hit.id,hp:t.hp,armor:t.armor,armorTier:t.armorTier,killed,damage,hitPart:hit.part||'torso',pelletsHit:id==='shotgun'?Math.max(1,Math.round(damage/Math.max(1,w.damage))):1});
      io.to(hit.id).emit('selfState',selfPayload(t));
      if(killed){
        const skinId=shooter.equippedSkins?.[shooter.weapon]||null;
        emitKillPresentation(room,socket.id,hit.id,skinId);
        if (id === 'pistol' && shooter.accountId) {
          void incrementRepeatQuest(shooter.accountId, 'pistolKills', 1).then(progress => {
            if (!progress?.ok || !progress.account) return;
            socket.emit('accountUpdated', { account: progress.account });
            if (progress.completions > 0) socket.emit('questReward', { questId: 'pistolKills', reward: progress.reward, completions: progress.completions, account: progress.account });
          }).catch(error => console.warn('[quests] pistol kill progress failed:', error?.message || error));
        }
        finalKillInfo={victimId:hit.id,skinId};
        if(!isTeamsMode(room)||![...room.players.values()].some(player=>player.team===t.team&&player.hp>0)){
          endRound(room,socket.id,`${shooter.name} 처치 성공`,finalKillInfo);
          break;
        }
      }
    }
    socket.emit('selfState',selfPayload(shooter));
    } catch (error) {
      console.error('[NEON STRIKE] fire handler error:', error?.stack || error);
      socket.emit('roomMessage',{message:'사격 처리 중 오류가 발생했습니다. 연결은 유지됩니다.'});
    }
  });
  socket.on('nextRound',()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||!roomIsReady(room)||room.phase!=='ended')return;
    if([...room.players.values()].some(p=>p.score>=WINS_TO_MATCH))return;
    if(room.timer)clearTimeout(room.timer);
    room.timer=null;
    beginRound(room);
  });
  socket.on('leaveRoom',()=>leaveRoom(socket,true));
  socket.on('disconnect',reason=>{
    // A recoverable network drop keeps the room slot briefly so two players do not lose the match.
    if(socket.data.intentionalLeave){leaveRoom(socket,true);return;}
    if(socket.recovered) { const room=rooms.get(socket.data.roomCode); const p=room?.players.get(socket.id); if(p?.reconnectTimer)clearTimeout(p.reconnectTimer); }
    suspendDisconnectedSocket(socket);
  });
  if(socket.recovered&&socket.data.roomCode){
    const room=rooms.get(socket.data.roomCode);const p=room?.players.get(socket.id);
    if(p){p.connected=true;if(p.reconnectTimer)clearTimeout(p.reconnectTimer);p.reconnectTimer=null;socket.join(room.code);if(room.phase!=='waiting'&&room.players.size===roomRequiredPlayers(room)&&[...room.players.values()].every(candidate=>candidate.connected!==false))restoreRoomPhaseAfterDisconnect(room);if(room.phase==='waiting')emitRoomLobby(room);socket.emit('roomResumed',{code:room.code,map:room.map,rule:room.rule,mode:room.mode,teamMode:room.teamMode,phase:room.phase,round:room.round});if(room.phase!=='waiting'&&room.players.size===roomRequiredPlayers(room)&&[...room.players.values()].every(candidate=>candidate.connected!==false)){if(room.phase==='waiting')emitRoomLobby(room);else if(room.phase==='ended'||room.phase==='matchover'){for(const [pid,player] of room.players)io.to(pid).emit('roundResult',{winnerId:room.lastWinnerId??null,reason:room.lastReason||'라운드 종료',scores:roomScoreSnapshot(room),teamScores:room.teamScores||null,winnerTeam:room.lastWinnerTeam||null,selfMoney:player.money,reward:0,matchOver:room.phase==='matchover',round:room.round,nextRoundInMs:0});}else emitState(room);}}
  }
});

await initializeAccountStorage().catch(error => console.error('[accounts] initialization failed:', error?.message || error));

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`NEON STRIKE listening on http://localhost:${PORT}`);
  console.log(`Mode: ${isProduction?'production':'development'} | Socket.IO ready`);
});

process.on('SIGINT',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);authPool?.end().catch(()=>{});httpServer.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);authPool?.end().catch(()=>{});httpServer.close(()=>process.exit(0));});
