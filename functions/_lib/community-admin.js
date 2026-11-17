/**
 * 관리자 — 커뮤니티 관리 API (/api/admin/community/*)
 * 게시글 · 댓글 · 신고 · 회원(글쓰기 제한) · 설정 · 운영자 글(공지 · 예약 발행)을 다룹니다.
 */
import { json, clean } from './auth.js';
import { adminGate } from './admin.js';
import {
  BOARDS, CATEGORIES, RECRUIT, ROOMS, REPORT_REASONS, DEFAULT_SETTINGS, LIMITS, NOW_SQL,
  ensureCommunitySchema, getSettings, readPostInput, shapePost, attachImages, refreshCounts, hardDeletePost,
  uploadImage, saveNickname, one, lines, parseJson, kstNow, imageUrl, postUrl, isVisible
} from './community.js';

const bad = (message, status = 400, error = 'invalid', extra = {}) => json({ ok: false, error, message, ...extra }, status);
const n = (v) => Number(v) || 0;
const STATUS = { published: '공개', scheduled: '예약 발행', draft: '임시 저장', hidden: '숨김', deleted: '삭제됨' };
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
/** 'YYYY-MM-DDTHH:MM' 또는 'YYYY-MM-DD HH:MM(:SS)' → 'YYYY-MM-DD HH:MM:SS' */
export function kstStamp(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v || '').trim());
  if (!m || isNaN(Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`))) return '';
  return `${m[1]} ${m[2]}:${m[3]}:${m[4] || '00'}`;
}

export async function handleAdmin(context) {
  const { request, env } = context;
  const deny = await adminGate(request, env); if (deny) return deny;
  const url = new URL(request.url);
  const [a, b, c] = url.pathname.replace(/^\/api\/admin\/community\/?/, '').split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  try {
    await ensureCommunitySchema(env);
    const id = /^\d+$/.test(b || '') ? Number(b) : 0;
    if (a === 'summary' && method === 'GET') return summary(env);
    if (a === 'meta' && method === 'GET') return json({ ok: true, boards: BOARDS, categories: CATEGORIES, recruit: RECRUIT, rooms: ROOMS, reasons: REPORT_REASONS, status: STATUS, limits: LIMITS });
    if (a === 'posts' && !b && method === 'GET') return listPosts(env, url.searchParams);
    if (a === 'posts' && !b && method === 'POST') return createPost(request, env);
    if (a === 'posts' && id && !c && method === 'GET') return getPost(env, id);
    if (a === 'posts' && id && !c && method === 'PATCH') return updatePost(request, env, id);
    if (a === 'posts' && id && !c && method === 'DELETE') { await hardDeletePost(env, id); return json({ ok: true }); }
    if (a === 'posts' && id && c === 'comments' && method === 'POST') return addComment(request, env, id);
    if (a === 'comments' && !b && method === 'GET') return listComments(env, url.searchParams);
    if (a === 'comments' && id && method === 'PATCH') return updateComment(request, env, id);
    if (a === 'comments' && id && method === 'DELETE') return deleteComment(env, id);
    if (a === 'reports' && !b && method === 'GET') return listReports(env, url.searchParams);
    if (a === 'reports' && b === 'resolve' && method === 'POST') return resolveReports(request, env);
    if (a === 'members' && !b && method === 'GET') return listMembers(env, url.searchParams);
    if (a === 'members' && id && method === 'PATCH') return updateMember(request, env, id);
    if (a === 'settings' && method === 'GET') return json({ ok: true, settings: await getSettings(env) });
    if (a === 'settings' && method === 'PUT') return saveSettings(request, env);
    if (a === 'images' && method === 'POST') return uploadImage(request, env, { admin: true });
    return bad('찾을 수 없는 주소입니다.', 404, 'not-found');
  } catch (e) {
    console.error('admin-community', e && e.message);
    return bad('처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500, 'server');
  }
}
async function readBody(request) { try { const b = await request.json(); return b && typeof b === 'object' ? b : {}; } catch { return null; } }
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
const first = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).first()) || {};

function statusOf(p, now = kstNow()) {
  if (p.status === 'published' && String(p.publish_at) > now) return 'scheduled';
  return p.status;
}
function adminShape(p, now) {
  const s = shapePost(p);
  return { ...s, status: statusOf(p, now), statusName: STATUS[statusOf(p, now)] || p.status, reports: n(p.reports), memberId: p.member_id || null,
    hiddenReason: p.hidden_reason || '', adminMemo: p.admin_memo || '', authorKind: p.author_kind, publishAt: p.publish_at, deletedAt: p.deleted_at || '' };
}

async function summary(env) {
  const now = kstNow(), today = now.slice(0, 10);
  const posts = await all(env, `SELECT board, status, CASE WHEN status = 'published' AND publish_at > ?1 THEN 1 ELSE 0 END AS later, COUNT(*) AS c FROM community_posts GROUP BY board, status, later`, now);
  const count = (pred) => posts.filter(pred).reduce((s, r) => s + n(r.c), 0);
  const reports = await first(env, `SELECT COUNT(*) AS c, COUNT(DISTINCT target_type || ':' || target_id) AS t FROM community_reports WHERE status = 'open'`);
  const todayPosts = await first(env, `SELECT COUNT(*) AS c FROM community_posts WHERE substr(created_at, 1, 10) = ?1 AND status <> 'deleted'`, today);
  const todayComments = await first(env, `SELECT COUNT(*) AS c FROM community_comments WHERE substr(created_at, 1, 10) = ?1 AND status = 'published'`, today);
  const members = await first(env, 'SELECT COUNT(*) AS c, SUM(banned) AS b FROM community_profiles');
  const images = await first(env, 'SELECT COUNT(*) AS c, SUM(bytes) AS b FROM community_images');
  return json({ ok: true, summary: {
    groups: count((r) => r.board === 'groups' && r.status === 'published' && !r.later), free: count((r) => r.board === 'free' && r.status === 'published' && !r.later),
    scheduled: count((r) => r.status === 'published' && r.later), drafts: count((r) => r.status === 'draft'), hidden: count((r) => r.status === 'hidden'),
    openReports: n(reports.c), reportedTargets: n(reports.t), todayPosts: n(todayPosts.c), todayComments: n(todayComments.c),
    members: n(members.c), banned: n(members.b), imageCount: n(images.c), imageBytes: n(images.b)
  } });
}

async function listPosts(env, q) {
  const now = kstNow(), where = [], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '?' + args.length)); };
  if (BOARDS[q.get('board')]) add('board = ?', q.get('board'));
  const st = q.get('status') || 'active';
  if (st === 'active') where.push("status <> 'deleted'");
  else if (st === 'scheduled') { add("status = 'published' AND publish_at > ?", now); }
  else if (st === 'published') { add("status = 'published' AND publish_at <= ?", now); }
  else if (STATUS[st]) add('status = ?', st);
  if (q.get('reported') === '1') where.push('reports > 0');
  if (q.get('pinned') === '1') where.push('(pinned = 1 OR featured = 1)');
  const memberId = parseInt(q.get('member'), 10);
  if (memberId > 0) add('member_id = ?', memberId);
  const text = one(q.get('q') || '', 40);
  if (text) {
    args.push('%' + likeEscape(text) + '%'); const k = '?' + args.length;
    let idSql = '';
    if (/^\d{1,9}$/.test(text)) { args.push(Number(text)); idSql = ` OR id = ?${args.length}`; }
    where.push(`(title LIKE ${k} ESCAPE '\\' OR body LIKE ${k} ESCAPE '\\' OR author_name LIKE ${k} ESCAPE '\\'${idSql})`);
  }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const size = 30, page = Math.max(parseInt(q.get('page'), 10) || 1, 1);
  const total = n((await first(env, `SELECT COUNT(*) AS c FROM community_posts ${W}`, ...args)).c);
  const rows = await all(env, `SELECT * FROM community_posts ${W} ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, ...args);
  return json({ ok: true, total, page, pages: Math.max(1, Math.ceil(total / size)), posts: rows.map((p) => adminShape(p, now)) });
}

