// Servidor local: API (lib/app.js) + arquivos de public/. Na Vercel, a API roda em api/index.js
// e os arquivos de public/ são servidos direto pela Vercel.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handler } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function estatico(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const arq = path.join(PUBLIC_DIR, rel);
  if (!arq.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Acesso negado');
  }
  fs.readFile(arq, (err, conteudo) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream' });
    res.end(conteudo);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handler(req, res);
    estatico(res, url);
  })
  .listen(PORT, () => console.log(`Escala rodando em http://localhost:${PORT}`));
