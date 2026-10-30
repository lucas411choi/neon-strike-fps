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
function normalizeAccountPublic(row) {
  if (!row) return null;
  const level = Math.max(1, Number(row.level) || 1);
  return {
    id: Number(row.id), username: String(row.username), level, xp: Number(row.xp || 0), nextLevelXp: level * 150,
    neonPoints: Math.max(0, Number(row.neon_points ?? row.neonPoints) || 0),
    ownedSkins: parseJsonValue(row.owned_skins ?? row.ownedSkins, []),
    equippedSkins: parseJsonValue(row.equipped_skins ?? row.equippedSkins, {}),
    trainingQuestProgress: Math.max(0, Number(row.training_quest_progress ?? row.trainingQuestProgress) || 0),
  };
}
function accountStoreModel(row) {
  return {
    level: Math.max(1, Number(row.level) || 1), xp: Math.max(0, Number(row.xp) || 0),
    neonPoints: Math.max(0, Number(row.neon_points ?? row.neonPoints) || 0),
    ownedSkins: parseJsonValue(row.owned_skins ?? row.ownedSkins, []),
    equippedSkins: parseJsonValue(row.equipped_skins ?? row.equippedSkins, {}),
    trainingQuestProgress: Math.max(0, Number(row.training_quest_progress ?? row.trainingQuestProgress) || 0),
    redeemedCodes: parseJsonValue(row.redeemed_codes ?? row.redeemedCodes, []),
    dailyShopIds: parseJsonValue(row.daily_shop_ids ?? row.dailyShopIds, []),
    dailyShopExpiresAt: row.daily_shop_expires_at ?? row.dailyShopExpiresAt ?? null,
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
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS redeemed_codes JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS daily_shop_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ns_accounts ADD COLUMN IF NOT EXISTS daily_shop_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
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
        account.redeemed_codes = parseJsonValue(account.redeemed_codes ?? account.redeemedCodes, []);
        account.daily_shop_ids = parseJsonValue(account.daily_shop_ids ?? account.dailyShopIds, []);
        account.daily_shop_expires_at = account.daily_shop_expires_at ?? account.dailyShopExpiresAt ?? null;
      }
      localAuth.nextId = Number(parsed.nextId) || (Math.max(0, ...localAuth.accounts.map(a=>Number(a.id)||0)) + 1);
    }
  } catch (error) { if (error?.code !== 'ENOENT') console.warn('[accounts] local data could not be loaded:', error?.message || error); }
  authStorageReady = true;
  console.log('[accounts] local development file store ready');
}
async function findAccountByUsername(username) {
  if (authPool) {
    const result = await authPool.query('SELECT id, username, password_salt, password_hash, level, xp, neon_points, owned_skins, equipped_skins, training_quest_progress, redeemed_codes FROM ns_accounts WHERE username=$1 LIMIT 1', [username]);
    return result.rows[0] || null;
  }
  return localAuth.accounts.find(row => row.username === username) || null;
}
async function insertAccount(username, passwordSalt, passwordHash) {
  if (authPool) {
    const result = await authPool.query(
      `INSERT INTO ns_accounts (username,password_salt,password_hash,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,redeemed_codes) VALUES ($1,$2,$3,1,0,0,'[]'::jsonb,'{}'::jsonb,0,'[]'::jsonb) RETURNING id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress`,
      [username,passwordSalt,passwordHash]
    );
    return result.rows[0];
  }
  if (localAuth.accounts.some(row => row.username === username)) {
    const error = new Error('duplicate username'); error.code = '23505'; throw error;
  }
  const account = { id: localAuth.nextId++, username, password_salt: passwordSalt, password_hash: passwordHash, level: 1, xp: 0, neon_points: 0, owned_skins: [], equipped_skins: {}, training_quest_progress: 0, redeemed_codes: [], daily_shop_ids: [], daily_shop_expires_at: null, created_at: new Date().toISOString() };
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
      `SELECT a.id,a.username,a.level,a.xp,a.neon_points,a.owned_skins,a.equipped_skins,a.training_quest_progress,a.daily_shop_ids,a.daily_shop_expires_at FROM ns_sessions s JOIN ns_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,
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
      const result = await client.query('SELECT id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress FROM ns_accounts WHERE id=$1 FOR UPDATE', [accountId]);
      if (!result.rows.length) { await client.query('ROLLBACK'); return null; }
      const progression = applyExperienceProgress(result.rows[0].level, result.rows[0].xp, award);
      const updated = await client.query('UPDATE ns_accounts SET level=$2,xp=$3,updated_at=NOW() WHERE id=$1 RETURNING id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress', [accountId,progression.level,progression.xp]);
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
        'SELECT id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress,redeemed_codes,daily_shop_ids,daily_shop_expires_at FROM ns_accounts WHERE id=$1 FOR UPDATE',
        [accountId]
      );
      if (!result.rows.length) { await client.query('ROLLBACK'); return { ok:false, status:404, error:'계정을 찾을 수 없습니다.' }; }
      const model = accountStoreModel(result.rows[0]);
      const outcome = mutator(model) || { ok:true };
      if (!outcome.ok) { await client.query('ROLLBACK'); return outcome; }
      const updated = await client.query(
        `UPDATE ns_accounts SET level=$2,xp=$3,neon_points=$4,owned_skins=$5::jsonb,equipped_skins=$6::jsonb,training_quest_progress=$7,redeemed_codes=$8::jsonb,daily_shop_ids=$9::jsonb,daily_shop_expires_at=$10,updated_at=NOW()
         WHERE id=$1 RETURNING id,username,level,xp,neon_points,owned_skins,equipped_skins,training_quest_progress`,
        [accountId,model.level,model.xp,model.neonPoints,JSON.stringify(model.ownedSkins),JSON.stringify(model.equippedSkins),model.trainingQuestProgress,JSON.stringify(model.redeemedCodes),JSON.stringify(model.dailyShopIds||[]),model.dailyShopExpiresAt||new Date(0).toISOString()]
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
    training_quest_progress:model.trainingQuestProgress, redeemed_codes:model.redeemedCodes,
    daily_shop_ids:model.dailyShopIds||[], daily_shop_expires_at:model.dailyShopExpiresAt||null,
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
    let cost = 0, skinIds = [], productName = '';
    if (productType === 'bundle') {
      const bundle = getStoreBundle(productId);
      if (!bundle) return res.status(400).json({ error:'존재하지 않는 번들입니다.' });
      cost = bundle.price; skinIds = bundle.skinIds; productName = bundle.displayName;
    } else if (productType === 'daily') {
      const skin = getStoreSkin(productId);
      if (!skin) return res.status(400).json({ error:'존재하지 않는 스킨입니다.' });
      cost = skin.price; skinIds = [skin.id]; productName = skin.displayName;
    } else return res.status(400).json({ error:'구매 유형이 올바르지 않습니다.' });
    const result = await mutateAccountState(account.id, model => {
      const owned = new Set(model.ownedSkins);
      if (productType === 'daily' && (!(model.dailyShopIds||[]).includes(productId) || !Number.isFinite(Date.parse(model.dailyShopExpiresAt||'')) || Date.parse(model.dailyShopExpiresAt)<=Date.now())) return { ok:false, status:409, error:'오늘의 스킨 목록이 만료됐습니다. 상점을 새로고침하세요.' };
      const missing = skinIds.filter(id => !owned.has(id));
      if (!missing.length) return { ok:false, status:409, error:'이미 보유한 상품입니다.' };
      let actualCost = cost;
      if (productType === 'bundle') {
        const bundle = getStoreBundle(productId);
        const alreadyOwnedCount = bundle.skinIds.filter(id => owned.has(id)).length;
        actualCost = Math.max(0, bundle.price - alreadyOwnedCount * 60);
      }
      if (model.neonPoints < actualCost) return { ok:false, status:400, error:`네온 포인트가 부족합니다. ${actualCost} NP가 필요합니다.` };
      model.neonPoints -= actualCost;
      model.ownedSkins = [...owned, ...missing];
      return { ok:true, productName, purchasedSkinIds:missing, cost:actualCost };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '구매에 실패했습니다.' });
    res.json({ account:result.account, productName:result.productName, purchasedSkinIds:result.purchasedSkinIds, cost:result.cost });
  } catch (error) { console.error('[store] purchase failed:', error?.message || error); res.status(500).json({ error:'구매 처리 중 오류가 발생했습니다.' }); }
});

app.post('/api/store/roll', async (req, res) => {
  if (apiStorageUnavailable(res)) return;
  if (!accountRateAllowed(req,'store-roll',10,60_000)) return res.status(429).json({ error:'뽑기 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  try {
    const token = getRequestToken(req);
    const account = await accountForToken(token);
    if (!account) return accountRequiredMessage(res);
    const result = await mutateAccountState(account.id, model => {
      if (model.neonPoints < STORE_ROLL_COST) return { ok:false, status:400, error:`네온 포인트가 부족합니다. ${STORE_ROLL_COST} NP가 필요합니다.` };
      const unowned = STORE_SKINS.filter(skin => !model.ownedSkins.includes(skin.id));
      if (!unowned.length) return { ok:false, status:409, error:'현재 스킨을 모두 보유하고 있습니다.' };
      // Every individual unowned skin has the same probability, regardless of rarity.
      const skin = unowned[Math.floor(Math.random() * unowned.length)];
      model.neonPoints -= STORE_ROLL_COST;
      model.ownedSkins = [...model.ownedSkins, skin.id];
      return { ok:true, skin, cost:STORE_ROLL_COST };
    });
    if (!result.ok) return res.status(result.status || 500).json({ error:result.error || '뽑기에 실패했습니다.' });
    res.json({ account:result.account, skin:result.skin, cost:result.cost });
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
function publicPlayer(p) { return { x:p.x, y:p.y||0, z:p.z, yaw:p.yaw, pitch:p.pitch, name:p.name, hp:p.hp, armor:p.armor, weapon:p.weapon, skinId:p.equippedSkins?.[p.weapon]||null, equippedSkins:p.equippedSkins||{}, device:p.device, score:p.score }; }
function playerById(room, id) { return room?.players.get(id); }
function selfPayload(p) { return { money:p.money, hp:p.hp, armor:p.armor, armorTier:p.armorTier, weapon:p.weapon, skinId:p.equippedSkins?.[p.weapon]||null, ownedWeapons:[...(p.ownedWeapons||['pistol','knife'])], boughtPrimary:p.boughtPrimary, armorPurchased:p.armorPurchased, x:p.x, y:p.y||0, z:p.z, yaw:p.yaw, pitch:p.pitch }; }
function playersSnapshot(room) { return Object.fromEntries([...room.players.entries()].map(([id,p])=>[id,publicPlayer(p)])); }
function emitState(room) {
  const players = playersSnapshot(room);
  for (const [id,p] of room.players) {
    io.to(id).emit('roundState', {
      code: room.code, map: room.map || 'arena', phase: room.phase, round: room.round, endsAt: room.phaseEndsAt,
      roundEndsAt: room.liveEndsAt, scores: Object.fromEntries([...room.players.entries()].map(([pid,pl])=>[pid,pl.score])),
      self: selfPayload(p), players,
    });
  }
}
function resetPlayerForRound(room, p, index) {
  p.hp = 100;
  p.armor = Math.max(0, p.armor); // Retain surviving shield points between rounds.
  if (p.armor <= 0) p.armorTier = 'none';
  // Bought guns last for this round only. Credits remain cumulative, but each round begins with pistol + knife.
  p.ownedWeapons = ['pistol','knife'];
  p.weapon = 'pistol';
  p.boughtPrimary = false;
  p.armorPurchased = p.armorTier === 'heavy';
  p.lastFireAt = 0;
  // Spawn both players at opposite ends of the arena, out of immediate contact.
  p.x = index === 0 ? -3 : 3;
  p.y = 0;
  const spawn=mapSpawn(room.map);p.z = index === 0 ? spawn : -spawn;
  p.yaw = index === 0 ? 0 : Math.PI;
  p.pitch = 0;
}
function beginRound(room) {
  if (!rooms.has(room.code) || room.players.size !== 2 || [...room.players.values()].some(p=>p.connected===false)) return;
  room.phaseBeforeDisconnect=null;room.remainingPhaseMs=0;
  if (room.timer) clearTimeout(room.timer);
  room.round += 1;
  room.phase = 'buy';
  room.phaseEndsAt = Date.now() + BUY_MS;
  room.liveEndsAt = room.phaseEndsAt + ROUND_MS;
  [...room.players.values()].forEach((p,i)=>resetPlayerForRound(room,p,i));
  emitState(room);
  room.timer = setTimeout(() => startLive(room), BUY_MS);
}
function startLive(room) {
  if (!rooms.has(room.code) || room.players.size !== 2 || [...room.players.values()].some(p=>p.connected===false) || room.phase !== 'buy') return;
  room.phase = 'live';
  room.phaseEndsAt = Date.now() + ROUND_MS;
  room.liveEndsAt = room.phaseEndsAt;
  io.to(room.code).emit('roundPhase', { phase:'live', round:room.round, endsAt:room.phaseEndsAt });
  room.timer = setTimeout(() => resolveTimedRound(room), ROUND_MS);
}
function resolveTimedRound(room) {
  if (!room || room.phase !== 'live' || room.players.size !== 2) return;
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
function endRound(room, winnerId, reason='적 처치', killInfo=null) {
  if (!room || room.phase !== 'live') return;
  if (room.timer) clearTimeout(room.timer);
  room.phase='ended';room.lastWinnerId=winnerId;room.lastReason=reason;
  let matchOver=false;
  if (winnerId && room.players.has(winnerId)) room.players.get(winnerId).score += 1;
  if ([...room.players.values()].some(p=>p.score>=WINS_TO_MATCH)) matchOver=true;
  const winner = winnerId ? room.players.get(winnerId) : null;
  if (killInfo && winner && killInfo.victimId && room.players.has(killInfo.victimId)) {
    const victim=room.players.get(killInfo.victimId);
    const killPayload={killerId:winnerId,victimId:killInfo.victimId,durationMs:5000,skinId:killInfo.skinId||winner.equippedSkins?.[winner.weapon]||null,killer:{x:winner.x,y:winner.y||0,z:winner.z,yaw:winner.yaw,pitch:winner.pitch,weapon:winner.weapon,name:winner.name},victim:{x:victim.x,y:victim.y||0,z:victim.z,yaw:victim.yaw,pitch:victim.pitch,name:victim.name}};
    // Only the eliminated player receives the killcam overlay and first-person replay.
    io.to(killInfo.victimId).emit('killCamStart',killPayload);
    // The killer sees the victim's skin effect but remains free to reposition during the replay window.
    io.to(winnerId).emit('killerKillEffect',killPayload);
    io.to(winnerId).emit('killerFreedom',{durationMs:5000,killerId:winnerId});
  }
  if (winner?.accountId) {
    void (async () => {
      let profile = await awardAccountXP(winner.accountId, 50); // 50 XP for each round won.
      if (matchOver) profile = await awardAccountXP(winner.accountId, 200); // Additional match-win XP.
      if (profile) io.to(winner.id).emit('accountUpdated', { account: profile });
    })().catch(error => console.error('[accounts] online XP award failed:', error?.message || error));
  }
  for (const [id,p] of room.players) {
    const won = winnerId===id;
    const roundBonus=Math.max(0,room.round-1);
    const reward = won?(ROUND_WIN_REWARD+roundBonus*ROUND_WIN_STEP):(ROUND_LOSS_REWARD+roundBonus*ROUND_LOSS_STEP);
    p.money += reward;
    io.to(id).emit('roundResult', {
      winnerId, reason, scores:Object.fromEntries([...room.players.entries()].map(([pid,pl])=>[pid,pl.score])),
      selfMoney:p.money, reward, matchOver, round:room.round, nextRoundInMs:0, killCamMs:killInfo?5000:0,
    });
  }
  if (matchOver) {
    room.phase='matchover';room.lastMatchOver=true;
    return;
  }
  // The next round begins only when a player presses the explicit next-round button.
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
    io.to(code).emit('roomMessage',{message:'상대가 나갔습니다. 새 플레이어가 참가하거나 다시 연결할 때까지 대기합니다.'});
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
    else io.to(code).emit('roomMessage',{message:'상대의 재연결 시간이 만료되었습니다. 새 플레이어가 참가할 수 있습니다.'});
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
  if(oldId!==socket.id)room.players.delete(oldId);
  room.players.set(socket.id,p);socket.data.roomCode=code;socket.data.sessionId=sessionId;socket.join(code);
  if(oldId!==socket.id)io.to(code).emit('playerLeft',{id:oldId});
  socket.emit('roomResumed',{code,map:room.map,rule:room.rule,phase:room.phase,round:room.round});
  socket.emit('playersSnapshot',playersSnapshot(room));
  if(room.players.size===2&&[...room.players.values()].every(candidate=>candidate.connected!==false)){
    restoreRoomPhaseAfterDisconnect(room);
    io.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    if(room.phase==='waiting')beginRound(room);
    else if(room.phase==='ended'||room.phase==='matchover'){
      for(const [pid,player] of room.players){io.to(pid).emit('roundResult',{winnerId:room.lastWinnerId??null,reason:room.lastReason||'라운드 종료',scores:Object.fromEntries([...room.players.entries()].map(([key,value])=>[key,value.score])),selfMoney:player.money,reward:0,matchOver:room.phase==='matchover',round:room.round,nextRoundInMs:0});}
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
    const p={id:socket.id,sessionId,name,device,accountId:authenticatedAccount?.id??null,equippedSkins:parseJsonValue(authenticatedAccount?.equipped_skins??authenticatedAccount?.equippedSkins,{}),connected:true,x:0,y:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol','knife'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0,activeBurstId:null,burstNextSeq:1,burstStartedAt:0,reconnectTimer:null};
    const room={code,rule:requestedRule,map:requestedMap,players:new Map([[socket.id,p]]),phase:'waiting',round:0,phaseEndsAt:0,liveEndsAt:0,timer:null};
    rooms.set(code,room);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomCreated',{code,rule:requestedRule,device,map:room.map});
  });
  socket.on('joinRoom', async payload => {
    const authenticatedAccount = await accountFromToken(payload?.authToken);
    const code=String(payload?.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    const room=rooms.get(code);
    if (!room) {socket.emit('roomError',{message:'방을 찾을 수 없습니다. 코드가 정확한지 확인하세요.'});return;}
    if (room.players.size>=2) {socket.emit('roomError',{message:'이미 두 명이 참가한 방입니다.'});return;}
    const device=payload?.device==='mobile'?'mobile':'pc';
    const sessionId=safeSessionId(payload?.sessionId);
    if (!compatible(room.rule,device)) {
      const message=room.rule==='pc'?'이 방은 PC끼리 대전하는 방입니다. PC 기기 선택 후 참가하세요.':room.rule==='mobile'?'이 방은 모바일끼리 대전하는 방입니다. 모바일 기기 선택 후 참가하세요.':'기기 설정을 확인하세요.';
      socket.emit('roomError',{message});return;
    }
    leaveRoom(socket,false);
    const name=safeName(payload?.name);
    const p={id:socket.id,sessionId,name,device,accountId:authenticatedAccount?.id??null,equippedSkins:parseJsonValue(authenticatedAccount?.equipped_skins??authenticatedAccount?.equippedSkins,{}),connected:true,x:0,y:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol','knife'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0,activeBurstId:null,burstNextSeq:1,burstStartedAt:0,reconnectTimer:null};
    room.players.set(socket.id,p);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomJoined',{code,rule:room.rule,device,map:room.map});
    socket.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    socket.emit('playersSnapshot',playersSnapshot(room));
    beginRound(room);
  });
  socket.on('resumeRoom', payload => resumePlayer(socket,payload));
  socket.on('move', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);if(!p||p.connected===false||!payload)return;
    const x=Number(payload.x),y=Number(payload.y??0),z=Number(payload.z),yaw=Number(payload.yaw),pitch=Number(payload.pitch);
    if (![x,y,z,yaw,pitch].every(Number.isFinite))return;
    const bound=mapBounds(room.map);p.x=Math.max(-bound,Math.min(bound,x));p.y=Math.max(0,Math.min(8,y));p.z=Math.max(-bound,Math.min(bound,z));p.yaw=Math.max(-Math.PI*2,Math.min(Math.PI*2,yaw));p.pitch=Math.max(-1.35,Math.min(1.35,pitch));
    socket.to(room.code).emit('playerMoved',{id:socket.id,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:p.pitch,name:p.name,hp:p.hp,weapon:p.weapon,skinId:p.equippedSkins?.[p.weapon]||null,equippedSkins:p.equippedSkins||{},device:p.device});
  });
  socket.on('footstep', () => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);if(!room||!p||p.connected===false||room.phase!=='live')return;
    const now=Date.now();if(now-(p.lastFootstepAt||0)<330)return;p.lastFootstepAt=now;
    socket.to(room.code).emit('footstep',{id:socket.id,x:p.x,z:p.z});
  });
  socket.on('buy', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);
    if(!room||!p||room.phase!=='buy'){socket.emit('buyResult',{ok:false,message:'구매 단계에서만 살 수 있습니다.'});return;}
    if(payload?.kind==='armor'){
      const tier=payload?.tier==='heavy'?'heavy':'light';
      const gear=tier==='heavy'?{cost:1000,value:110,name:'중량 보호막'}:{cost:400,value:60,name:'경량 보호막'};
      if(tier==='light'&&p.armorTier!=='none'){socket.emit('buyResult',{ok:false,message:'이미 보호막을 보유 중입니다. 중량 보호막으로 강화할 수 있습니다.'});return;}
      if(tier==='heavy'&&p.armorTier==='heavy'){socket.emit('buyResult',{ok:false,message:'이미 중량 보호막을 보유하고 있습니다.'});return;}
      if(p.money<gear.cost){socket.emit('buyResult',{ok:false,message:'크레딧이 부족합니다.'});return;}
      p.money-=gear.cost;p.armor=gear.value;p.armorTier=tier;p.armorPurchased=tier==='heavy';
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
      p.money-=w.price;p.boughtPrimary=true;
      p.ownedWeapons=p.ownedWeapons.filter(ownedId=>weapons[ownedId]?.slot!=='primary');
      p.ownedWeapons.push(id);
    } else {
      if(id!=='pistol')p.money-=w.price;
      p.ownedWeapons.push(id);
    }
    p.weapon=id;
    socket.emit('buyResult',{ok:true,message:`${id.toUpperCase()} 구매/장착 완료`,money:p.money,armor:p.armor,armorTier:p.armorTier,weapon:p.weapon,ownedWeapons:p.ownedWeapons,boughtPrimary:p.boughtPrimary,armorPurchased:p.armorPurchased});
  });
  socket.on('equipWeapon', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);const id=String(payload?.weaponId||'');
    if(!room||!p||!['buy','live'].includes(room.phase)){socket.emit('equipResult',{ok:false,message:'현재는 무기를 교체할 수 없습니다.'});return;}
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
    let targetEntry=[...room.players.entries()].find(([id2,p])=>id2!==socket.id&&p.hp>0);
    if(id==='knife'&&targetEntry){const [,target]=targetEntry;const targetDistance=Math.hypot((Number(target.x)||0)-origin.x,(Number(target.y)||0)+1.08-origin.y,(Number(target.z)||0)-origin.z);if(targetDistance>(Number(w.range)||2.65))targetEntry=null;}
    // Firearms have no hard gameplay range cutoff. Accuracy becomes less reliable with distance.
    let end={x:origin.x+direction.x*MAX_SHOT_DISTANCE,y:origin.y+direction.y*MAX_SHOT_DISTANCE,z:origin.z+direction.z*MAX_SHOT_DISTANCE};
    let hit=null,totalDamage=0,closestHitDistance=Infinity;
    if(targetEntry){
      const [targetId,target]=targetEntry;
      const baseY=Number(target.y)||0, tx=Number(target.x)||0, tz=Number(target.z)||0;
      const parts=[
        {part:'head',center:{x:tx,y:baseY+1.67,z:tz},radii:{x:.23,y:.25,z:.23},multiplier:getHitMultiplier('head')},
        {part:'torso',center:{x:tx,y:baseY+1.08,z:tz},radii:{x:.40,y:.43,z:.30},multiplier:getHitMultiplier('torso')},
        {part:'legs',center:{x:tx,y:baseY+.39,z:tz},radii:{x:.34,y:.40,z:.31},multiplier:getHitMultiplier('legs')},
      ];
      const ellipsoidDistance=(rayDirection,center,radii)=>{
        const ox=(origin.x-center.x)/radii.x, oy=(origin.y-center.y)/radii.y, oz=(origin.z-center.z)/radii.z;
        const dx=rayDirection.x/radii.x, dy=rayDirection.y/radii.y, dz=rayDirection.z/radii.z;
        const a=dx*dx+dy*dy+dz*dz,b=2*(ox*dx+oy*dy+oz*dz),c=ox*ox+oy*oy+oz*oz-1,disc=b*b-4*a*c;
        if(a<1e-9||disc<0)return null;const root=Math.sqrt(disc);let t=(-b-root)/(2*a);if(t<0)t=(-b+root)/(2*a);const maxDistance=id==='knife'?(Number(w.range)||2.65):MAX_SHOT_DISTANCE;return t>=0&&t<=maxDistance?t:null;
      };
      const pelletCount=id==='shotgun'?(w.pellets||10):1;
      const rightLen=Math.hypot(direction.z,direction.x)||1;const right={x:direction.z/rightLen,y:0,z:-direction.x/rightLen};
      const up={x:right.y*direction.z-right.z*direction.y,y:right.z*direction.x-right.x*direction.z,z:right.x*direction.y-right.y*direction.x};
      const upLen=Math.hypot(up.x,up.y,up.z)||1;up.x/=upLen;up.y/=upLen;up.z/=upLen;
      const targetDistance = Math.hypot(tx-origin.x, baseY+1.05-origin.y, tz-origin.z);
      const distanceBloom = id==='knife' ? 0 : Math.max(0,targetDistance-8)*(w.distanceSpread||.0001) + (shooter.recoilHeat||0)*(w.recoil||.01)*.11;
      for(let pellet=0;pellet<pelletCount;pellet++){
        let rayDirection=direction;
        if(id!=='knife' && (id==='shotgun' || distanceBloom>0.00001)) {
          const baseSpread = id==='shotgun' ? (w.spread||.105) : 0;
          const angle=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*(baseSpread+distanceBloom);
          const x=direction.x+right.x*Math.cos(angle)*r+up.x*Math.sin(angle)*r;
          const y=direction.y+right.y*Math.cos(angle)*r+up.y*Math.sin(angle)*r;
          const z=direction.z+right.z*Math.cos(angle)*r+up.z*Math.sin(angle)*r;const len=Math.hypot(x,y,z)||1;rayDirection={x:x/len,y:y/len,z:z/len};
        }
        let nearestPart=null;
        for(const part of parts){const distance=ellipsoidDistance(rayDirection,part.center,part.radii);if(distance==null||isShotBlocked(origin,rayDirection,distance,room.map))continue;if(!nearestPart||distance<nearestPart.distance)nearestPart={...part,distance};}
        if(nearestPart){
          const pelletDamage=id==='knife'?40:w.damage*(nearestPart.multiplier||1);
          totalDamage+=pelletDamage;
          if(nearestPart.distance<closestHitDistance){closestHitDistance=nearestPart.distance;hit={id:targetId,p:target,part:nearestPart.part,multiplier:nearestPart.multiplier};end={x:origin.x+rayDirection.x*nearestPart.distance,y:origin.y+rayDirection.y*nearestPart.distance,z:origin.z+rayDirection.z*nearestPart.distance};}
        }
      }
    }
    // One tracer per trigger; distance affects spread, not maximum firearm range.
    io.to(room.code).emit('shotFx',{id:socket.id,weaponId:id,origin,end,skinId:shooter.equippedSkins?.[id]||null});
    if(!hit||totalDamage<=0)return;
    const damage=totalDamage;
    const t=hit.p;let left=damage;if(t.armor>0){const absorbRatio=t.armorTier==='heavy'?.60:.35;const absorbed=Math.min(t.armor,damage*absorbRatio);t.armor-=absorbed;left-=absorbed;if(t.armor<=0){t.armor=0;t.armorTier='none';}}t.hp=Math.max(0,t.hp-left);
    const killed=t.hp<=0;
    if(killed)shooter.money+=KILL_REWARD+Math.max(0,room.round-1)*KILL_REWARD_STEP;
    io.to(room.code).emit('damage',{attackerId:socket.id,targetId:hit.id,hp:t.hp,armor:t.armor,armorTier:t.armorTier,killed,damage,hitPart:hit.part||'torso',pelletsHit:id==='shotgun'?Math.max(1,Math.round(damage/Math.max(1,w.damage))):1});
    for(const [pid,p] of room.players)if(pid===hit.id)io.to(pid).emit('selfState',selfPayload(p));
    socket.emit('selfState',selfPayload(shooter));
    if(killed)endRound(room,socket.id,`${shooter.name} 처치 성공`,{victimId:hit.id,skinId:shooter.equippedSkins?.[shooter.weapon]||null});
    } catch (error) {
      console.error('[NEON STRIKE] fire handler error:', error?.stack || error);
      socket.emit('roomMessage',{message:'사격 처리 중 오류가 발생했습니다. 연결은 유지됩니다.'});
    }
  });
  socket.on('nextRound',()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||room.players.size!==2||[...room.players.values()].some(p=>p.connected===false)||room.phase!=='ended')return;
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
    if(p){p.connected=true;if(p.reconnectTimer)clearTimeout(p.reconnectTimer);p.reconnectTimer=null;socket.join(room.code);if(room.players.size===2&&[...room.players.values()].every(candidate=>candidate.connected!==false))restoreRoomPhaseAfterDisconnect(room);socket.emit('roomResumed',{code:room.code,map:room.map,rule:room.rule,phase:room.phase,round:room.round});if(room.players.size===2&&[...room.players.values()].every(candidate=>candidate.connected!==false)){if(room.phase==='waiting')beginRound(room);else if(room.phase==='ended'||room.phase==='matchover'){for(const [pid,player] of room.players)io.to(pid).emit('roundResult',{winnerId:room.lastWinnerId??null,reason:room.lastReason||'라운드 종료',scores:Object.fromEntries([...room.players.entries()].map(([key,value])=>[key,value.score])),selfMoney:player.money,reward:0,matchOver:room.phase==='matchover',round:room.round,nextRoundInMs:0});}else emitState(room);}}
  }
});

await initializeAccountStorage().catch(error => console.error('[accounts] initialization failed:', error?.message || error));

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`NEON STRIKE listening on http://localhost:${PORT}`);
  console.log(`Mode: ${isProduction?'production':'development'} | Socket.IO ready`);
});

process.on('SIGINT',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);authPool?.end().catch(()=>{});httpServer.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);authPool?.end().catch(()=>{});httpServer.close(()=>process.exit(0));});