async function getPost(env, id) {
  const p = await first(env, 'SELECT * FROM community_posts WHERE id = ?1', id);
  if (!p.id) return bad('글을 찾을 수 없습니다.', 404, 'not-found');
  const now = kstNow();
  const post = { ...shapePost(p, { detail: true, admin: true }), ...adminShape(p, now), body: p.body, info: parseJson(p.info, null), images: parseJson(p.images, []).map((x) => ({ id: x, url: imageUrl(x) })) };
  const member = p.member_id ? await first(env, `SELECT m.id, m.name, m.email, m.phone, m.status, m.created_at, cp.nickname, cp.banned FROM members m LEFT JOIN community_profiles cp ON cp.member_id = m.id WHERE m.id = ?1`, p.member_id) : null;
  const comments = (await all(env, 'SELECT * FROM community_comments WHERE post_id = ?1 ORDER BY id', id)).map(commentShape);
  const reports = await all(env, `SELECT r.*, cp.nickname FROM community_reports r LEFT JOIN community_profiles cp ON cp.member_id = r.member_id WHERE r.target_type = 'post' AND r.target_id = ?1 ORDER BY r.id DESC`, id);
  return json({ ok: true, post, member: member && member.id ? member : null, comments, reports: reports.map(reportShape) });
}
function commentShape(c) {
  return { id: c.id, postId: c.post_id, body: c.body, status: c.status, author: c.author_name, staff: c.author_kind === 'admin', memberId: c.member_id || null,
    reports: n(c.reports), hiddenReason: c.hidden_reason || '', createdAt: c.created_at, postTitle: c.post_title || '' };
}
function reportShape(r) {
  return { id: r.id, type: r.target_type, targetId: r.target_id, reason: r.reason, reasonName: REPORT_REASONS[r.reason] || r.reason, detail: r.detail || '',
    status: r.status, reporter: r.nickname || ('회원 #' + r.member_id), createdAt: r.created_at, resolvedAt: r.resolved_at || '' };
}

