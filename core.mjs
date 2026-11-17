// Chatbit core. Works on standard Web Request/Response, so the same code runs in a
// Netlify Function and in the local dev server. Storage is injected (see stores below).
import crypto from 'node:crypto';

/* ---------- plans ----------
 * Netlify Functions accept request bodies up to 6 MB, and binary bodies are sent base64-encoded,
 * so one upload can safely be about 4 MB. Plans differ by item count, total storage and protection. */
const MB = 1024 * 1024;
export const PLANS = {
  free:    { label: 'Free',    maxFiles: 10,  maxBytes: 25 * MB,   maxFileBytes: 4 * MB, protect: false },
  premium: { label: 'Premium', maxFiles: 500, maxBytes: 1024 * MB, maxFileBytes: 4 * MB, protect: true  },
};
const DEMO_BILLING = (typeof process !== 'undefined' ? process.env.DEMO_BILLING : '1') !== '0';
const COOKIE_SECURE = typeof process !== 'undefined' && process.env.COOKIE_SECURE === '1';

/*
 * stores = { users, sessions, spaces, files }, each with:
 *   getJSON(key) -> object | null      setJSON(key, value, { onlyIfNew }) -> { modified } | any
 *   getBuf(key) -> ArrayBuffer | null   setBuf(key, ArrayBuffer)           del(key)
 */

/* ---------- helpers ---------- */
const enc = new TextEncoder();
const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;
const RESERVED = new Set(['admin', 'api', 'chatbit', 'www', 'help', 'login', 'logout', 'register', 'pricing', 'support', 'about', 'app', 'static', 'assets', 'public', 'root']);
const FILE_ID = '([a-z0-9_-]{3,20}~[a-f0-9]{12})';
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm)|application\/pdf|text\/plain)$/;
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

function json(status, obj, extra) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (extra) for (const [k, v] of extra) h.append(k, v);
  return new Response(JSON.stringify(obj), { status, headers: h });
}
const fail = (status, msg) => json(status, { error: msg });

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  if (!stored) return false;
  const [s, h] = stored.split(':');
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let secretCache = null;
async function getSecret(S) {
  if (secretCache) return secretCache;
  if (process.env.CHATBIT_SECRET) return (secretCache = Buffer.from(process.env.CHATBIT_SECRET));
  let rec = await S.sessions.getJSON('!secret');
  if (!rec) {
    await S.sessions.setJSON('!secret', { key: hex(32) }, { onlyIfNew: true });
    rec = await S.sessions.getJSON('!secret');
  }
  return (secretCache = Buffer.from(rec.key, 'hex'));
}
async function signToken(S, scope, ttl = 3600e3) {
  const body = Buffer.from(JSON.stringify({ s: scope, e: Date.now() + ttl })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', await getSecret(S)).update(body).digest('base64url');
}
async function verifyToken(S, tok, scope) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return false;
  const [body, sig] = tok.split('.');
  const good = crypto.createHmac('sha256', await getSecret(S)).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.s === scope && p.e > Date.now(); } catch { return false; }
}

