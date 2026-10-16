// 수집 서버: 에이전트 데이터를 받고, 대시보드에 SSE로 밀어 주고, 대시보드 파일을 제공한다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store');

const DASH = path.join(__dirname, '..', 'dashboard');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const MAX_BODY = 1024 * 1024;
const BACKLOG_MS = 5 * 60 * 1000; // 새로 연결한 화면에 보내는 과거 점
const STATS_LAG_MS = 2000;        // 에이전트가 1초마다 묶어 보내므로 2초 전의 1초를 '마감된 1초'로 본다

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const sse = (msg) => `data: ${JSON.stringify(msg)}\n\n`;
const statSec = (now) => Math.floor((now - STATS_LAG_MS) / 1000) * 1000;

function createCollector(store = createStore()) {
  const clients = new Set();
  let pending = []; // 다음 틱에 보낼 새 점

  function ingest(req, res) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c); // 넘치면 읽기만 하고 버린다
    });
    req.on('end', () => {
      if (size > MAX_BODY) return send(res, 400, 'too large');
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, 'bad json');
      }
      if (body === null || typeof body !== 'object') return send(res, 400, 'bad json');
      pending.push(...store.ingest(body.agent, body.txs, body.active));
      send(res, 204);
    });
  }

  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const now = Date.now();
    // 아직 틱으로 안 나간 점(pending)은 다음 틱에 오므로 과거 점에서 뺀다
    const queued = new Set(pending.map((p) => p.id));
    const backlog = store.points(now - BACKLOG_MS).filter((p) => !queued.has(p.id));
    res.write(sse({ points: backlog, stats: store.stats(statSec(now)), active: store.active(now) }));
    clients.add(res);
    res.on('close', () => clients.delete(res)); // req의 close는 요청 본문이 끝나면 바로 오므로 res로 본다
  }

  function serveFile(pathname, res) {
    const file = path.join(DASH, pathname === '/' ? 'index.html' : pathname);
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(DASH + path.sep) || !type) return send(res, 404, 'not found');
    fs.readFile(file, (err, data) => (err ? send(res, 404, 'not found') : send(res, 200, data, type)));
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://x'));
    } catch {
      return send(res, 400, 'bad url'); // 예: GET //
    }
    if (req.method === 'POST' && pathname === '/ingest') return ingest(req, res);
    if (req.method !== 'GET') return send(res, 404, 'not found');
    if (pathname === '/stream') return stream(req, res);
    if (pathname.startsWith('/tx/')) {
      const tx = store.get(pathname.slice(4));
      return tx ? json(res, 200, tx) : send(res, 404, 'not found');
    }
    serveFile(pathname, res);
  });

  const timer = setInterval(() => {
    const now = Date.now();
    store.prune(now);
    const msg = sse({ points: pending, stats: store.stats(statSec(now)), active: store.active(now) });
    pending = [];
    for (const res of clients) res.write(msg);
  }, 1000);
  timer.unref();

  return {
    server,
    close() {
      clearInterval(timer);
      for (const res of clients) res.end();
      server.closeAllConnections();
      server.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 7700;
  // 대시보드에 SQL 바인드 값(실제 데이터)이 보이므로 이 PC에서만 접속을 받는다.
  createCollector().server.listen(port, '127.0.0.1', () => console.log(`수집 서버: http://localhost:${port}`));
}

module.exports = { createCollector };