function readFlags(b, cur = {}) {
  const out = {};
  if (b.pinned !== undefined) out.pinned = b.pinned ? 1 : 0;
  if (b.featured !== undefined) out.featured = b.featured ? 1 : 0;
  if (b.adminMemo !== undefined) out.admin_memo = lines(b.adminMemo, 500) || null;
  if (b.status !== undefined) {
    const s = String(b.status);
    if (s === 'scheduled') {
      const at = kstStamp(b.publishAt);
      if (!at) return { error: '예약 발행 시각을 골라 주세요.' };
      out.status = 'published'; out.publish_at = at; out.hidden_reason = null;
    } else if (s === 'published') {
      out.status = 'published'; out.hidden_reason = null;
      if (cur.status !== 'published' || String(cur.publish_at || '') > kstNow()) out.publish_at = kstNow();
    } else if (s === 'hidden') {
      out.status = 'hidden'; out.hidden_reason = one(b.hiddenReason, 100) || '운영 원칙에 맞지 않아 숨겼습니다';
    } else if (s === 'draft') out.status = 'draft';
    else if (s === 'deleted') { out.status = 'deleted'; out.deleted_at = kstNow(); }
    else return { error: '상태를 확인해 주세요.' };
  }
  return { flags: out };
}

async function createPost(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const board = BOARDS[b.board] ? b.board : '';
  if (!board) return bad('게시판을 골라 주세요.');
  const { errors, value } = readPostInput(b, { board, admin: true });
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const fl = readFlags({ ...b, status: b.status || 'published' }, {});
  if (fl.error) return bad(fl.error);
  const f = fl.flags, author = one(b.authorName, 20) || '소셜팩토리';
  const row = await env.DB.prepare(`INSERT INTO community_posts (board, category, status, member_id, author_kind, author_name, title, summary, body, info, recruit, images, pinned, featured, admin_memo, publish_at)
    VALUES (?1, ?2, ?3, NULL, 'admin', ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, ?12, ?13) RETURNING id`).bind(
    board, value.category, f.status || 'published', author, value.title, value.summary, value.body, value.info ? JSON.stringify(value.info) : null, value.recruit,
    f.pinned || 0, f.featured || 0, f.admin_memo || null, f.publish_at || kstNow()).first();
  const images = await attachImages(env, row.id, value.images, { admin: true });
  await env.DB.prepare('UPDATE community_posts SET images = ?1 WHERE id = ?2').bind(JSON.stringify(images), row.id).run();
  return json({ ok: true, id: row.id, url: postUrl(row.id) });
}

