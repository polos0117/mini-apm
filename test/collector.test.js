const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollector } = require('../collector/server');

async function start(t) {
  const c = createCollector();
  await new Promise((r) => c.server.listen(0, r));
  t.after(() => c.close());
  return `http://localhost:${c.server.address().port}`;
}

const sample = () => ({ id: 'abc', name: 'GET /a', start: Date.now(), elapsed: 12, status: 200, error: null, spans: [] });
const post = (base, body) => fetch(`${base}/ingest`, { method: 'POST', body });

test('ingest 후 /tx/:id로 상세를 얻는다', async (t) => {
  const base = await start(t);
  const tx = sample();
  assert.equal((await post(base, JSON.stringify({ agent: 'x', txs: [tx], active: [] }))).status, 204);
  assert.deepEqual(await (await fetch(`${base}/tx/abc`)).json(), { ...tx, agent: 'x' });
  assert.equal((await fetch(`${base}/tx/nope`)).status, 404);
});

test('잘못된 JSON과 1MB 초과 본문은 400', async (t) => {
  const base = await start(t);
  assert.equal((await post(base, '{oops')).status, 400);
  assert.equal((await post(base, 'null')).status, 400);
  assert.equal((await post(base, 'x'.repeat(1024 * 1024 + 1))).status, 400);
});

test('대시보드 파일만 제공하고 폴더 밖은 404', async (t) => {
  const base = await start(t);
  const ok = await fetch(`${base}/calc.mjs`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(`${base}/..%2fcollector%2fstore.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
});

test('stream은 연결 즉시 최근 점을, 이후 1초마다 새 점을 보낸다', async (t) => {
  const base = await start(t);
  await post(base, JSON.stringify({ agent: 'x', txs: [sample()], active: [] }));
  await new Promise((r) => setTimeout(r, 1100)); // 틱이 한 번 지나 'abc'가 과거 점이 된 뒤 연결
  const ac = new AbortController();
  const res = await fetch(`${base}/stream`, { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ''));
  const first = await next();
  assert.deepEqual(first.points.map((p) => p.id), ['abc']);
  assert.deepEqual(Object.keys(first.stats).sort(), ['avg', 'errors', 'p95', 'tps']);
  assert.equal(first.points[0].agent, 'x');
  assert.deepEqual(first.agents.map((a) => a.name), ['x']);
  assert.deepEqual(Object.keys(first.agentStats), ['x']);

  // 그 뒤 1초 틱마다 새로 받은 점만 온다(같은 점이 두 번 오지 않는다)
  await post(base, JSON.stringify({ agent: 'x', txs: [{ ...sample(), id: 'def' }], active: [] }));
  let tick;
  do tick = await next(); while (tick.points.length === 0);
  ac.abort();
  assert.deepEqual(tick.points.map((p) => p.id), ['def']);
});

test('이상한 입력에도 수집 서버가 죽지 않는다', async (t) => {
  const base = await start(t);
  assert.equal((await post(base, JSON.stringify({ agent: 'x', txs: [], active: [null, 1, 'a'] }))).status, 204);
  assert.equal((await post(base, '{"agent":{"toString":1}}')).status, 204);
  const raw = await new Promise((resolve) => {
    const sock = require('node:net').connect(new URL(base).port, 'localhost', () =>
      sock.write('GET // HTTP/1.1\r\nHost: x\r\n\r\n'),
    );
    sock.once('data', (d) => {
      resolve(String(d));
      sock.destroy();
    });
  });
  assert.match(raw, /^HTTP\/1.1 400/);
  await new Promise((r) => setTimeout(r, 1100)); // 틱 한 번이 지나도
  assert.equal((await fetch(`${base}/tx/x`)).status, 404);
});

test('수집 서버는 이 PC(127.0.0.1)에서만 접속을 받는다', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('외부 네트워크 주소가 없음');

  const port = 7790 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'collector', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
  });
  t.after(() => child.kill());
  await new Promise((r) => child.stdout.once('data', r));

  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  await assert.rejects(fetch(`http://${lan.address}:${port}/`));
});

test('/routes는 최근 10분(기본)·전체를, /routes/txs는 그 API 트랜잭션을 느린 순으로', async (t) => {
  const base = await start(t);
  const key = 'GET /qna/{code}/list';
  const txs = [
    { ...sample(), id: 'r1', name: 'GET /qna/A/list', route: key, elapsed: 5 },
    { ...sample(), id: 'r2', name: 'GET /qna/B/list', route: key, elapsed: 9 },
  ];
  await post(base, JSON.stringify({ agent: 'x', txs, active: [] }));
  const ten = await (await fetch(`${base}/routes`)).json();
  assert.equal(ten.range, '10m');
  assert.deepEqual(ten.rows.map((r) => [r.agent, r.key, r.count]), [['x', key, 2]]);
  const all = await (await fetch(`${base}/routes?range=all`)).json();
  assert.equal(all.range, 'all');
  assert.equal(all.rows[0].count, 2);
  const q = `agent=x&key=${encodeURIComponent(key)}`;
  assert.deepEqual((await (await fetch(`${base}/routes/txs?${q}`)).json()).map((p) => p.id), ['r2', 'r1']);
  assert.deepEqual(await (await fetch(`${base}/routes/txs?agent=x`)).json(), []);
});

test('POST /compare는 고른 id와 나머지를 비교하고, 잘못된 본문은 400', async (t) => {
  const base = await start(t);
  const now = Date.now();
  const mk = (id, route) => ({ id, name: route, route, start: now - 1000, elapsed: 10, status: 200, error: null, spans: [] });
  await post(base, JSON.stringify({ agent: 'x', active: [], txs: [mk('s1', 'GET /slow'), mk('s2', 'GET /slow'), mk('f1', 'GET /fast')] }));
  const cmp = (body) => fetch(`${base}/compare`, { method: 'POST', body });
  const res = await (await cmp(JSON.stringify({ ids: ['s1', 's2'], since: now - 60000, agent: 'x' }))).json();
  assert.equal(res.picked, 2);
  assert.equal(res.rest, 1);
  assert.deepEqual(res.rows[0], { attr: 'API', value: 'GET /slow', picked: 2, rest: 0, pickedPct: 100, restPct: 0 });
  assert.equal((await cmp('{oops')).status, 400);
  assert.equal((await cmp('null')).status, 400);
  assert.equal((await cmp(JSON.stringify({ ids: 'x' }))).status, 400);
  assert.equal((await cmp('x'.repeat(1024 * 1024 + 1))).status, 400);
  // since·agent가 이상해도 기본값(0, 모든 앱)
  assert.equal((await (await cmp(JSON.stringify({ ids: ['s1'], since: 'x', agent: 5 }))).json()).rest, 2);
});
