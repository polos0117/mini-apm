// Java 에이전트 통합 테스트: TestApp(내장 Tomcat + Derby)을 -javaagent로 띄우고 진짜 수집 서버로 받는다.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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
  repoJar('com.squareup.okhttp3', 'okhttp', '3.14.9'),
  repoJar('com.squareup.okio', 'okio', '1.17.2'),
  repoJar('ch.qos.logback', 'logback-classic', '1.2.3'),
  repoJar('ch.qos.logback', 'logback-core', '1.2.3'),
  repoJar('org.slf4j', 'slf4j-api', '1.7.30'),
  repoJar('org.mybatis', 'mybatis', '3.5.6'),
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
async function startApp(collectorUrl, stubUrl = '') {
  const port = await freePort();
  const app = { port, stdout: '', stderr: '' };
  app.proc = spawn(javaBin('java'), [
    '-Xmx96m', // 에이전트가 앱 힙을 잡아먹지 않는지 보려고 작게
    '-Dfile.encoding=UTF-8', // Java 8 콘솔 기본 인코딩(cp949)으로는 한글 메시지를 비교할 수 없다
    `-Dderby.stream.error.file=${path.join(TMP, `derby-${port}.log`)}`,
    `-javaagent:${JAR}`,
    '-cp', [TMP, ...APP_CP].join(path.delimiter),
    'TestApp', String(port), stubUrl,
  ], { env: { ...process.env, APM_COLLECTOR: collectorUrl, APM_AGENT: 'test', APM_INTERVAL: '200', APM_APP_PACKAGE: 'TestApp' } });
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
  let store, collector, collectorUrl, app, stub, stubUrl;

  before(async () => {
    build();
    execFileSync(javaBin('javac'), [
      '-encoding', 'UTF-8', '-cp', APP_CP.join(path.delimiter), '-d', TMP,
      path.join(__dirname, '..', 'agent-java', 'test', 'TestApp.java'),
    ]);
    store = createStore();
    collector = createCollector(store);
    await new Promise((r) => collector.server.listen(0, '127.0.0.1', r)); // 실제 수집 서버처럼 이 PC에서만
    collectorUrl = `http://localhost:${collector.server.address().port}`;
    // 테스트 앱이 부를 외부 서버
    stub = http.createServer((req, res) => {
      res.writeHead({ '/ok': 200, '/err': 500 }[req.url] ?? 404);
      res.end('x');
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    stubUrl = `http://127.0.0.1:${stub.address().port}`;
    app = await startApp(collectorUrl, stubUrl);
  });
  after(() => {
    app?.proc.kill();
    collector?.close();
    stub?.close();
  });

  const get = (p) => fetch(`http://localhost:${app.port}${p}`).then((r) => r.status);
  const stored = (name) => store.points(0).filter((p) => p.name === name);
  // 이름이 name인 트랜잭션이 count개 저장될 때까지 기다렸다가 count번째의 상세를 돌려준다.
  async function waitTx(name, count = 1) {
    const pts = await waitFor(() => stored(name).length >= count && stored(name), `${name} 트랜잭션`, 10000);
    return store.get(pts[count - 1].id);
  }

  test('기동하면 에이전트 안내 한 줄이 출력된다', () => {
    assert.ok(app.stdout.includes(`[apm] mini-apm agent → ${collectorUrl} (test, 앱 패키지 TestApp)`), app.stdout);
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

  const exceptions = (tx) => tx.spans.filter((s) => s.type === 'exception').map((s) => [s.text, s.error, s.depth]);

  test('잡아서 ERROR 로그로 남긴 예외는 200이어도 에러이고 예외 구간이 남는다', async () => {
    assert.equal(await get('/caught'), 200);
    const tx = await waitTx('GET /caught');
    assert.equal(tx.status, 200);
    assert.equal(tx.error, 'IllegalStateException: 재고 없음');
    assert.deepEqual(exceptions(tx), [['주문 저장 실패', 'IllegalStateException: 재고 없음', 0]]);
    assert.equal(tx.spans[0].elapsed, 0);
  });

  test('예외 없는 ERROR 로그는 메시지가 에러', async () => {
    assert.equal(await get('/errlog'), 200);
    const tx = await waitTx('GET /errlog');
    assert.equal(tx.error, '결재 실패 id=7');
    assert.deepEqual(exceptions(tx), [['결재 실패 id=7', '결재 실패 id=7', 0]]);
  });

  test('printStackTrace()도 에러', async () => {
    assert.equal(await get('/printed'), 200);
    const tx = await waitTx('GET /printed');
    assert.equal(tx.error, 'IllegalArgumentException: 잘못된 값');
    assert.deepEqual(exceptions(tx), [['printStackTrace()', 'IllegalArgumentException: 잘못된 값', 0]]);
  });

  test('WARN 로그는 에러가 아니다', async () => {
    assert.equal(await get('/warn'), 200);
    const tx = await waitTx('GET /warn');
    assert.equal(tx.error, null);
    assert.deepEqual(tx.spans, []);
  });

  test('예외가 여럿이면 첫 번째가 요청 에러, 요청 밖 ERROR 로그는 어디에도 없다', async () => {
    assert.equal(await get('/twice'), 200);
    const tx = await waitTx('GET /twice');
    assert.equal(tx.error, 'RuntimeException: a');
    assert.deepEqual(exceptions(tx).map((e) => e[1]), ['RuntimeException: a', 'RuntimeException: b']);
    const all = store.points(0).map((p) => store.get(p.id));
    assert.ok(all.every((t) => t.spans.every((s) => s.text !== '기동 중 에러')));
  });

  const flow = (tx) => tx.spans.map((s) => [s.type, s.type === 'sql' ? s.text.slice(0, 11) : s.text, s.depth]);

  test('Controller → Service → 매퍼 → SQL이 들여쓰기 순서로 남고, getter·프록시는 줄이 없다', async () => {
    assert.equal(await get('/flow'), 200);
    const tx = await waitTx('GET /flow');
    assert.deepEqual(flow(tx), [
      ['method', 'TestAppOrderController.save', 0],
      ['method', 'TestAppOrderServiceImpl.saveOrder', 1],
      ['mapper', 'TestAppItemMapper.name', 2],
      ['sql', 'select name', 3],
    ]);
    const [ctrl, svc, mapper, sql] = tx.spans;
    assert.ok(ctrl.elapsed >= svc.elapsed && svc.elapsed >= mapper.elapsed && mapper.elapsed >= sql.elapsed);
  });

  test('컨트롤러의 getter 모양 요청 처리 메서드는 줄이 있다', async () => {
    assert.equal(await get('/getitem'), 200);
    const tx = await waitTx('GET /getitem');
    assert.deepEqual(flow(tx).slice(0, 2), [
      ['method', 'TestAppOrderController.getItem', 0],
      ['method', 'TestAppOrderServiceImpl.saveOrder', 1],
    ]);
  });

  test('구간 한도를 채운 뒤 남긴 예외도 요청 에러다', async () => {
    assert.equal(await get('/floodlog'), 200);
    const tx = await waitTx('GET /floodlog');
    assert.ok(tx.droppedSpans > 0, String(tx.droppedSpans));
    assert.equal(tx.error, 'IllegalStateException: 한도 뒤');
  });

  test('메서드가 던진 예외는 그 줄에 남고, 잡혔으면 요청은 에러가 아니다', async () => {
    assert.equal(await get('/flowfail'), 200);
    const tx = await waitTx('GET /flowfail');
    assert.deepEqual(tx.spans.map((s) => [s.text, s.depth, s.error]), [
      ['TestAppOrderController.saveFail', 0, null],
      ['TestAppOrderServiceImpl.failOrder', 1, 'IllegalStateException: 재고 없음'],
    ]);
    assert.equal(tx.error, null);
  });

  test('처리 중 목록의 마지막 호출은 메서드가 아니라 SQL', async () => {
    const res = get('/flowslow');
    const item = await waitFor(
      () => store.active().find((a) => a.name === 'GET /flowslow' && /pause/.test(a.where ?? '')), '처리 중 목록', 5000);
    assert.match(item.lastSpan, /^select name from item/);
    assert.equal(await res, 200);
  });

  test('요청 정보: X-Forwarded-For 첫 IP, Referer, Spring Security 사용자, 비밀 파라미터 가림', async () => {
    const res = await fetch(`http://localhost:${app.port}/req?x=1&password=secret&x=2`, {
      headers: { Referer: 'http://localhost/list', 'X-Forwarded-For': ' 10.0.0.9 , 10.0.0.1' },
    });
    assert.equal(res.status, 200);
    const tx = await waitTx('GET /req');
    assert.deepEqual(tx.req, { ip: '10.0.0.9', user: 'hong01', referer: 'http://localhost/list', params: 'x=1&x=2&password=****' });
  });

  test('요청 정보: 세션 loginUser의 getUserId, 세션 없으면 사용자·파라미터 없음', async () => {
    assert.equal(await get('/req2'), 200);
    assert.equal((await waitTx('GET /req2')).req.user, 'kim02');
    const n = stored('GET /hello').length + 1; // 요청 전에 센다
    assert.equal(await get('/hello'), 200);
    const hello = await waitTx('GET /hello', n);
    assert.equal(hello.req.user, null);
    assert.equal(hello.req.params, null);
    assert.equal(hello.req.referer, null);
    assert.ok(hello.req.ip);
  });

  test('파라미터는 값 200자, 전체 2,000자에서 자른다', async () => {
    const long = 'v'.repeat(300);
    const n = stored('GET /hello').length + 1; // 요청 전에 센다
    assert.equal(await get(`/hello?a=${long}&${Array.from({ length: 20 }, (_, i) => `k${i}=${long}`).join('&')}`), 200);
    const tx = await waitTx('GET /hello', n);
    assert.ok(tx.req.params.startsWith(`a=${'v'.repeat(200)}...&k0=`), tx.req.params.slice(0, 220));
    assert.equal(tx.req.params.length, 2003);
    assert.ok(tx.req.params.endsWith('...'));
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

  test('처리 중인 요청에 지금 실행 중인 앱 메서드와 맨 위 프레임이 보인다', async () => {
    const res = get('/slow');
    const item = await waitFor(
      () => store.active().find((a) => a.name === 'GET /slow' && /sleep/.test(a.where ?? '')), '현재 위치', 5000);
    assert.match(item.where, /^TestApp\$1\.doGet:\d+ → Thread\.sleep$/);
    assert.equal(await res, 200);
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

  test('PreparedStatement 실행이 SQL 구간 하나로 기록되고 문장은 공백이 정리된다', async () => {
    assert.equal(await get('/ok'), 200);
    const tx = await waitTx('GET /ok');
    assert.equal(tx.status, 200);
    assert.equal(tx.spans.length, 1);
    const [s] = tx.spans;
    assert.equal(s.type, 'sql');
    assert.equal(s.text, `select name from item where id = 1 and name <> 'q"\\'`);
    assert.equal(s.error, null);
    assert.ok(s.offset >= 0 && s.elapsed >= 0 && s.offset + s.elapsed <= tx.elapsed + 0.2);
  });

  test('실패한 SQL은 구간 하나에 에러가 남고, 트랜잭션 에러가 된다', async () => {
    assert.equal(await get('/fail'), 500);
    const tx = await waitTx('GET /fail');
    assert.equal(tx.status, 500);
    assert.equal(tx.spans.length, 1); // Derby 안의 execute 중첩은 바깥 하나만
    assert.equal(tx.spans[0].text, 'select * from missing_table');
    assert.match(tx.spans[0].error, /MISSING_TABLE/);
    assert.equal(tx.error, tx.spans[0].error);
  });

  test('구간이 많아 1MB를 넘는 트랜잭션도 잘려서 저장되고, 같은 때 끝난 요청도 잃지 않는다', async () => {
    const [many, hello] = await Promise.all([get('/many'), get('/hello')]);
    assert.deepEqual([many, hello], [200, 200]);
    const tx = await waitTx('GET /many');
    assert.ok(tx.spans.length > 0 && tx.spans.length < 1000, String(tx.spans.length));
    assert.equal(tx.spans.length + tx.droppedSpans, 1100);
    assert.ok(Buffer.byteLength(JSON.stringify(tx)) < 1024 * 1024);
    await waitTx('GET /hello', 4);
  });

  test('바인드 값이 SQL에 끼워 넣어지고, 따옴표 안의 ?와 clearParameters 뒤의 빈 자리는 그대로다', async () => {
    assert.equal(await get('/bind'), 200);
    const tx = await waitTx('GET /bind');
    assert.deepEqual(tx.spans.map((s) => s.text), [
      "select name from item where id = 7 and name <> 'it''s' and name <> '?' and name <> NULL",
      "select name from item where id = 8 and name <> ? and name <> '?' and name <> ?",
    ]);
    assert.equal(tx.spans[0].error, null);
    assert.ok(tx.spans[1].error); // 2·3번 값을 안 넣었으니 Derby가 거절한다
  });

  test('긴 SQL도 자르지 않고 보낸다', async () => {
    assert.equal(await get('/long'), 200);
    const tx = await waitTx('GET /long');
    const sql = tx.spans[0].text;
    assert.ok(sql.length > 5000, String(sql.length));
    assert.match(sql, /, 1200\) and name <> 'end'$/);
  });

  test('처리 중 목록의 마지막 호출은 1,000자에서 자른다(완료된 트랜잭션에는 전체)', async () => {
    const res = get('/longslow');
    const item = await waitFor(
      () => store.active().find((a) => a.name === 'GET /longslow' && a.lastSpan), '처리 중 목록', 5000);
    assert.equal(item.lastSpan.length, 1003);
    assert.ok(item.lastSpan.endsWith('...'));
    assert.equal(await res, 200);
    const tx = await waitTx('GET /longslow');
    assert.ok(tx.spans[0].text.length > 5000, String(tx.spans[0].text.length));
  });

  test('보낼 수 없을 만큼 쌓인 구간은 힙에 들고 있지 않는다', async () => {
    assert.equal(await get('/heavy'), 200);
    const tx = await waitTx('GET /heavy');
    assert.equal(tx.spans.length + tx.droppedSpans, 1000);
    assert.ok(tx.spans.length > 0 && tx.spans.length < 30, String(tx.spans.length));
  });

  test('HttpURLConnection 호출이 외부 구간으로 기록되고, 반복 호출·https 위임에도 호출당 하나다', async () => {
    assert.equal(await get('/http'), 200);
    const tx = await waitTx('GET /http');
    const [ok, err, nf, dead] = tx.spans;
    assert.deepEqual([ok.text, ok.error], [`GET ${stubUrl}/ok`, null]);
    assert.deepEqual([err.text, err.error], [`GET ${stubUrl}/err`, 'HTTP 500']);
    assert.deepEqual([nf.text, nf.error], [`GET ${stubUrl}/nf`, null]); // 4xx는 에러가 아니다
    assert.match(dead.text, /^GET https:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(dead.error, /Connection refused|timed out/); // Windows는 닫힌 포트에 2초쯤 재시도한 뒤 거절한다
    assert.ok(ok.offset >= 0 && ok.elapsed >= 0);
  });

  test('connect()·getOutputStream()에서 연결하는 호출도 구간 하나다: 성공은 응답까지 이어지고, 연결 실패는 에러로 남는다', async () => {
    assert.equal(await get('/http'), 200);
    const tx = await waitTx('GET /http', 2);
    assert.equal(tx.spans.length, 6);
    const [post, refused] = tx.spans.slice(4);
    assert.deepEqual([post.type, post.text, post.error], ['http', `POST ${stubUrl}/ok`, null]);
    assert.match(refused.text, /^GET http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(refused.error, /Connection refused|timed out/);
  });

  test('OkHttp 동기 호출이 외부 구간으로 기록된다', async () => {
    assert.equal(await get('/okhttp'), 200);
    const tx = await waitTx('GET /okhttp');
    assert.equal(tx.spans.length, 3);
    const [ok, err, dead] = tx.spans;
    assert.deepEqual([ok.type, ok.text, ok.error], ['http', `GET ${stubUrl}/ok`, null]);
    assert.deepEqual([err.text, err.error], [`GET ${stubUrl}/err`, 'HTTP 500']); // 예외 없이 500 응답
    assert.match(dead.text, /^GET http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(dead.error, /127\.0\.0\.1/); // Failed to connect to /127.0.0.1:<port>
  });

  test('요청 밖에서 실행된 SQL(기동 시 create table)은 어디에도 기록되지 않는다', () => {
    for (const p of store.points(0)) {
      for (const s of store.get(p.id).spans) assert.doesNotMatch(s.text, /create table|insert into/);
    }
  });
});