async function updatePost(request, env, id) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const p = await first(env, 'SELECT * FROM community_posts WHERE id = ?1', id);
  if (!p.id) return bad('글을 찾을 수 없습니다.', 404, 'not-found');
  const sets = [], args = [];
  const set = (col, v) => { args.push(v); sets.push(`${col} = ?${args.length}`); };
  if (b.title !== undefined || b.body !== undefined) {
    const { errors, value } = readPostInput(b, { board: p.board, admin: true });
    if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
    set('category', value.category); set('title', value.title); set('summary', value.summary); set('body', value.body);
    set('info', value.info ? JSON.stringify(value.info) : null); set('recruit', value.recruit);
    const images = await attachImages(env, id, value.images, { admin: true });
    set('images', JSON.stringify(images));
    if (p.author_kind === 'admin' && b.authorName !== undefined) set('author_name', one(b.authorName, 20) || '소셜팩토리');
    sets.push(`updated_at = ${NOW_SQL}`);
  }
  const fl = readFlags(b, p);
  if (fl.error) return bad(fl.error);
  for (const [k, v] of Object.entries(fl.flags)) set(k, v);
  if (!sets.length) return bad('바꿀 내용이 없습니다.');
  args.push(id);
  await env.DB.prepare(`UPDATE community_posts SET ${sets.join(', ')} WHERE id = ?${args.length}`).bind(...args).run();
  if (fl.flags.status === 'hidden' || fl.flags.status === 'published') {
    // 숨기거나 다시 공개하면 이 글의 처리 전 신고는 정리합니다.
    await env.DB.prepare(`UPDATE community_reports SET status = ?2, resolved_at = ${NOW_SQL} WHERE target_type = 'post' AND target_id = ?1 AND status = 'open'`)
      .bind(id, fl.flags.status === 'hidden' ? 'resolved' : 'dismissed').run();
    await env.DB.prepare('UPDATE community_posts SET reports = 0 WHERE id = ?1').bind(id).run();
  }
  return getPost(env, id);
}

async function addComment(request, env, postId) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const p = await first(env, 'SELECT * FROM community_posts WHERE id = ?1', postId);
  if (!p.id) return bad('글을 찾을 수 없습니다.', 404, 'not-found');
  const body = lines(b.body, LIMITS.comment);
  if (!body) return bad('댓글 내용을 적어 주세요.');
  await env.DB.prepare(`INSERT INTO community_comments (post_id, member_id, author_kind, author_name, body) VALUES (?1, NULL, 'admin', ?2, ?3)`)
    .bind(postId, one(b.authorName, 20) || '소셜팩토리', body).run();
  await refreshCounts(env, postId);
  return getPost(env, postId);
}

