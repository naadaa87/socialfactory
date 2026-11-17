/**
 * 소셜팩토리 커뮤니티 — 모임 소개 · 자유게시판 공통 도구
 * ------------------------------------------------------------------
 * - 읽기는 누구나, 글 · 댓글 · 관심 표시 · 신고는 로그인한 회원만 합니다(회원 기능은 _lib/auth.js).
 * - 새 글은 바로 공개합니다. 문제가 있는 글은 관리자가 숨기고, 설정에서 '신고 N건 이상 자동 숨김'을 켤 수 있습니다.
 * - 본문은 글자만 받습니다(HTML 없음). 화면에서 줄바꿈과 http(s) 주소만 링크로 바꿔 보여 줍니다.
 * - 사진은 브라우저에서 JPEG 로 줄인 뒤(위치 정보 등 메타데이터 제거) D1 에 저장합니다.
 * - 필요한 표는 처음 쓸 때 자동으로 만듭니다.
 */
import { json, clean, getMember, sameOrigin, ipHashOf } from './auth.js';
import { adminOk } from './admin.js';

/* ---------- 게시판 · 분류 ---------- */
export const BOARDS = { groups: '모임 소개', free: '자유게시판' };
export const CATEGORIES = {
  groups: {
    study: '스터디', book: '독서 · 글쓰기', network: '네트워킹', career: '창업 · 커리어', hobby: '취미 · 문화',
    language: '외국어 · 언어교환', sports: '운동 · 아웃도어', class: '클래스 · 강연', social: '친목 · 파티', etc: '기타'
  },
  free: { talk: '자유', question: '질문', review: '이용 후기', recruit: '모임 모집', info: '정보 공유', notice: '공지' }
};
export const ADMIN_ONLY_CATEGORIES = { free: ['notice'] };
export const RECRUIT = { open: '모집 중', always: '상시 모집', closed: '모집 마감' };
export const ROOMS = {
  sf: '소셜팩토리 건대', r1: '소셜팩토리 건대 1번룸', r2: '소셜팩토리 건대 2번룸', r3: '소셜팩토리 건대 3번룸',
  r4: '소셜팩토리 건대 4번룸', r5: '소셜팩토리 건대 5번룸', coworking: '소셜팩토리 건대 코워킹 라운지', other: '온라인 · 다른 장소'
};
export const REPORT_REASONS = { spam: '광고 · 홍보 도배', abuse: '욕설 · 비방', privacy: '개인정보 노출', illegal: '불법 · 유해 정보', other: '기타' };
export const RESERVED_NAMES = /소셜\s*팩토리|social\s*factory|관리자|운영자|운영팀|매니저|admin|moderator/i;

export const LIMITS = {
  title: { groups: 40, free: 80 }, summary: 80, body: 5000, comment: 500, images: 6,
  imageBytes: 700000, postGapSec: 30, postsPerDay: 10, commentGapSec: 5, commentsPerDay: 100,
  imagesPerDay: 60, reportsPerDay: 30, urlsInBody: 8
};
export const DEFAULT_SETTINGS = { groupsOpen: true, freeOpen: true, commentsOpen: true, notice: '', bannedWords: [], autoHide: 0 };

