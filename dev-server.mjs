// Local development server. Runs the exact same core as the Netlify Function,
// with data kept in plain files under ./data. Needs only Node 18 or newer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Folder-backed store with the same interface as the Netlify Blobs adapter.
function folderStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (k) => path.join(dir, encodeURIComponent(k));
  return {
    getJSON: async (k) => { try { return JSON.parse(fs.readFileSync(f(k), 'utf8')); } catch { return null; } },
    setJSON: async (k, v, o) => {
      try { fs.writeFileSync(f(k), JSON.stringify(v), { flag: o && o.onlyIfNew ? 'wx' : 'w' }); return { modified: true }; }
      catch (e) { if (e.code === 'EEXIST') return { modified: false }; throw e; }
    },
    getBuf: async (k) => { try { const b = fs.readFileSync(f(k)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch { return null; } },
    setBuf: async (k, buf) => { fs.writeFileSync(f(k), Buffer.from(buf)); },
    del: async (k) => { fs.rmSync(f(k), { force: true }); },
  };
}

export function createServer(dataDir) {
  const S = ['users', 'sessions', 'spaces', 'files'].reduce((o, n) => ({ ...o, [n]: folderStore(path.join(dataDir, n)) }), {});
  return http.createServer(async (nreq, nres) => {
    try {
      const url = new URL(nreq.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let n = 0;
        for await (const c of nreq) { n += c.length; if (n > 7 * 1024 * 1024) { nres.writeHead(413); return nres.end(); } chunks.push(c); }
        const hasBody = !['GET', 'HEAD'].includes(nreq.method);
        const req = new Request(url, { method: nreq.method, headers: nreq.headers, body: hasBody ? Buffer.concat(chunks) : undefined });
        const res = await handle(req, S);
        const headers = {}; res.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
        const sc = res.headers.getSetCookie(); if (sc.length) headers['set-cookie'] = sc;
        nres.writeHead(res.status, headers);
        return nres.end(Buffer.from(await res.arrayBuffer()));
      }
      // static files, with /username falling back to the app shell
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      let file = path.join(PUBLIC, path.normalize(rel));
      const ok = file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
      if (!ok) { if (path.extname(rel)) { nres.writeHead(404); return nres.end('Not found'); } file = path.join(PUBLIC, 'index.html'); }
      nres.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      nres.end(fs.readFileSync(file));
    } catch (e) { console.error(e); if (!nres.headersSent) nres.writeHead(500); nres.end('Server error'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer(path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))).listen(port, () => console.log(`Chatbit running at http://localhost:${port}`));
}
