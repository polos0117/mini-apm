// Java 에이전트 통합 테스트: TestApp(내장 Tomcat + Derby)을 -javaagent로 띄우고 진짜 수집 서버로 받는다.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createCollector } = require('../collector/server');
const { createStore } = require('../collector/store');
const { build, javaBin, JAVA_HOME, REPO, JAR } = require('../agent-java/build');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JAVA_OK = fs.existsSync(javaBin('javac'));
const repoJar = (group, id, v) => path.join(REPO, ...group.split('.'), id, v, `${id}-${v}.jar`);
const APP_CP = [
  repoJar('org.apache.tomcat.embed', 'tomcat-embed-core', '9.0.43'),
  repoJar('jakarta.annotation', 'jakarta.annotation-api', '1.3.5'), // 로컬 저장소에 tomcat-annotations-api는 pom뿐이다
  path.join(JAVA_HOME, 'db', 'lib', 'derby.jar'),
];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-java-'));

async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`${what}: 시간 초과`);
}

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
}

// TestApp을 에이전트와 함께 띄운다. 출력은 돌려준 객체에 계속 쌓인다.
async function startApp(collectorUrl) {
  const port = await freePort();
  const app = { port, stdout: '', stderr: '' };
  app.proc = spawn(javaBin('java'), [
    '-Dfile.encoding=UTF-8', // Java 8 콘솔 기본 인코딩(cp949)으로는 한글 메시지를 비교할 수 없다
    `-Dderby.stream.error.file=${path.join(TMP, `derby-${port}.log`)}`,
    `-javaagent:${JAR}`,
    '-cp', [TMP, ...APP_CP].join(path.delimiter),
    'TestApp', String(port),
  ], { env: { ...process.env, APM_COLLECTOR: collectorUrl, APM_AGENT: 'test', APM_INTERVAL: '200' } });
  app.proc.stdout.on('data', (d) => (app.stdout += d));
  app.proc.stderr.on('data', (d) => (app.stderr += d));
  try {
    await waitFor(() => app.stdout.includes('READY'), 'TestApp 기동');
  } catch (err) {
    app.proc.kill();
    throw new Error(`${err.message}\n${app.stderr}`);
  }
  return app;
}

describe('Java 에이전트', { skip: JAVA_OK ? false : `JDK 없음: ${JAVA_HOME}` }, () => {
  let store, collector, collectorUrl, app;

  before(async () => {
    build();
    execFileSync(javaBin('javac'), [
      '-encoding', 'UTF-8', '-cp', APP_CP.join(path.delimiter), '-d', TMP,
      path.join(__dirname, '..', 'agent-java', 'test', 'TestApp.java'),
    ]);
    store = createStore();
    collector = createCollector(store);
    await new Promise((r) => collector.server.listen(0, r));
    collectorUrl = `http://localhost:${collector.server.address().port}`;
    app = await startApp(collectorUrl);
  });
  after(() => {
    app?.proc.kill();
    collector?.close();
  });

  const get = (p) => fetch(`http://localhost:${app.port}${p}`).then((r) => r.status);
  const stored = (name) => store.points(0).filter((p) => p.name === name);
  // 이름이 name인 트랜잭션이 count개 저장될 때까지 기다렸다가 count번째의 상세를 돌려준다.
  async function waitTx(name, count = 1) {
    const pts = await waitFor(() => stored(name).length >= count && stored(name), `${name} 트랜잭션`, 10000);
    return store.get(pts[count - 1].id);
  }

  test('기동하면 에이전트 안내 한 줄이 출력된다', () => {
    assert.ok(app.stdout.includes(`[apm] mini-apm agent → ${collectorUrl} (test)`), app.stdout);
  });

  test('요청 하나가 트랜잭션 하나로 저장된다', async () => {
    assert.equal(await get('/hello'), 200);
    const tx = await waitTx('GET /hello');
    assert.equal(tx.status, 200);
    assert.equal(tx.error, null);
    assert.ok(tx.elapsed >= 0 && tx.start > 0);
    assert.deepEqual(tx.spans, []);
  });

  test('경로 파라미터(;jsessionid)는 이름에서 빠진다', async () => {
    assert.equal(await get('/hello;jsessionid=abc'), 200);
    await waitTx('GET /hello', 2);
    assert.equal(store.points(0).filter((p) => p.name.includes('jsessionid')).length, 0);
  });

  test('SQL 없이 예외로 끝난 요청은 500, 에러는 HTTP 500', async () => {
    assert.equal(await get('/boom'), 500);
    const tx = await waitTx('GET /boom');
    assert.equal(tx.status, 500);
    assert.equal(tx.error, 'HTTP 500');
  });

  test('정적 파일 요청은 기록하지 않는다', async () => {
    assert.equal(await get('/app.js'), 200);
    assert.equal(await get('/hello'), 200);
    await waitTx('GET /hello', 3); // 뒤 요청이 저장됐으면 앞 요청도 이미 전송됐다
    assert.equal(stored('GET /app.js').length, 0);
  });

  test('처리 중인 요청이 수집 서버의 처리 중 목록에 보인다', async () => {
    const res = get('/slow');
    const item = await waitFor(() => store.active().find((a) => a.name === 'GET /slow'), '처리 중 목록', 5000);
    assert.equal(typeof item.id, 'string');
    assert.equal(item.lastSpan, null);
    assert.equal(await res, 200);
    const tx = await waitTx('GET /slow');
    assert.ok(tx.elapsed >= 1400, String(tx.elapsed));
  });

  test('수집 서버가 꺼져 있어도 앱은 정상 응답하고 실패 메시지는 한 번만 나온다', async (t) => {
    const dead = await startApp(`http://localhost:${await freePort()}`);
    t.after(() => dead.proc.kill());
    const res = await fetch(`http://localhost:${dead.port}/hello`);
    assert.equal(res.status, 200);
    await sleep(1200); // 200ms 간격이면 대여섯 번 전송을 시도한다
    const lines = dead.stderr.split('\n').filter((l) => l.includes('[apm] 전송 실패'));
    assert.equal(lines.length, 1, dead.stderr);
  });
});