async function listComments(env, q) {
  const where = [], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '?' + args.length)); };
  const st = q.get('status') || 'active';
  if (st === 'active') where.push("c.status <> 'deleted'"); else if (['published', 'hidden', 'deleted'].includes(st)) add('c.status = ?', st);
  if (q.get('reported') === '1') where.push('c.reports > 0');
  const text = one(q.get('q') || '', 40);
  if (text) { args.push('%' + likeEscape(text) + '%'); const k = '?' + args.length; where.push(`(c.body LIKE ${k} ESCAPE '\\' OR c.author_name LIKE ${k} ESCAPE '\\')`); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const size = 40, page = Math.max(parseInt(q.get('page'), 10) || 1, 1);
  const total = n((await first(env, `SELECT COUNT(*) AS c FROM community_comments c ${W}`, ...args)).c);
  const rows = await all(env, `SELECT c.*, p.title AS post_title FROM community_comments c LEFT JOIN community_posts p ON p.id = c.post_id ${W} ORDER BY c.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, ...args);
  return json({ ok: true, total, page, pages: Math.max(1, Math.ceil(total / size)), comments: rows.map(commentShape) });
}
async function updateComment(request, env, id) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const c = await first(env, 'SELECT * FROM community_comments WHERE id = ?1', id);
  if (!c.id) return bad('댓글을 찾을 수 없습니다.', 404, 'not-found');
  const status = ['published', 'hidden'].includes(b.status) ? b.status : '';
  if (!status) return bad('상태를 확인해 주세요.');
  await env.DB.prepare(`UPDATE community_comments SET status = ?1, hidden_reason = ?2, reports = 0, updated_at = ${NOW_SQL} WHERE id = ?3`)
    .bind(status, status === 'hidden' ? (one(b.hiddenReason, 100) || '운영 원칙에 맞지 않아 숨겼습니다') : null, id).run();
  await env.DB.prepare(`UPDATE community_reports SET status = ?2, resolved_at = ${NOW_SQL} WHERE target_type = 'comment' AND target_id = ?1 AND status = 'open'`)
    .bind(id, status === 'hidden' ? 'resolved' : 'dismissed').run();
  await refreshCounts(env, c.post_id);
  return json({ ok: true });
}
async function deleteComment(env, id) {
  const c = await first(env, 'SELECT * FROM community_comments WHERE id = ?1', id);
  if (!c.id) return bad('댓글을 찾을 수 없습니다.', 404, 'not-found');
  await env.DB.batch([
    env.DB.prepare("DELETE FROM community_reports WHERE target_type = 'comment' AND target_id = ?1").bind(id),
    env.DB.prepare('DELETE FROM community_comments WHERE id = ?1').bind(id)
  ]);
  await refreshCounts(env, c.post_id);
  return json({ ok: true });
}

async function listReports(env, q) {
  const st = ['open', 'resolved', 'dismissed'].includes(q.get('status')) ? q.get('status') : (q.get('status') === 'all' ? '' : 'open');
  const rows = await all(env, `SELECT r.*, cp.nickname FROM community_reports r LEFT JOIN community_profiles cp ON cp.member_id = r.member_id
    ${st ? 'WHERE r.status = ?1' : ''} ORDER BY r.id DESC LIMIT 300`, ...(st ? [st] : []));
  // 같은 글 · 댓글에 대한 신고를 하나로 묶습니다.
  const groups = new Map();
  for (const r of rows) {
    const key = r.target_type + ':' + r.target_id;
    if (!groups.has(key)) groups.set(key, { type: r.target_type, targetId: r.target_id, reports: [], latest: r.created_at });
    groups.get(key).reports.push(reportShape(r));
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.type === 'post') {
      const p = await first(env, 'SELECT * FROM community_posts WHERE id = ?1', g.targetId);
      g.target = p.id ? { id: p.id, title: p.title, board: p.board, boardName: BOARDS[p.board], status: statusOf(p), author: p.author_name, excerpt: shapePost(p).excerpt, url: postUrl(p.id) } : null;
    } else {
      const c = await first(env, 'SELECT c.*, p.title AS post_title FROM community_comments c LEFT JOIN community_posts p ON p.id = c.post_id WHERE c.id = ?1', g.targetId);
      g.target = c.id ? { id: c.id, postId: c.post_id, title: c.post_title || '', status: c.status, author: c.author_name, excerpt: c.body.slice(0, 160), url: postUrl(c.post_id) } : null;
    }
    out.push(g);
  }
  return json({ ok: true, groups: out });
}
async function resolveReports(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const type = b.type === 'comment' ? 'comment' : 'post', id = Number(b.id);
  if (!Number.isInteger(id) || id < 1) return bad('대상을 확인해 주세요.');
  const action = b.action === 'hide' ? 'hide' : 'dismiss';
  const table = type === 'post' ? 'community_posts' : 'community_comments';
  if (action === 'hide') {
    await env.DB.prepare(`UPDATE ${table} SET status = 'hidden', hidden_reason = ?2 WHERE id = ?1 AND status = 'published'`).bind(id, one(b.hiddenReason, 100) || '신고를 확인하고 숨겼습니다').run();
  }
  await env.DB.prepare(`UPDATE community_reports SET status = ?3, resolved_at = ${NOW_SQL} WHERE target_type = ?1 AND target_id = ?2 AND status = 'open'`)
    .bind(type, id, action === 'hide' ? 'resolved' : 'dismissed').run();
  await env.DB.prepare(`UPDATE ${table} SET reports = 0 WHERE id = ?1`).bind(id).run();
  if (type === 'comment') { const c = await first(env, 'SELECT post_id FROM community_comments WHERE id = ?1', id); if (c.post_id) await refreshCounts(env, c.post_id); }
  return json({ ok: true });
}

async function listMembers(env, q) {
  const args = [], where = [];
  const text = one(q.get('q') || '', 40);
  if (text) { args.push('%' + likeEscape(text) + '%'); where.push(`(cp.nickname LIKE ?1 ESCAPE '\\' OR m.name LIKE ?1 ESCAPE '\\' OR m.email LIKE ?1 ESCAPE '\\')`); }
  if (q.get('banned') === '1') where.push('cp.banned = 1');
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await all(env, `SELECT cp.*, m.name, m.email, m.phone,
      (SELECT COUNT(*) FROM community_posts p WHERE p.member_id = cp.member_id AND p.status <> 'deleted') AS posts,
      (SELECT COUNT(*) FROM community_comments c WHERE c.member_id = cp.member_id AND c.status <> 'deleted') AS comments,
      (SELECT COUNT(*) FROM community_reports r WHERE r.status <> 'dismissed' AND ((r.target_type = 'post' AND r.target_id IN (SELECT id FROM community_posts WHERE member_id = cp.member_id)) OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM community_comments WHERE member_id = cp.member_id)))) AS reported
    FROM community_profiles cp LEFT JOIN members m ON m.id = cp.member_id ${W} ORDER BY cp.created_at DESC LIMIT 200`, ...args);
  return json({ ok: true, members: rows.map((r) => ({ memberId: r.member_id, nickname: r.nickname, name: r.name || '(탈퇴한 회원)', email: r.email || '', phone: r.phone || '',
    banned: !!r.banned, banReason: r.ban_reason || '', posts: n(r.posts), comments: n(r.comments), reported: n(r.reported), createdAt: r.created_at })) });
}
async function updateMember(request, env, memberId) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const cur = await first(env, 'SELECT * FROM community_profiles WHERE member_id = ?1', memberId);
  if (!cur.member_id) return bad('커뮤니티 회원을 찾을 수 없습니다.', 404, 'not-found');
  if (b.nickname !== undefined && b.nickname !== cur.nickname) {
    const r = await saveNickname(env, memberId, b.nickname);
    if (r.error) return bad(r.error, 400, 'nickname');
    await env.DB.prepare("UPDATE community_posts SET author_name = ?1 WHERE member_id = ?2 AND author_kind = 'member'").bind(r.nickname, memberId).run();
    await env.DB.prepare("UPDATE community_comments SET author_name = ?1 WHERE member_id = ?2 AND author_kind = 'member'").bind(r.nickname, memberId).run();
  }
  if (b.banned !== undefined) {
    await env.DB.prepare(`UPDATE community_profiles SET banned = ?1, ban_reason = ?2, updated_at = ${NOW_SQL} WHERE member_id = ?3`)
      .bind(b.banned ? 1 : 0, b.banned ? (one(b.banReason, 100) || null) : null, memberId).run();
  }
  return json({ ok: true });
}

async function saveSettings(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const cur = await getSettings(env);
  const words = Array.isArray(b.bannedWords) ? b.bannedWords : String(b.bannedWords || '').split(/[,\n]/);
  const v = {
    groupsOpen: b.groupsOpen === undefined ? cur.groupsOpen : !!b.groupsOpen,
    freeOpen: b.freeOpen === undefined ? cur.freeOpen : !!b.freeOpen,
    commentsOpen: b.commentsOpen === undefined ? cur.commentsOpen : !!b.commentsOpen,
    notice: b.notice === undefined ? cur.notice : lines(b.notice, 300),
    bannedWords: b.bannedWords === undefined ? cur.bannedWords : [...new Set(words.map((w) => clean(String(w), 30)).filter(Boolean))].slice(0, 200),
    autoHide: b.autoHide === undefined ? cur.autoHide : Math.max(0, Math.min(20, parseInt(b.autoHide, 10) || 0))
  };
  await env.DB.prepare(`INSERT INTO community_settings (id, value, updated_at) VALUES (1, ?1, ${NOW_SQL}) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(v)).run();
  return json({ ok: true, settings: { ...DEFAULT_SETTINGS, ...v } });
}

export { isVisible };
