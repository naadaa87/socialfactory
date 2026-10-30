import { randomToken, readCookie, sha256Hex } from './auth.js';

export const BOARD_COOKIE = 'sf_board';
export const BOARD_DAYS = 180;
export const BOARD_TABLE = `CREATE TABLE IF NOT EXISTS board_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pairing',
  pair_hash TEXT UNIQUE, pair_until INTEGER, token_hash TEXT UNIQUE, token_until INTEGER,
  created_at INTEGER NOT NULL, paired_at INTEGER, last_seen_at INTEGER)`;
export const ensureBoardDevices = env => env.DB.prepare(BOARD_TABLE).run();
const hash = (env, value) => sha256Hex('sf-board-only|' + value + '|' + env.ADMIN_KEY);
const tokenFormat = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const boardOrigin = request => request.headers.get('origin') === new URL(request.url).origin;

export async function createBoardDevice(env, name, now = Date.now()) {
  await ensureBoardDevices(env);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM board_devices
    WHERE (status='active' AND token_until>?1) OR (status='pairing' AND pair_until>?1)`).bind(now).first();
  if (count.n >= 20) return null;
  const id=randomToken(12), code=randomToken(32), until=now+600000;
  await env.DB.prepare('INSERT INTO board_devices(id,name,pair_hash,pair_until,created_at) VALUES(?1,?2,?3,?4,?5)')
    .bind(id,name,await hash(env,code),until,now).run();
  return {id,code,expires_at:until};
}

export async function pairBoardDevice(env, code, now = Date.now()) {
  if (!tokenFormat(code) || !env.ADMIN_KEY || !env.DB) return null;
  await ensureBoardDevices(env);
  const token=randomToken(32), until=now+BOARD_DAYS*86400000;
  // Atomic consumption: two simultaneous requests cannot issue two active keys.
  const row = await env.DB.prepare(`UPDATE board_devices SET status='active', pair_hash=NULL, pair_until=NULL,
    token_hash=?1,token_until=?2,paired_at=?3 WHERE status='pairing' AND pair_hash=?4 AND pair_until>?3 RETURNING id`)
    .bind(await hash(env,token),until,now,await hash(env,code)).first();
  return row ? {token,until} : null;
}

export function boardCookie(request, token) {
  const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
  return `${BOARD_COOKIE}=${token}; Path=/api/board/; Max-Age=${BOARD_DAYS*86400}; HttpOnly; SameSite=Strict${secure}`;
}

export async function readBoardDevice(request, env, now=Date.now()) {
  let token;
  try { token=readCookie(request,BOARD_COOKIE); } catch { return null; }
  if (!tokenFormat(token) || !env.ADMIN_KEY || !env.DB) return null;
  await ensureBoardDevices(env);
  const row=await env.DB.prepare(`SELECT id,name,token_until,last_seen_at FROM board_devices
    WHERE status='active' AND token_hash=?1 AND token_until>?2`).bind(await hash(env,token),now).first();
  if (row && (!row.last_seen_at || now-row.last_seen_at>=60000)) {
    await env.DB.prepare("UPDATE board_devices SET last_seen_at=?1 WHERE id=?2 AND status='active'").bind(now,row.id).run();
  }
  return row;
}
