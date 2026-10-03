// IRC TV Player – serveur + proxy (Node 18+, aucune dépendance)
const http = require('http'), fs = require('fs'), path = require('path');
const dns = require('dns').promises, net = require('net');
const { Readable } = require('stream');
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Bloque les adresses privées (protection contre l'accès au réseau interne)
function isPrivate(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
async function safe(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  const addrs = await dns.lookup(u.hostname, { all: true });
  return addrs.length > 0 && !addrs.some(a => isPrivate(a.address));
}

async function proxy(req, res, reqUrl) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  let target;
  try { target = new URL(reqUrl.searchParams.get('url')); } catch { res.writeHead(400, cors); return res.end('URL invalide'); }
  try {
    if (!(await safe(target))) { res.writeHead(403, cors); return res.end('Adresse refusée'); }
    const headers = { 'User-Agent': 'Mozilla/5.0 IRC-TV-Player' };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const ct = up.headers.get('content-type') || '';
    const looksText = /mpegurl|text|octet-stream/i.test(ct) || /\.(m3u8?|txt)(\?|$)/i.test(target.pathname);
    if (looksText && !/video|audio/i.test(ct)) {
      const body = await up.text();
      let out = body;
      if (body.includes('#EXT-X-')) { // manifeste HLS : on fait passer segments et clés par le proxy
        const base = up.url || target.href;
        const wrap = u => '/proxy?url=' + encodeURIComponent(new URL(u, base).href);
        out = body.split(/\r?\n/).map(l => {
          if (!l.trim()) return l;
          if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + wrap(u) + '"');
          return wrap(l.trim());
        }).join('\n');
      }
      res.writeHead(up.status, { ...cors, 'Content-Type': ct || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out);
    }
    const h = { ...cors, 'Content-Type': ct || 'application/octet-stream' };
    for (const k of ['content-length', 'content-range', 'accept-ranges']) if (up.headers.get(k)) h[k] = up.headers.get(k);
    res.writeHead(up.status, h);
    const stream = Readable.fromWeb(up.body);
    req.on('close', () => stream.destroy());
    stream.on('error', () => res.end());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, cors);
    res.end('Flux injoignable');
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/proxy/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (u.pathname === '/proxy') return proxy(req, res, u);
  if (u.pathname !== '/' && u.pathname !== '/index.html') { res.writeHead(404); return res.end('Introuvable'); }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html manquant'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, () => console.log('IRC TV Player : http://localhost:' + PORT));