/* ---------- 표 ---------- */
export const COMMUNITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published', member_id INTEGER, author_kind TEXT NOT NULL DEFAULT 'member', author_name TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT, body TEXT NOT NULL, info TEXT, recruit TEXT, images TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
    hidden_reason TEXT, admin_memo TEXT, ip_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT,
    publish_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cp_list ON community_posts (board, status, publish_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cp_member ON community_posts (member_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS community_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, member_id INTEGER, author_kind TEXT NOT NULL DEFAULT 'member',
    author_name TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', reports INTEGER NOT NULL DEFAULT 0,
    hidden_reason TEXT, ip_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_post ON community_comments (post_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_member ON community_comments (member_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS community_likes (
    post_id INTEGER NOT NULL, member_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    PRIMARY KEY (post_id, member_id)
  )`,
  `CREATE TABLE IF NOT EXISTS community_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
    reason TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    resolved_at TEXT, UNIQUE (target_type, target_id, member_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cr_status ON community_reports (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS community_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, member_id INTEGER, uploader TEXT NOT NULL DEFAULT 'member',
    mime TEXT NOT NULL DEFAULT 'image/jpeg', width INTEGER, height INTEGER, bytes INTEGER NOT NULL, data_base64 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ci_post ON community_images (post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ci_member ON community_images (member_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS community_profiles (
    member_id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, nickname_key TEXT NOT NULL UNIQUE, banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS community_settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT)`
];
const ready = new WeakMap();
export async function ensureCommunitySchema(env) {
  if (!env.DB) throw new Error('no-db');
  if (!ready.has(env.DB)) {
    const task = (async () => { for (const sql of COMMUNITY_SCHEMA) await env.DB.prepare(sql).run(); })();
    ready.set(env.DB, task); task.catch(() => ready.delete(env.DB));
  }
  await ready.get(env.DB);
}

/* ---------- 작은 도구 ---------- */
export const NOW_SQL = "datetime('now', '+9 hours')";
export const kstNow = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const n = (v) => Number(v) || 0;
export const lines = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max) : '');
export const one = (v, max) => clean(typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ') : '', max);
export function safeUrl(v) {
  const s = one(v, 300);
  if (!s) return '';
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null; } catch { return null; }
}
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const urlCount = (s) => (String(s).match(/https?:\/\//gi) || []).length;
export const parseJson = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
export const imageUrl = (id) => `/api/community/images/${id}`;
export const postUrl = (id) => `/community/${id}`;
export const nicknameKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
export function nicknameProblem(v) {
  const s = one(v, 20);
  if (s.length < 2 || s.length > 12) return '닉네임은 2~12자로 정해 주세요.';
  if (!/^[가-힣A-Za-z0-9_.\- ]+$/.test(s)) return '닉네임에는 한글 · 영문 · 숫자와 _ . - 만 쓸 수 있습니다.';
  if (RESERVED_NAMES.test(s)) return '운영자로 오해할 수 있는 이름은 쓸 수 없습니다.';
  return '';
}
const bad = (message, status = 400, error = 'invalid', extra = {}) => json({ ok: false, error, message, ...extra }, status);

export async function getSettings(env) {
  const row = await env.DB.prepare('SELECT value FROM community_settings WHERE id = 1').first().catch(() => null);
  const v = row ? parseJson(row.value, {}) : {};
  return { ...DEFAULT_SETTINGS, ...v, bannedWords: Array.isArray(v.bannedWords) ? v.bannedWords.filter((w) => typeof w === 'string' && w.trim()) : [] };
}
export function bannedWordIn(settings, ...texts) {
  const all = texts.filter(Boolean).join('\n').toLowerCase();
  return (settings.bannedWords || []).find((w) => all.includes(String(w).trim().toLowerCase())) || '';
}

/* ---------- 게시글 입력 확인 (회원 · 관리자 공통) ---------- */
export function readPostInput(b, { board, admin = false } = {}) {
  const errors = {};
  const cats = CATEGORIES[board];
  const category = one(b.category, 20);
  if (!cats || !cats[category] || (!admin && (ADMIN_ONLY_CATEGORIES[board] || []).includes(category))) errors.category = '분류를 골라 주세요.';
  const title = one(b.title, 120);
  if (title.length < 2 || title.length > LIMITS.title[board]) errors.title = board === 'groups' ? `모임 이름은 2~${LIMITS.title.groups}자로 적어 주세요.` : `제목은 2~${LIMITS.title.free}자로 적어 주세요.`;
  const body = lines(b.body, LIMITS.body + 1);
  if (body.length < (board === 'groups' ? 20 : 5)) errors.body = board === 'groups' ? '모임 소개를 20자 이상 적어 주세요.' : '내용을 5자 이상 적어 주세요.';
  if (body.length > LIMITS.body) errors.body = `내용은 ${LIMITS.body.toLocaleString('ko-KR')}자 이하로 줄여 주세요.`;
  if (!admin && urlCount(body) > LIMITS.urlsInBody) errors.body = `본문의 링크는 ${LIMITS.urlsInBody}개까지 넣을 수 있습니다.`;
  let summary = null, info = null, recruit = null;
  if (board === 'groups') {
    summary = one(b.summary, 120);
    if (summary.length < 5 || summary.length > LIMITS.summary) errors.summary = `한 줄 소개를 5~${LIMITS.summary}자로 적어 주세요.`;
    recruit = RECRUIT[b.recruit] ? b.recruit : null;
    if (!recruit) errors.recruit = '모집 상태를 골라 주세요.';
    const i = b.info && typeof b.info === 'object' ? b.info : {};
    info = {
      schedule: one(i.schedule, 60), nextDate: isDate(i.nextDate) ? i.nextDate : '', room: ROOMS[i.room] ? i.room : '',
      audience: one(i.audience, 60), fee: one(i.fee, 40), contactText: one(i.contactText, 80)
    };
    for (const k of ['joinUrl', 'contactUrl', 'snsUrl']) {
      const u = safeUrl(i[k]);
      if (u === null) errors[k] = '링크는 https:// 로 시작하는 주소로 적어 주세요.'; else info[k] = u;
    }
    if (i.nextDate && !info.nextDate) errors.nextDate = '날짜를 확인해 주세요.';
    if (!info.joinUrl && !info.contactUrl && !info.contactText) errors.joinUrl = '참여 신청 링크 · 문의 링크 · 문의 연락처 중 하나는 적어 주세요.';
  }
  const images = Array.isArray(b.images) ? [...new Set(b.images.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : [];
  if (images.length > LIMITS.images) errors.images = `사진은 ${LIMITS.images}장까지 올릴 수 있습니다.`;
  return { errors, value: { category, title, body, summary, info, recruit, images } };
}

/* ---------- 화면에 보낼 모양 ---------- */
const isVisible = (p, now = kstNow()) => p && p.status === 'published' && String(p.publish_at) <= now;
export { isVisible };
export function excerpt(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
export function shapePost(p, { detail = false, me = null, liked = false, admin = false } = {}) {
  const images = parseJson(p.images, []).filter(Number.isInteger);
  const info = parseJson(p.info, null);
  const out = {
    id: p.id, url: postUrl(p.id), board: p.board, boardName: BOARDS[p.board] || p.board,
    category: p.category, categoryName: (CATEGORIES[p.board] || {})[p.category] || p.category,
    title: p.title, summary: p.summary || '', excerpt: excerpt(p.summary || p.body, p.board === 'groups' ? 90 : 120),
    recruit: p.recruit || '', recruitName: RECRUIT[p.recruit] || '',
    cover: images.length ? imageUrl(images[0]) : '', imageCount: images.length,
    author: { name: p.author_kind === 'admin' ? (p.author_name || '소셜팩토리') : (p.author_name || '회원'), staff: p.author_kind === 'admin' },
    pinned: !!p.pinned, featured: !!p.featured, views: n(p.views), likes: n(p.likes), comments: n(p.comments),
    createdAt: p.created_at, publishedAt: p.publish_at, updatedAt: p.updated_at || ''
  };
  if (p.board === 'groups' && info) {
    out.info = { schedule: info.schedule || '', nextDate: info.nextDate || '', room: info.room || '', roomName: ROOMS[info.room] || '', audience: info.audience || '', fee: info.fee || '' };
    if (detail) Object.assign(out.info, { joinUrl: info.joinUrl || '', contactUrl: info.contactUrl || '', contactText: info.contactText || '', snsUrl: info.snsUrl || '' });
  }
  if (detail) {
    out.body = p.body;
    out.images = images.map((id) => ({ id, url: imageUrl(id) }));
    out.liked = !!liked;
    out.mine = !!(me && p.member_id && me.id === p.member_id);
    if (out.mine || admin) { out.status = p.status; out.hiddenReason = p.hidden_reason || ''; }
  }
  return out;
}

/* ---------- 회원 · 프로필 ---------- */
export async function memberContext(request, env) {
  const m = await getMember(request, env);
  if (!m) return { member: null, profile: null };
  const profile = await env.DB.prepare('SELECT * FROM community_profiles WHERE member_id = ?1').bind(m.id).first();
  return { member: m, profile: profile || null };
}
async function saveNickname(env, memberId, nickname) {
  const problem = nicknameProblem(nickname);
  if (problem) return { error: problem };
  const nick = one(nickname, 20), key = nicknameKey(nick);
  const taken = await env.DB.prepare('SELECT member_id FROM community_profiles WHERE nickname_key = ?1').bind(key).first();
  if (taken && taken.member_id !== memberId) return { error: '이미 쓰고 있는 닉네임입니다. 다른 이름을 골라 주세요.' };
  await env.DB.prepare(`INSERT INTO community_profiles (member_id, nickname, nickname_key) VALUES (?1, ?2, ?3)
    ON CONFLICT(member_id) DO UPDATE SET nickname = excluded.nickname, nickname_key = excluded.nickname_key, updated_at = ${NOW_SQL}`).bind(memberId, nick, key).run();
  return { nickname: nick };
}
export { saveNickname };

/** 글 · 댓글을 쓸 수 있는 회원인지. 통과하면 { member, profile }, 아니면 응답 */
async function writer(request, env, { nickname } = {}) {
  if (!sameOrigin(request)) return { res: bad('허용되지 않은 요청입니다.', 403, 'origin') };
  const { member, profile } = await memberContext(request, env);
  if (!member) return { res: bad('로그인한 회원만 쓸 수 있습니다.', 401, 'login') };
  if (profile && profile.banned) return { res: bad('커뮤니티 글쓰기가 제한된 계정입니다. 카카오톡 문의채널로 문의해 주세요.', 403, 'banned') };
  let prof = profile;
  if (!prof || (nickname && one(nickname, 20) !== prof.nickname)) {
    if (!nickname && !prof) return { res: bad('커뮤니티에서 쓸 닉네임을 먼저 정해 주세요.', 400, 'nickname', { fields: { nickname: '닉네임을 정해 주세요.' } }) };
    if (nickname) {
      const r = await saveNickname(env, member.id, nickname);
      if (r.error) return { res: bad(r.error, 400, 'nickname', { fields: { nickname: r.error } }) };
      prof = { ...(prof || {}), member_id: member.id, nickname: r.nickname, banned: 0 };
    }
  }
  return { member, profile: prof };
}

async function recentCount(env, table, memberId, seconds) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE member_id = ?1 AND created_at > datetime('now', '+9 hours', ?2)`).bind(memberId, `-${seconds} seconds`).first();
  return n(r && r.c);
}

/** 올린 사진을 글에 붙입니다. 내가 올렸고 아직 다른 글에 붙지 않은 사진만. */
export async function attachImages(env, postId, ids, { memberId = null, admin = false } = {}) {
  const keep = [];
  for (const id of ids.slice(0, LIMITS.images)) {
    const img = await env.DB.prepare('SELECT id, post_id, member_id, uploader FROM community_images WHERE id = ?1').bind(id).first();
    if (!img) continue;
    if (img.post_id && img.post_id !== postId) continue;
    if (!admin && img.member_id !== memberId) continue;
    keep.push(id);
  }
  for (const id of keep) await env.DB.prepare('UPDATE community_images SET post_id = ?1 WHERE id = ?2').bind(postId, id).run();
  // 이 글에서 빠진 사진은 연결을 끊습니다(하루 뒤 정리).
  const old = await env.DB.prepare('SELECT id FROM community_images WHERE post_id = ?1').bind(postId).all();
  for (const r of old.results || []) if (!keep.includes(r.id)) await env.DB.prepare("UPDATE community_images SET post_id = NULL, created_at = datetime('now', '+9 hours', '-2 days') WHERE id = ?1").bind(r.id).run();
  return keep;
}

export async function refreshCounts(env, postId) {
  await env.DB.prepare(`UPDATE community_posts SET
    comments = (SELECT COUNT(*) FROM community_comments WHERE post_id = ?1 AND status = 'published'),
    likes = (SELECT COUNT(*) FROM community_likes WHERE post_id = ?1) WHERE id = ?1`).bind(postId).run();
}

/** 가끔 정리: 글에 붙지 않은 사진(하루 지난 것), 지운 지 30일 지난 글과 딸린 기록 */
export async function purge(env, chance = 0.02) {
  if (Math.random() >= chance) return;
  try {
    await env.DB.prepare(`DELETE FROM community_images WHERE post_id IS NULL AND created_at < datetime('now', '+9 hours', '-1 day')`).run();
    const old = await env.DB.prepare(`SELECT id FROM community_posts WHERE status = 'deleted' AND deleted_at < datetime('now', '+9 hours', '-30 days') LIMIT 50`).all();
    for (const r of old.results || []) await hardDeletePost(env, r.id);
  } catch (e) { console.error('community-purge', e && e.message); }
}
export async function hardDeletePost(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM community_images WHERE post_id = ?1').bind(id),
    env.DB.prepare(`DELETE FROM community_reports WHERE (target_type = 'post' AND target_id = ?1) OR (target_type = 'comment' AND target_id IN (SELECT id FROM community_comments WHERE post_id = ?1))`).bind(id),
    env.DB.prepare('DELETE FROM community_comments WHERE post_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM community_likes WHERE post_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM community_posts WHERE id = ?1').bind(id)
  ]);
}

/* ---------- 사진 확인 (JPEG) ---------- */
export function readJpeg(base64, maxBytes = LIMITS.imageBytes) {
  if (typeof base64 !== 'string' || base64.length < 100 || base64.length > Math.ceil(maxBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  let bin; try { bin = atob(base64); } catch { return null; }
  const len = bin.length, at = (i) => bin.charCodeAt(i);
  if (len < 100 || len > maxBytes || at(0) !== 0xff || at(1) !== 0xd8 || at(2) !== 0xff) return null;
  let width = 0, height = 0;
  for (let i = 2; i + 9 < len;) {
    if (at(i) !== 0xff) { i++; continue; }
    const marker = at(i + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const size = (at(i + 2) << 8) | at(i + 3);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      height = (at(i + 5) << 8) | at(i + 6); width = (at(i + 7) << 8) | at(i + 8); break;
    }
    if (marker === 0xda || size < 2) break;
    i += 2 + size;
  }
  if (!width || !height || width > 6000 || height > 6000) return null;
  return { bytes: len, width, height };
}

/* ========================================================================
   공개 API — /api/community/*
   ======================================================================== */
export async function handlePublic(context) {
  const { request, env } = context;
  if (!env.DB) return bad('커뮤니티를 준비하고 있습니다.', 503, 'no-db');
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/community\/?/, '').split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && Number(request.headers.get('content-length') || 0) > 1100000) return bad('보내는 내용이 너무 큽니다.', 413, 'too-large');
  try {
    await ensureCommunitySchema(env);
    const [a, b, c] = parts;
    if (a === 'config' && method === 'GET') return config(request, env);
    if (a === 'profile' && method === 'PUT') return profilePut(request, env);
    if (a === 'posts' && !b && method === 'GET') return listPosts(request, env, url);
    if (a === 'posts' && !b && method === 'POST') return createPost(request, env);
    if (a === 'posts' && /^\d+$/.test(b || '')) {
      const id = Number(b);
      if (!c && method === 'GET') return getPost(request, env, id);
      if (!c && method === 'PATCH') return updatePost(request, env, id);
      if (!c && method === 'DELETE') return deletePost(request, env, id);
      if (c === 'comments' && method === 'GET') return listComments(request, env, id);
      if (c === 'comments' && method === 'POST') return addComment(request, env, id);
      if (c === 'like' && method === 'POST') return toggleLike(request, env, id);
      if (c === 'view' && method === 'POST') return addView(request, env, id);
    }
    if (a === 'comments' && /^\d+$/.test(b || '') && method === 'DELETE') return deleteComment(request, env, Number(b));
    if (a === 'report' && method === 'POST') return report(request, env);
    if (a === 'images' && !b && method === 'POST') return uploadImage(request, env);
    if (a === 'images' && /^\d+$/.test(b || '') && method === 'GET') return serveImage(request, env, Number(b));
    return bad('찾을 수 없는 주소입니다.', 404, 'not-found');
  } catch (e) {
    console.error('community', e && e.message);
    return bad('처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500, 'server');
  }
}

async function readBody(request) { try { const b = await request.json(); return b && typeof b === 'object' ? b : {}; } catch { return null; } }

async function config(request, env) {
  const s = await getSettings(env);
  const { member, profile } = await memberContext(request, env);
  return json({
    ok: true, boards: BOARDS, categories: CATEGORIES, adminOnly: ADMIN_ONLY_CATEGORIES, recruit: RECRUIT, rooms: ROOMS, reasons: REPORT_REASONS, limits: { images: LIMITS.images, body: LIMITS.body, comment: LIMITS.comment, title: LIMITS.title, summary: LIMITS.summary },
    settings: { groupsOpen: !!s.groupsOpen, freeOpen: !!s.freeOpen, commentsOpen: !!s.commentsOpen, notice: s.notice || '' },
    me: member ? { loggedIn: true, nickname: profile ? profile.nickname : '', banned: !!(profile && profile.banned) } : { loggedIn: false }
  });
}

async function profilePut(request, env) {
  if (!sameOrigin(request)) return bad('허용되지 않은 요청입니다.', 403, 'origin');
  const { member } = await memberContext(request, env);
  if (!member) return bad('로그인이 필요합니다.', 401, 'login');
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const r = await saveNickname(env, member.id, b.nickname);
  if (r.error) return bad(r.error, 400, 'nickname', { fields: { nickname: r.error } });
  // 이미 쓴 글 · 댓글의 이름도 함께 바꿉니다.
  await env.DB.prepare("UPDATE community_posts SET author_name = ?1 WHERE member_id = ?2 AND author_kind = 'member'").bind(r.nickname, member.id).run();
  await env.DB.prepare("UPDATE community_comments SET author_name = ?1 WHERE member_id = ?2 AND author_kind = 'member'").bind(r.nickname, member.id).run();
  return json({ ok: true, nickname: r.nickname });
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
async function listPosts(request, env, url) {
  const q = url.searchParams;
  const board = BOARDS[q.get('board')] ? q.get('board') : 'groups';
  const size = Math.min(Math.max(parseInt(q.get('size'), 10) || (board === 'groups' ? 12 : 20), 1), 30);
  const page = Math.min(Math.max(parseInt(q.get('page'), 10) || 1, 1), 500);
  const now = kstNow();
  const where = ['board = ?1'], args = [board];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '?' + args.length)); };
  let me = null;
  if (q.get('mine') === '1') {
    ({ member: me } = await memberContext(request, env));
    if (!me) return bad('로그인이 필요합니다.', 401, 'login');
    add('member_id = ?', me.id); where.push("status IN ('published', 'hidden')");
  } else {
    add('publish_at <= ?', now); where.push("status = 'published'");
  }
  const cat = q.get('cat');
  if (cat && (CATEGORIES[board] || {})[cat]) add('category = ?', cat);
  if (board === 'groups' && q.get('recruit') === 'open') where.push("recruit IN ('open', 'always')");
  if (q.get('featured') === '1') where.push('featured = 1');
  const text = one(q.get('q') || '', 40);
  if (text) { args.push('%' + likeEscape(text) + '%'); const k = '?' + args.length; where.push(`(title LIKE ${k} ESCAPE '\\' OR summary LIKE ${k} ESCAPE '\\' OR body LIKE ${k} ESCAPE '\\' OR author_name LIKE ${k} ESCAPE '\\')`); }
  const sort = q.get('sort');
  let order = board === 'free' ? 'pinned DESC, publish_at DESC, id DESC' : 'publish_at DESC, id DESC';
  if (sort === 'popular') order = '(likes * 3 + comments * 2 + views / 20.0) DESC, publish_at DESC';
  if (sort === 'home') order = "featured DESC, CASE WHEN recruit = 'closed' THEN 1 ELSE 0 END, publish_at DESC, id DESC";
  const W = where.join(' AND ');
  const total = n((await env.DB.prepare(`SELECT COUNT(*) AS c FROM community_posts WHERE ${W}`).bind(...args).first() || {}).c);
  const rows = (await env.DB.prepare(`SELECT * FROM community_posts WHERE ${W} ORDER BY ${order} LIMIT ${size} OFFSET ${(page - 1) * size}`).bind(...args).all()).results || [];
  const posts = rows.map((p) => { const s = shapePost(p); if (me) { s.status = p.status; s.hiddenReason = p.hidden_reason || ''; } return s; });
  return json({ ok: true, board, page, size, total, pages: Math.max(1, Math.ceil(total / size)), posts }, 200, { 'Cache-Control': 'no-store' });
}

async function loadPost(env, id) { return env.DB.prepare('SELECT * FROM community_posts WHERE id = ?1').bind(id).first(); }

async function getPost(request, env, id) {
  const p = await loadPost(env, id);
  const { member } = await memberContext(request, env);
  const admin = !p || isVisible(p) ? false : await adminOk(request, env);
  const mine = !!(p && member && p.member_id === member.id && p.status !== 'deleted');
  if (!p || (!isVisible(p) && !mine && !admin)) return bad('글을 찾을 수 없습니다. 삭제되었거나 비공개로 바뀌었을 수 있습니다.', 404, 'not-found');
  const liked = member ? !!(await env.DB.prepare('SELECT 1 AS x FROM community_likes WHERE post_id = ?1 AND member_id = ?2').bind(id, member.id).first()) : false;
  const post = shapePost(p, { detail: true, me: member, liked, admin });
  const comments = await commentRows(env, id, member);
  return json({ ok: true, post, comments });
}

async function commentRows(env, postId, member) {
  const rows = (await env.DB.prepare("SELECT * FROM community_comments WHERE post_id = ?1 AND status = 'published' ORDER BY id LIMIT 500").bind(postId).all()).results || [];
  return rows.map((c) => ({ id: c.id, body: c.body, author: { name: c.author_name, staff: c.author_kind === 'admin' }, createdAt: c.created_at, mine: !!(member && c.member_id === member.id) }));
}

async function createPost(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const board = BOARDS[b.board] ? b.board : '';
  if (!board) return bad('게시판을 골라 주세요.');
  const w = await writer(request, env, { nickname: b.nickname }); if (w.res) return w.res;
  const s = await getSettings(env);
  if (!(board === 'groups' ? s.groupsOpen : s.freeOpen)) return bad(`지금은 ${BOARDS[board]}에 새 글을 받지 않습니다.`, 403, 'closed');
  const { errors, value } = readPostInput(b, { board });
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const word = bannedWordIn(s, value.title, value.summary, value.body, value.info && JSON.stringify(value.info));
  if (word) return bad(`사용할 수 없는 표현이 들어 있습니다: ${word}`, 400, 'banned-word');
  if (await recentCount(env, 'community_posts', w.member.id, LIMITS.postGapSec)) return bad('조금 전에 글을 올렸습니다. 30초 뒤에 다시 올려 주세요.', 429, 'too-fast');
  if ((await recentCount(env, 'community_posts', w.member.id, 86400)) >= LIMITS.postsPerDay) return bad(`글은 하루 ${LIMITS.postsPerDay}개까지 올릴 수 있습니다.`, 429, 'too-many');
  const row = await env.DB.prepare(`INSERT INTO community_posts (board, category, member_id, author_kind, author_name, title, summary, body, info, recruit, images, ip_hash)
    VALUES (?1, ?2, ?3, 'member', ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10) RETURNING id`).bind(
    board, value.category, w.member.id, w.profile.nickname, value.title, value.summary, value.body,
    value.info ? JSON.stringify(value.info) : null, value.recruit, await ipHashOf(request, env)).first();
  const images = await attachImages(env, row.id, value.images, { memberId: w.member.id });
  await env.DB.prepare('UPDATE community_posts SET images = ?1 WHERE id = ?2').bind(JSON.stringify(images), row.id).run();
  await purge(env);
  return json({ ok: true, id: row.id, url: postUrl(row.id) });
}

async function updatePost(request, env, id) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const w = await writer(request, env, { nickname: b.nickname }); if (w.res) return w.res;
  const p = await loadPost(env, id);
  if (!p || p.status === 'deleted' || p.member_id !== w.member.id) return bad('내가 쓴 글만 고칠 수 있습니다.', 403, 'forbidden');
  const s = await getSettings(env);
  const { errors, value } = readPostInput(b, { board: p.board });
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const word = bannedWordIn(s, value.title, value.summary, value.body, value.info && JSON.stringify(value.info));
  if (word) return bad(`사용할 수 없는 표현이 들어 있습니다: ${word}`, 400, 'banned-word');
  const images = await attachImages(env, id, value.images, { memberId: w.member.id });
  await env.DB.prepare(`UPDATE community_posts SET category = ?1, title = ?2, summary = ?3, body = ?4, info = ?5, recruit = ?6, images = ?7,
    author_name = ?8, updated_at = ${NOW_SQL} WHERE id = ?9`).bind(value.category, value.title, value.summary, value.body,
    value.info ? JSON.stringify(value.info) : null, value.recruit, JSON.stringify(images), w.profile.nickname, id).run();
  return json({ ok: true, id, url: postUrl(id) });
}

async function deletePost(request, env, id) {
  if (!sameOrigin(request)) return bad('허용되지 않은 요청입니다.', 403, 'origin');
  const { member } = await memberContext(request, env);
  if (!member) return bad('로그인이 필요합니다.', 401, 'login');
  const p = await loadPost(env, id);
  if (!p || p.status === 'deleted' || p.member_id !== member.id) return bad('내가 쓴 글만 지울 수 있습니다.', 403, 'forbidden');
  await env.DB.prepare(`UPDATE community_posts SET status = 'deleted', deleted_at = ${NOW_SQL} WHERE id = ?1`).bind(id).run();
  return json({ ok: true });
}

async function listComments(request, env, id) {
  const p = await loadPost(env, id);
  if (!isVisible(p)) return bad('글을 찾을 수 없습니다.', 404, 'not-found');
  const { member } = await memberContext(request, env);
  return json({ ok: true, comments: await commentRows(env, id, member) });
}

async function addComment(request, env, id) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const w = await writer(request, env, { nickname: b.nickname }); if (w.res) return w.res;
  const s = await getSettings(env);
  if (!s.commentsOpen) return bad('지금은 댓글을 받지 않습니다.', 403, 'closed');
  const p = await loadPost(env, id);
  if (!isVisible(p)) return bad('글을 찾을 수 없습니다.', 404, 'not-found');
  const body = lines(b.body, LIMITS.comment + 1);
  if (!body) return bad('댓글 내용을 적어 주세요.', 400, 'invalid', { fields: { body: '댓글 내용을 적어 주세요.' } });
  if (body.length > LIMITS.comment) return bad(`댓글은 ${LIMITS.comment}자까지 쓸 수 있습니다.`, 400, 'invalid', { fields: { body: '너무 깁니다.' } });
  const word = bannedWordIn(s, body);
  if (word) return bad(`사용할 수 없는 표현이 들어 있습니다: ${word}`, 400, 'banned-word');
  if (await recentCount(env, 'community_comments', w.member.id, LIMITS.commentGapSec)) return bad('조금 뒤에 다시 남겨 주세요.', 429, 'too-fast');
  if ((await recentCount(env, 'community_comments', w.member.id, 86400)) >= LIMITS.commentsPerDay) return bad(`댓글은 하루 ${LIMITS.commentsPerDay}개까지 남길 수 있습니다.`, 429, 'too-many');
  await env.DB.prepare(`INSERT INTO community_comments (post_id, member_id, author_kind, author_name, body, ip_hash) VALUES (?1, ?2, 'member', ?3, ?4, ?5)`)
    .bind(id, w.member.id, w.profile.nickname, body, await ipHashOf(request, env)).run();
  await refreshCounts(env, id);
  return json({ ok: true, comments: await commentRows(env, id, w.member) });
}

async function deleteComment(request, env, cid) {
  if (!sameOrigin(request)) return bad('허용되지 않은 요청입니다.', 403, 'origin');
  const { member } = await memberContext(request, env);
  if (!member) return bad('로그인이 필요합니다.', 401, 'login');
  const c = await env.DB.prepare('SELECT * FROM community_comments WHERE id = ?1').bind(cid).first();
  if (!c || c.member_id !== member.id || c.status === 'deleted') return bad('내가 쓴 댓글만 지울 수 있습니다.', 403, 'forbidden');
  await env.DB.prepare(`UPDATE community_comments SET status = 'deleted', updated_at = ${NOW_SQL} WHERE id = ?1`).bind(cid).run();
  await refreshCounts(env, c.post_id);
  return json({ ok: true, comments: await commentRows(env, c.post_id, member) });
}

async function toggleLike(request, env, id) {
  if (!sameOrigin(request)) return bad('허용되지 않은 요청입니다.', 403, 'origin');
  const { member } = await memberContext(request, env);
  if (!member) return bad('로그인한 회원만 관심 표시를 할 수 있습니다.', 401, 'login');
  const p = await loadPost(env, id);
  if (!isVisible(p)) return bad('글을 찾을 수 없습니다.', 404, 'not-found');
  const del = await env.DB.prepare('DELETE FROM community_likes WHERE post_id = ?1 AND member_id = ?2').bind(id, member.id).run();
  const removed = n(del && del.meta && del.meta.changes) > 0;
  if (!removed) await env.DB.prepare('INSERT OR IGNORE INTO community_likes (post_id, member_id) VALUES (?1, ?2)').bind(id, member.id).run();
  await refreshCounts(env, id);
  const fresh = await loadPost(env, id);
  return json({ ok: true, liked: !removed, likes: n(fresh.likes) });
}

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|kakaotalk-scrap|yeti|daumoa|python|curl|wget/i;
async function addView(request, env, id) {
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BOT.test(ua) || !sameOrigin(request)) return json({ ok: true, counted: false });
  const r = await env.DB.prepare(`UPDATE community_posts SET views = views + 1 WHERE id = ?1 AND status = 'published' AND publish_at <= ?2`).bind(id, kstNow()).run();
  return json({ ok: true, counted: n(r && r.meta && r.meta.changes) > 0 });
}

