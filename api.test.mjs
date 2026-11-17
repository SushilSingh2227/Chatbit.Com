'use strict';
// End-to-end test: starts the real server on a temp data dir and drives it over HTTP.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createServer } from '../dev-server.mjs';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbit-test-'));
const server = createServer(DATA_DIR);

const H = { 'X-Chatbit': '1' };
let base, passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, { json, body, headers = {} } = {}) {
    const h = { ...H, ...headers, ...(this.cookie ? { Cookie: this.cookie } : {}) };
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(base + url, { method, headers: h, body });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  }
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const riya = new Client(), guest = new Client();

  // pages
  let r = await guest.call('GET', '/'); assert.equal(r.status, 200); assert.match(r.data.toString(), /<title>Chatbit/); ok('landing page served');
  r = await guest.call('GET', '/riya'); assert.equal(r.status, 200); assert.match(r.data.toString(), /id="app"/); ok('/username serves the app shell');
  r = await guest.call('GET', '/app.js'); assert.equal(r.status, 200); ok('static assets served');
  r = await guest.call('GET', '/../server.js'); assert.notEqual(r.data.toString().includes('createServer'), true); ok('path traversal blocked');

  // username availability and registration
  r = await guest.call('GET', '/api/check/riya'); assert.equal(r.data.available, true); ok('free username is available');
  r = await guest.call('GET', '/api/check/admin'); assert.equal(r.data.available, false); ok('reserved username rejected');
  r = await guest.call('GET', '/api/check/ab'); assert.equal(r.data.available, false); ok('too-short username rejected');
  r = await riya.call('POST', '/api/register', { json: { username: 'Riya', password: 'short' } }); assert.equal(r.status, 400); ok('short password rejected');
  r = await riya.call('POST', '/api/register', { json: { username: 'Riya', password: 'lab-report-1' } }); assert.equal(r.status, 201); assert.equal(r.data.user.username, 'riya'); ok('register creates account and session');
  r = await guest.call('POST', '/api/register', { json: { username: 'riya', password: 'another-pass' } }); assert.equal(r.status, 409); ok('duplicate username rejected');
  r = await guest.call('GET', '/api/check/riya'); assert.equal(r.data.available, false); ok('claimed username no longer available');
  r = await guest.call('POST', '/api/register', { json: { username: 'sneaky', password: 'long-enough-pw' }, headers: { 'X-Chatbit': '' } }); assert.equal(r.status, 403); ok('requests without the CSRF header are refused');

  // login / logout
  const again = new Client();
  r = await again.call('POST', '/api/login', { json: { username: 'riya', password: 'wrong-password' } }); assert.equal(r.status, 401); ok('wrong password rejected');
  r = await again.call('POST', '/api/login', { json: { username: 'riya', password: 'lab-report-1' } }); assert.equal(r.status, 200); ok('login works');
  r = await again.call('GET', '/api/me'); assert.equal(r.data.user.username, 'riya'); ok('session identifies the user');

  // upload (raw body) and download
  const content = Buffer.from('DBMS lab record: BCNF notes\n'.repeat(50));
  r = await riya.call('PUT', '/api/files?name=' + encodeURIComponent('lab record.txt'), { body: content, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 201); assert.equal(r.data.file.size, content.length); const fid = r.data.file.id; ok('owner uploads a file');
  r = await guest.call('PUT', '/api/files?name=x.txt', { body: content }); assert.equal(r.status, 401); ok('guest cannot upload');
  r = await guest.call('GET', '/api/files/' + fid + '/download'); assert.equal(r.status, 200); assert.ok(r.data.equals(content)); ok('public file downloads on another device');
  assert.match(r.headers.get('content-disposition'), /attachment/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); ok('downloads are served as attachments with nosniff');
  r = await guest.call('GET', '/api/files/' + fid + '/download', { headers: { Range: 'bytes=0-9' } }); assert.equal(r.status, 206); assert.equal(r.data.length, 10); ok('range requests work');

  // html upload must not be rendered inline
  r = await riya.call('PUT', '/api/files?name=evil.html', { body: Buffer.from('<script>alert(1)</script>'), headers: { 'Content-Type': 'text/html' } }); const hid = r.data.file.id;
  r = await guest.call('GET', '/api/files/' + hid + '/download?inline=1'); assert.match(r.headers.get('content-disposition'), /attachment/); ok('uploaded HTML is never served inline');

  // notes
  r = await riya.call('POST', '/api/notes', { json: { text: 'Viva on Monday, room 204' } }); assert.equal(r.status, 201); const nid = r.data.file.id; ok('owner saves a text note');
  r = await guest.call('GET', '/api/space/riya'); assert.equal(r.status, 200); assert.equal(r.data.files.length, 3);
  assert.ok(r.data.files.some((f) => f.text === 'Viva on Monday, room 204')); ok('visitor sees public files and notes at /riya');
  r = await guest.call('GET', '/api/space/nobody'); assert.equal(r.status, 404); ok('unclaimed space is 404');

  // free plan blocks protection features
  r = await riya.call('PATCH', '/api/files/' + fid, { json: { visibility: 'private' } }); assert.equal(r.status, 402); ok('free plan cannot make files private');
  r = await riya.call('POST', '/api/space-password', { json: { password: 'secret1' } }); assert.equal(r.status, 402); ok('free plan cannot password-protect the space');

  // upgrade then permissions
  r = await riya.call('POST', '/api/plan', { json: { plan: 'premium' } }); assert.equal(r.data.user.plan, 'premium'); ok('plan switches to premium');
  r = await riya.call('PATCH', '/api/files/' + fid, { json: { visibility: 'private' } }); assert.equal(r.status, 200); ok('premium can make a file private');
  r = await guest.call('GET', '/api/files/' + fid + '/download'); assert.equal(r.status, 404); ok('private file is hidden from visitors');
  r = await guest.call('GET', '/api/space/riya'); assert.ok(!r.data.files.some((f) => f.id === fid)); ok('private file is not listed for visitors');
  r = await riya.call('GET', '/api/files/' + fid + '/download'); assert.equal(r.status, 200); ok('owner can still open a private file');

  r = await riya.call('PATCH', '/api/files/' + fid, { json: { visibility: 'password' } }); assert.equal(r.status, 400); ok('password visibility requires a password');
  r = await riya.call('PATCH', '/api/files/' + fid, { json: { visibility: 'password', password: 'viva2026' } }); assert.equal(r.status, 200); ok('premium sets a file password');
  r = await guest.call('GET', '/api/files/' + fid + '/download'); assert.equal(r.status, 401); ok('locked file refuses a visitor');
  r = await guest.call('POST', '/api/files/' + fid + '/unlock', { json: { password: 'nope' } }); assert.equal(r.status, 401); ok('wrong file password rejected');
  r = await guest.call('POST', '/api/files/' + fid + '/unlock', { json: { password: 'viva2026' } }); assert.equal(r.status, 200); const tok = r.data.token;
  r = await guest.call('GET', '/api/files/' + fid + '/download?t=' + encodeURIComponent(tok)); assert.equal(r.status, 200); assert.ok(r.data.equals(content)); ok('right password unlocks the download');
  r = await guest.call('GET', '/api/files/' + nid + '/download?t=' + encodeURIComponent(tok)); assert.equal(r.status, 200); ok('public note unaffected by another file lock');
  const forged = tok.split('.')[0] + '.AAAA'; r = await guest.call('GET', '/api/files/' + fid + '/download?t=' + forged); assert.equal(r.status, 401); ok('forged unlock token rejected');

  // whole-space password
  r = await riya.call('POST', '/api/space-password', { json: { password: 'campus-door' } }); assert.equal(r.status, 200); ok('premium protects the whole space');
  r = await guest.call('GET', '/api/space/riya'); assert.equal(r.data.locked, true); assert.equal(r.data.files.length, 0); ok('visitor sees only a lock screen');
  r = await guest.call('GET', '/api/files/' + nid + '/download'); assert.equal(r.status, 401); ok('files inside a locked space cannot be fetched directly');
  r = await guest.call('POST', '/api/space/riya/unlock', { json: { password: 'campus-door' } }); const stok = r.data.token; assert.equal(r.status, 200);
  r = await guest.call('GET', '/api/space/riya?s=' + encodeURIComponent(stok)); assert.equal(r.data.locked, false); assert.ok(r.data.files.length >= 2); ok('space password opens the space');
  r = await riya.call('GET', '/api/space/riya'); assert.equal(r.data.owner, true); assert.equal(r.data.files.length, 3); ok('owner never needs the password');

  // another user cannot touch riya's files
  const aman = new Client(); await aman.call('POST', '/api/register', { json: { username: 'aman', password: 'aman-pass-1' } });
  r = await aman.call('DELETE', '/api/files/' + fid); assert.equal(r.status, 403); ok("another user cannot delete someone's file");
  r = await aman.call('PATCH', '/api/files/' + fid, { json: { visibility: 'public' } }); assert.equal(r.status, 403); ok("another user cannot change someone's permissions");

  // free-plan limits
  const small = new Client(); await small.call('POST', '/api/register', { json: { username: 'smallfry', password: 'smallfry-pw' } });
  r = await small.call('PUT', '/api/files?name=big.bin', { body: Buffer.alloc(5 * 1024 * 1024, 1), headers: { 'Content-Type': 'application/octet-stream' } }); assert.equal(r.status, 413); ok('free plan rejects a file over the per-file limit');
  for (let i = 0; i < 10; i++) { r = await small.call('PUT', '/api/files?name=f' + i + '.txt', { body: Buffer.from('hello ' + i) }); assert.equal(r.status, 201); }
  r = await small.call('PUT', '/api/files?name=eleventh.txt', { body: Buffer.from('one too many') }); assert.equal(r.status, 402); ok('free plan stops at its item limit');
  const leftover = fs.readdirSync(path.join(DATA_DIR, 'files')).length;
  r = await small.call('GET', '/api/space/smallfry'); assert.equal(r.data.usage.files, 10); assert.equal(leftover, 12); // 2 from riya (notes live in the DB) + 10 accepted from smallfry ok('rejected uploads leave no stray files on disk');

  // delete removes the stored file
  r = await riya.call('DELETE', '/api/files/' + fid); assert.equal(r.status, 200); await new Promise((x) => setTimeout(x, 100));
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'files', fid)), false); ok('delete removes the file from disk');

  // logout
  r = await riya.call('POST', '/api/logout'); r = await riya.call('GET', '/api/me'); riya.cookie = ''; r = await riya.call('GET', '/api/me'); assert.equal(r.data.user, null); ok('logout ends the session');

  console.log(`\n${passed} checks passed`);
  server.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