const hits = new Map(); // best-effort, per function instance
function limited(req, key, max = 20, windowMs = 10 * 60e3) {
  const ip = req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
  const k = key + ':' + ip, now = Date.now(), h = hits.get(k);
  if (hits.size > 5000) hits.clear();
  if (!h || h.reset < now) { hits.set(k, { n: 1, reset: now + windowMs }); return false; }
  return ++h.n > max;
}
function cookieOf(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
async function readJson(req) {
  const text = await req.text();
  if (text.length > 64 * 1024) throw Object.assign(new Error('too large'), { code: 413 });
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('bad json'), { code: 400 }); }
}
function kindOf(name, mime) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (ext === 'apk') return 'apk';
  if (['txt', 'md', 'csv', 'log', 'json'].includes(ext)) return 'text';
  if (['doc', 'docx', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'rtf'].includes(ext)) return 'document';
  return 'file';
}
function cleanName(n) {
  n = String(n || '').replace(/\\/g, '/').split('/').pop().replace(/[\x00-\x1f<>:"|?*]/g, '').trim().slice(0, 120);
  return n || 'untitled';
}

/* ---------- data access ---------- */
const loadSpace = async (S, username) => (await S.spaces.getJSON(username)) || { files: [] };
const saveSpace = (S, username, sp) => S.spaces.setJSON(username, sp);
const usageOf = (sp) => ({ files: sp.files.length, bytes: sp.files.reduce((a, f) => a + f.size, 0) });
const fileView = (f, owner) => ({
  id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind, visibility: f.visibility, createdAt: f.createdAt,
  isNote: f.note != null,
  text: f.note != null && (owner || f.visibility === 'public') ? f.note : undefined,
  locked: !owner && f.visibility === 'password',
});

async function currentUser(req, S) {
  const t = cookieOf(req, 'cb_session');
  if (!t) return null;
  const sess = await S.sessions.getJSON(sha(t));
  if (!sess) return null;
  if (sess.expires < Date.now()) { await S.sessions.del(sha(t)); return null; }
  return S.users.getJSON(sess.username);
}
async function startSession(S, username) {
  const token = crypto.randomBytes(32).toString('base64url'), days = 30;
  await S.sessions.setJSON(sha(token), { username, expires: Date.now() + days * 864e5 });
  return ['Set-Cookie', `cb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${COOKIE_SECURE ? '; Secure' : ''}`];
}

/* ---------- request handler ---------- */
export async function handle(req, S) {
  try { return await route(req, S); }
  catch (e) {
    if (e && e.code === 413) return fail(413, 'Request too large.');
    if (e && e.code === 400) return fail(400, 'Invalid request.');
    console.error(e);
    return fail(500, 'Something went wrong.');
  }
}

async function route(req, S) {
  const url = new URL(req.url);
  let p = url.pathname.replace(/^\/\.netlify\/functions\/api/, '');
  if (!p.startsWith('/api')) p = '/api' + p;
  p = p.replace(/\/+$/, '') || '/api';
  const m = req.method;
  const me = await currentUser(req, S);

  if (m !== 'GET' && m !== 'HEAD' && req.headers.get('x-chatbit') !== '1') return fail(403, 'Missing request header.');

  if (p === '/api/me' && m === 'GET') return json(200, { user: me && { username: me.username, plan: me.plan }, plans: PLANS, demoBilling: DEMO_BILLING });

  let mm;
  if ((mm = p.match(/^\/api\/check\/([^/]+)$/)) && m === 'GET') {
    const u = decodeURIComponent(mm[1]).toLowerCase();
    if (!USERNAME_RE.test(u)) return json(200, { available: false, reason: 'Use 3 to 20 letters, numbers, _ or -.' });
    if (RESERVED.has(u) || (await S.users.getJSON(u))) return json(200, { available: false, reason: 'That address is taken.' });
    return json(200, { available: true });
  }

  if (p === '/api/register' && m === 'POST') {
    if (limited(req, 'auth')) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const b = await readJson(req);
    const username = String(b.username || '').toLowerCase();
    if (!USERNAME_RE.test(username)) return fail(400, 'Use 3 to 20 letters, numbers, _ or - for the address.');
    if (RESERVED.has(username)) return fail(409, 'That address is taken.');
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) return fail(400, 'Password must be at least 8 characters.');
    const r = await S.users.setJSON(username, { username, pass: hashPw(b.password), plan: 'free', spacePass: null, createdAt: Date.now() }, { onlyIfNew: true });
    if (r && r.modified === false) return fail(409, 'That address is taken.');
    return json(201, { user: { username, plan: 'free' } }, [await startSession(S, username)]);
  }
  if (p === '/api/login' && m === 'POST') {
    if (limited(req, 'auth')) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const b = await readJson(req);
    const uname = String(b.username || '').toLowerCase();
    const u = USERNAME_RE.test(uname) ? await S.users.getJSON(uname) : null;
    if (!u || typeof b.password !== 'string' || !checkPw(b.password, u.pass)) return fail(401, 'Wrong address or password.');
    return json(200, { user: { username: u.username, plan: u.plan } }, [await startSession(S, u.username)]);
  }
  if (p === '/api/logout' && m === 'POST') {
    const t = cookieOf(req, 'cb_session'); if (t) await S.sessions.del(sha(t));
    return json(200, { ok: true }, [['Set-Cookie', 'cb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']]);
  }

  if (p === '/api/plan' && m === 'POST') {
    if (!me) return fail(401, 'Sign in first.');
    if (!DEMO_BILLING) return fail(501, 'Billing is not configured on this server.');
    const b = await readJson(req);
    if (!PLANS[b.plan]) return fail(400, 'Unknown plan.');
    me.plan = b.plan; await S.users.setJSON(me.username, me);
    return json(200, { user: { username: me.username, plan: me.plan } });
  }
  if (p === '/api/space-password' && m === 'POST') {
    if (!me) return fail(401, 'Sign in first.');
    const b = await readJson(req);
    if (b.password == null || b.password === '') { me.spacePass = null; await S.users.setJSON(me.username, me); return json(200, { protected: false }); }
    if (!PLANS[me.plan].protect) return fail(402, 'Password protection is a Premium feature.');
    if (typeof b.password !== 'string' || b.password.length < 4 || b.password.length > 200) return fail(400, 'Use at least 4 characters.');
    me.spacePass = hashPw(b.password); await S.users.setJSON(me.username, me);
    return json(200, { protected: true });
  }

  if ((mm = p.match(/^\/api\/space\/([^/]+)$/)) && m === 'GET') {
    const uname = decodeURIComponent(mm[1]).toLowerCase();
    const owner = USERNAME_RE.test(uname) ? await S.users.getJSON(uname) : null;
    if (!owner) return fail(404, 'No one has claimed this address yet.');
    const isOwner = !!me && me.username === owner.username;
    const base = { username: owner.username, plan: owner.plan, protected: !!owner.spacePass, owner: isOwner };
    if (!isOwner && owner.spacePass && !(await verifyToken(S, url.searchParams.get('s'), 'space:' + owner.username))) return json(200, { ...base, locked: true, files: [] });
    const sp = await loadSpace(S, owner.username);
    const files = (isOwner ? sp.files : sp.files.filter((f) => f.visibility !== 'private')).slice().sort((a, b) => b.createdAt - a.createdAt);
    const out = { ...base, locked: false, files: files.map((f) => fileView(f, isOwner)) };
    if (isOwner) out.usage = { ...usageOf(sp), limits: PLANS[owner.plan] };
    return json(200, out);
  }
  if ((mm = p.match(/^\/api\/space\/([^/]+)\/unlock$/)) && m === 'POST') {
    if (limited(req, 'unlock', 15)) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const uname = decodeURIComponent(mm[1]).toLowerCase();
    const owner = USERNAME_RE.test(uname) ? await S.users.getJSON(uname) : null;
    const b = await readJson(req);
    if (!owner || !owner.spacePass || typeof b.password !== 'string' || !checkPw(b.password, owner.spacePass)) return fail(401, 'Wrong password.');
    return json(200, { token: await signToken(S, 'space:' + owner.username) });
  }

  if (p === '/api/notes' && m === 'POST') {
    if (!me) return fail(401, 'Sign in first.');
    const b = await readJson(req);
    const text = String(b.text || '').trim();
    if (!text) return fail(400, 'Write something to save.');
    if (text.length > 20000) return fail(400, 'Notes can be up to 20,000 characters.');
    const size = enc.encode(text).length, plan = PLANS[me.plan], sp = await loadSpace(S, me.username), u = usageOf(sp);
    if (u.files >= plan.maxFiles) return fail(402, `The ${plan.label} plan holds ${plan.maxFiles} items. Upgrade for more.`);
    if (u.bytes + size > plan.maxBytes) return fail(402, 'Storage is full on this plan.');
    const n = sp.files.filter((f) => f.note != null).length + 1;
    const f = { id: me.username + '~' + hex(6), name: `note-${n}.txt`, size, mime: 'text/plain', kind: 'text', visibility: 'public', pass: null, note: text, createdAt: Date.now() };
    sp.files.push(f); await saveSpace(S, me.username, sp);
    return json(201, { file: fileView(f, true) });
  }

  if (p === '/api/files' && m === 'PUT') return upload(req, S, me, url);

  if ((mm = p.match(new RegExp('^/api/files/' + FILE_ID + '$')))) {
    const id = mm[1], uname = id.split('~')[0];
    const sp = await loadSpace(S, uname), f = sp.files.find((x) => x.id === id);
    if (!f) return fail(404, 'File not found.');
    if (!me || me.username !== uname) return fail(403, 'Only the owner can change this.');
    if (m === 'DELETE') {
      sp.files = sp.files.filter((x) => x.id !== id); await saveSpace(S, uname, sp);
      if (f.note == null) await S.files.del(id);
      return json(200, { ok: true });
    }
    if (m === 'PATCH') {
      const b = await readJson(req), vis = b.visibility;
      if (!['public', 'password', 'private'].includes(vis)) return fail(400, 'Choose public, password or private.');
      if (vis !== 'public' && !PLANS[me.plan].protect) return fail(402, 'Password and private access are Premium features.');
      if (vis === 'password') {
        if (b.password) { if (String(b.password).length < 4) return fail(400, 'Use at least 4 characters.'); f.pass = hashPw(String(b.password)); }
        else if (!f.pass) return fail(400, 'Set a password for this file.');
      } else f.pass = null;
      f.visibility = vis; await saveSpace(S, uname, sp);
      return json(200, { file: fileView(f, true) });
    }
  }
  if ((mm = p.match(new RegExp('^/api/files/' + FILE_ID + '/unlock$'))) && m === 'POST') {
    if (limited(req, 'unlock', 15)) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const id = mm[1], sp = await loadSpace(S, id.split('~')[0]), f = sp.files.find((x) => x.id === id);
    const b = await readJson(req);
    if (!f || f.visibility !== 'password' || typeof b.password !== 'string' || !checkPw(b.password, f.pass)) return fail(401, 'Wrong password.');
    return json(200, { token: await signToken(S, 'file:' + f.id), text: f.note != null ? f.note : undefined });
  }
  if ((mm = p.match(new RegExp('^/api/files/' + FILE_ID + '/download$'))) && (m === 'GET' || m === 'HEAD')) return download(req, S, me, url, mm[1]);

  return fail(404, 'Not found.');
}

async function upload(req, S, me, url) {
  if (!me) return fail(401, 'Sign in first.');
  const plan = PLANS[me.plan];
  const name = cleanName(url.searchParams.get('name'));
  const mime = String(req.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
  const declared = Number(req.headers.get('content-length') || 0);
  const tooBig = `Files can be up to ${Math.round(plan.maxFileBytes / MB)} MB.`;
  if (declared > plan.maxFileBytes) return fail(413, tooBig);
  const sp = await loadSpace(S, me.username), u = usageOf(sp);
  if (u.files >= plan.maxFiles) return fail(402, `The ${plan.label} plan holds ${plan.maxFiles} items. Upgrade for more.`);
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return fail(400, 'That file is empty.');
  if (buf.byteLength > plan.maxFileBytes) return fail(413, tooBig);
  if (u.bytes + buf.byteLength > plan.maxBytes) return fail(402, 'Storage is full on this plan.');
  const id = me.username + '~' + hex(6);
  await S.files.setBuf(id, buf);
  const f = { id, name, size: buf.byteLength, mime, kind: kindOf(name, mime), visibility: 'public', pass: null, note: null, createdAt: Date.now() };
  sp.files.push(f); await saveSpace(S, me.username, sp);
  return json(201, { file: fileView(f, true) });
}

async function download(req, S, me, url, id) {
  const uname = id.split('~')[0];
  const owner = await S.users.getJSON(uname);
  const sp = owner && (await loadSpace(S, uname)), f = sp && sp.files.find((x) => x.id === id);
  if (!f) return fail(404, 'File not found.');
  const isOwner = !!me && me.username === uname;
  if (!isOwner) {
    if (f.visibility === 'private') return fail(404, 'File not found.');
    if (owner.spacePass && !(await verifyToken(S, url.searchParams.get('s'), 'space:' + uname))) return fail(401, 'This space is password protected.');
    if (f.visibility === 'password' && !(await verifyToken(S, url.searchParams.get('t'), 'file:' + f.id))) return fail(401, 'This file is password protected.');
  }
  const inline = url.searchParams.get('inline') === '1' && INLINE_OK.test(f.mime);
  const headers = new Headers({
    'Content-Type': inline ? f.mime : f.note != null ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()]/g, escape)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  });
  let bytes;
  if (f.note != null) bytes = new Uint8Array(enc.encode(f.note));
  else {
    const buf = await S.files.getBuf(id);
    if (!buf) return fail(404, 'File data is missing.');
    bytes = new Uint8Array(buf);
  }
  let start = 0, end = bytes.length - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); } else start = Math.max(0, bytes.length - Number(range[2]));
    if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
    status = 206; headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
  }
  const slice = bytes.subarray(start, end + 1);
  headers.set('Content-Length', String(slice.length));
  return new Response(req.method === 'HEAD' ? null : slice, { status, headers });
}