async function report(request, env) {
  if (!sameOrigin(request)) return bad('허용되지 않은 요청입니다.', 403, 'origin');
  const { member } = await memberContext(request, env);
  if (!member) return bad('로그인한 회원만 신고할 수 있습니다.', 401, 'login');
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const type = b.type === 'comment' ? 'comment' : b.type === 'post' ? 'post' : '';
  const id = Number(b.id), reason = REPORT_REASONS[b.reason] ? b.reason : '';
  if (!type || !Number.isInteger(id) || !reason) return bad('신고할 내용과 이유를 골라 주세요.');
  const table = type === 'post' ? 'community_posts' : 'community_comments';
  const target = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(id).first();
  if (!target || target.status !== 'published') return bad('이미 내려간 글입니다.', 404, 'not-found');
  if (target.member_id === member.id) return bad('내가 쓴 글은 신고할 수 없습니다.', 400, 'own');
  if ((await recentCount(env, 'community_reports', member.id, 86400)) >= LIMITS.reportsPerDay) return bad('오늘은 더 신고할 수 없습니다. 카카오톡 문의채널로 알려 주세요.', 429, 'too-many');
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO community_reports (target_type, target_id, member_id, reason, detail) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(type, id, member.id, reason, lines(b.detail, 300) || null).run();
  const added = n(ins && ins.meta && ins.meta.changes) > 0;
  if (added) {
    await env.DB.prepare(`UPDATE ${table} SET reports = (SELECT COUNT(*) FROM community_reports WHERE target_type = ?2 AND target_id = ?1 AND status = 'open') WHERE id = ?1`).bind(id, type).run();
    const s = await getSettings(env);
    const fresh = await env.DB.prepare(`SELECT reports FROM ${table} WHERE id = ?1`).bind(id).first();
    if (s.autoHide > 0 && n(fresh.reports) >= s.autoHide) {
      await env.DB.prepare(`UPDATE ${table} SET status = 'hidden', hidden_reason = '신고가 쌓여 자동으로 숨겼습니다' WHERE id = ?1 AND status = 'published'`).bind(id).run();
      if (type === 'comment') await refreshCounts(env, target.post_id);
    }
  }
  return json({ ok: true, already: !added });
}

