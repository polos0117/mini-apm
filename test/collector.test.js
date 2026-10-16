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
  assert.deepEqual(await (await fetch(`${base}/tx/abc`)).json(), tx);
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

  // 그 뒤 1초 틱마다 새로 받은 점만 온다(같은 점이 두 번 오지 않는다)
  await post(base, JSON.stringify({ agent: 'x', txs: [{ ...sample(), id: 'def' }], active: [] }));
  let tick;
  do tick = await next(); while (tick.points.length === 0);
  ac.abort();
  assert.deepEqual(tick.points.map((p) => p.id), ['def']);
});
