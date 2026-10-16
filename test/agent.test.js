const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const received = []; // 가짜 수집 서버가 받은 본문들
const collector = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push(JSON.parse(body));
    res.writeHead(204).end();
  });
});

test.before(async () => {
  await new Promise((r) => collector.listen(0, r));
  process.env.APM_COLLECTOR = `http://localhost:${collector.address().port}`;
  process.env.APM_INTERVAL = '50';
  require('../agent');
});
test.after(() => {
  collector.closeAllConnections();
  collector.close();
});

async function listen(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return `http://localhost:${s.address().port}`;
}

const txsNamed = (name) => received.flatMap((b) => b.txs).filter((t) => t.name === name);
async function waitTx(name, count = 1) {
  for (let i = 0; i < 100; i++) {
    if (txsNamed(name).length >= count) return txsNamed(name);
    await sleep(20);
  }
  throw new Error(`${name} 트랜잭션이 오지 않음`);
}

test('요청 하나에 SQL과 외부 호출 span이 순서대로, 트랜잭션은 한 번만 기록된다', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE a (x)'); // 요청 밖: 기록되지 않는다
  const ext = await listen(t, (req, res) => res.end('ok'));
  const app = await listen(t, async (req, res) => {
    db.prepare('SELECT count(*) FROM a').get();
    await fetch(`${ext}/pay`);
    res.end('done');
  });

  assert.equal(await (await fetch(`${app}/order?x=1`)).text(), 'done');
  const [tx] = await waitTx('GET /order');
  assert.equal(tx.status, 200);
  assert.equal(tx.error, null);
  assert.deepEqual(tx.spans.map((s) => [s.type, s.text]), [
    ['sql', 'SELECT count(*) FROM a'],
    ['http', `GET ${ext}/pay`],
  ]);
  assert.ok(tx.spans[1].offset >= tx.spans[0].offset);
  assert.ok(tx.elapsed >= tx.spans[1].elapsed);
  assert.ok(received.flatMap((b) => b.txs).every((t) => !t.spans.some((s) => s.text.startsWith('CREATE'))));

  await sleep(200); // finish와 close가 둘 다 지나간 뒤에도
  assert.equal(txsNamed('GET /order').length, 1);
});

test('동시에 들어온 두 요청의 span이 섞이지 않는다', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const app = await listen(t, async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('id');
    db.prepare(`SELECT '${id}-1'`).get();
    await sleep(Number(q.get('wait')));
    db.prepare(`SELECT '${id}-2'`).get();
    res.end();
  });

  await Promise.all([fetch(`${app}/mix?id=A&wait=60`), fetch(`${app}/mix?id=B&wait=5`)]);
  const txs = await waitTx('GET /mix', 2);
  const owners = txs.map((tx) => tx.spans.map((s) => s.text.match(/'(\w)-/)[1]));
  for (const ids of owners) {
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 1);
  }
  assert.deepEqual(owners.map((ids) => ids[0]).sort(), ['A', 'B']);
});

test('500 이상 응답은 에러 트랜잭션, 실패한 외부 호출 메시지가 에러가 된다', async (t) => {
  const ext = await listen(t, (req, res) => {
    res.statusCode = 500;
    res.end();
  });
  const app = await listen(t, async (req, res) => {
    const r = await fetch(`${ext}/pay`);
    res.statusCode = r.ok ? 200 : 502;
    res.end();
  });
  const plain = await listen(t, (req, res) => {
    res.statusCode = 500; // 앱이 예외를 잡아 500으로 응답한 경우
    res.end();
  });

  await fetch(`${app}/fail`);
  await fetch(`${plain}/boom`);
  const [fail] = await waitTx('GET /fail');
  assert.equal(fail.status, 502);
  assert.equal(fail.spans[0].error, 'HTTP 500');
  assert.equal(fail.error, 'HTTP 500');
  const [boom] = await waitTx('GET /boom');
  assert.equal(boom.error, 'HTTP 500');
});

test('끝나지 않은 요청은 처리 중 목록에 마지막 호출과 함께 나온다', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const ext = await listen(t, async (req, res) => {
    await gate;
    res.end();
  });
  const app = await listen(t, async (req, res) => {
    await fetch(`${ext}/slow`);
    res.end();
  });

  const pending = fetch(`${app}/hang`);
  let found;
  for (let i = 0; i < 100 && !found; i++) {
    await sleep(20);
    found = received.flatMap((b) => b.active).find((a) => a.name === 'GET /hang');
  }
  release();
  await pending;
  assert.ok(found, '처리 중 목록에 없음');
  assert.equal(found.lastSpan, `GET ${ext}/slow`);
  assert.ok(found.elapsed >= 0);
});

test('트랜잭션당 span은 1000개까지, 나머지는 개수만 센다', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const app = await listen(t, (req, res) => {
    const stmt = db.prepare('SELECT 1');
    for (let i = 0; i < 1500; i++) stmt.get();
    res.end();
  });
  await fetch(`${app}/many`);
  const [tx] = await waitTx('GET /many');
  assert.equal(tx.spans.length, 1000);
  assert.equal(tx.droppedSpans, 500);
});

test('수집 서버가 꺼져 있어도 앱은 정상 응답한다', async (t) => {
  const code = `require('node:http').createServer((q, s) => s.end('ok')).listen(0, function () { console.log(this.address().port); });`;
  const child = spawn(process.execPath, ['--require', path.join(__dirname, '..', 'agent'), '-e', code], {
    env: { ...process.env, APM_COLLECTOR: 'http://localhost:9', APM_INTERVAL: '20' },
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim())));
  for (let i = 0; i < 5; i++) {
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'ok');
    await sleep(30);
  }
  assert.equal(child.exitCode, null);
});