async function uploadImage(request, env, { admin = false } = {}) {
  let memberId = null;
  if (!admin) {
    if (!sameOrigin(request)) return bad('허용되지 않은 요청입니다.', 403, 'origin');
    const { member, profile } = await memberContext(request, env);
    if (!member) return bad('로그인한 회원만 사진을 올릴 수 있습니다.', 401, 'login');
    if (profile && profile.banned) return bad('커뮤니티 글쓰기가 제한된 계정입니다.', 403, 'banned');
    memberId = member.id;
    if ((await recentCount(env, 'community_images', memberId, 86400)) >= LIMITS.imagesPerDay) return bad('오늘은 사진을 더 올릴 수 없습니다.', 429, 'too-many');
  }
  if (Number(request.headers.get('content-length') || 0) > 1100000) return bad('사진 파일이 너무 큽니다.', 413, 'too-large');
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const img = readJpeg(b.base64);
  if (!img) return bad('사진을 읽지 못했습니다. JPG · PNG 사진으로 다시 골라 주세요.', 400, 'invalid-image');
  const row = await env.DB.prepare(`INSERT INTO community_images (member_id, uploader, mime, width, height, bytes, data_base64) VALUES (?1, ?2, 'image/jpeg', ?3, ?4, ?5, ?6) RETURNING id`)
    .bind(memberId, admin ? 'admin' : 'member', img.width, img.height, img.bytes, b.base64).first();
  return json({ ok: true, id: row.id, url: imageUrl(row.id), width: img.width, height: img.height });
}
export { uploadImage };

async function serveImage(request, env, id) {
  const img = await env.DB.prepare('SELECT * FROM community_images WHERE id = ?1').bind(id).first();
  if (!img) return new Response('Not found', { status: 404 });
  let open = false;
  if (img.post_id) { const p = await loadPost(env, img.post_id); open = isVisible(p); }
  if (!open) {
    const { member } = await memberContext(request, env);
    const allowed = (member && img.member_id === member.id) || (await adminOk(request, env));
    if (!allowed) return new Response('Not found', { status: 404 });
  }
  const bin = atob(img.data_base64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: {
    'Content-Type': img.mime || 'image/jpeg', 'Cache-Control': open ? 'public, max-age=3600' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'"
  } });
}
