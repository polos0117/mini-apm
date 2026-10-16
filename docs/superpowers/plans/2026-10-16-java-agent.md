# mini-apm Java 에이전트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spring Boot 2.4 / Java 8 앱(KIPA_IP-Finance)을 소스 수정 없이 `-javaagent`로 계측해 기존 mini-apm 수집 서버로 요청·SQL 트랜잭션을 보낸다.

**Architecture:**
- **계측**: Byte Buddy Advice로 두 곳에 코드를 끼워 넣는다.
  - 요청: Tomcat `StandardHostValve.invoke`
  - SQL: JDBC `Statement.execute*`, `Connection.prepareStatement`
- **기록과 전송**: `Tracer`가 스레드별 트랜잭션을 기록하고, 1초마다 Node 에이전트와 같은 JSON을 `/ingest`로 보낸다.
- **빌드**: Maven 없이 JDK 8의 `javac`와 `jar`로 한다. Node 스크립트 하나가 Byte Buddy를 담은 jar 하나를 만든다.

**Tech Stack:**
- Java 8 (jdk1.8.0_102), Byte Buddy 1.10.20
- 테스트: Node 22 `node:test`, 내장 Tomcat 9.0.43, Derby (JDK 8 동봉)

**Spec:** `docs/superpowers/specs/2026-10-16-java-agent-design.md`

## Global Constraints

- Java 소스는 `-source 8 -target 8`. Java 9+ API(`List.of`, `var` 등) 금지.
- JDK 경로: `APM_JAVA_HOME`, 기본 `D:/AnyBuilder/bin/java/jdk1.8.0_102-x64`.
- Byte Buddy jar: `APM_BYTEBUDDY_JAR`, 기본 `D:/AnyBuilder/data/.tool/maven/repository/net/bytebuddy/byte-buddy/1.10.20/byte-buddy-1.10.20.jar`.
- 로컬 Maven 저장소 `D:/AnyBuilder/data/.tool/maven/repository`는 읽기만 한다.
- `D:\AnyBuilder` 아래 파일은 하나도 고치지 않는다. Eclipse 실행 설정도 사람이 직접 넣는다.
- 수집 서버(`collector/`)와 대시보드(`dashboard/`)는 고치지 않는다.
- 상수: `MAX_SPANS = 1000`, `MAX_BUFFER = 5000`, `MAX_SQL = 1000`(문자), 전송 타임아웃 연결·응답 각 1000ms.
- 환경변수와 기본값: `APM_COLLECTOR` = `http://localhost:7700`, `APM_AGENT` = `java`, `APM_INTERVAL` = `1000`.
- 정적 파일 확장자: `js css png jpg gif svg ico woff woff2 map` (대소문자 무시).
- 기동 메시지: `[apm] mini-apm agent → <APM_COLLECTOR> (<APM_AGENT>)` (stdout).
- 전송 실패 메시지: `[apm] 전송 실패: <예외>` (stderr). 다음 성공 전까지 한 번만 출력.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Git Bash에서 테스트는 `fnm exec --using=22 npm.cmd test`로 실행한다.

## Review Focus

1. **Hikari → log4jdbc → MariaDB 세 겹 호출**: SQL 하나는 구간 하나여야 한다.
   - 자동 테스트는 Derby 내부 중첩(`Statement.executeQuery` → private `execute`)으로만 확인한다.
   - 실제 세 겹은 IP-Finance 직접 확인(Task 4 Step 5)에서 본다.
2. **`;jsessionid=...` 경로 파라미터가 붙은 URI**: 이름은 `GET /hello`처럼 잘린 형태여야 한다. Task 2의 jsessionid 테스트가 확인한다.
3. **SQL 문장 안의 `"`, `\`, 줄바꿈**: JSON이 깨지지 않고 문장이 그대로 와야 한다. Task 3의 `/ok` 테스트가 확인한다.
4. **수집 서버가 꺼진 상태**: 앱 응답은 영향이 없고 로그는 한 줄이어야 한다. Task 2의 dead collector 테스트가 확인한다.
5. **SQL 없이 예외로 끝난 요청**: 상태 500, `error`는 `HTTP 500`이어야 한다. Task 2의 `/boom` 테스트가 확인한다.

---

### Task 1: 빌드 스크립트, 빈 에이전트, 테스트 앱

**Files:**
- Create: `agent-java/build.js`
- Create: `agent-java/src/apm/Agent.java`
- Create: `agent-java/test/TestApp.java`
- Create: `test/java-agent.test.js`
- Create: `.gitignore`
- Modify: `package.json` (scripts에 `build:java` 추가)

**Interfaces:**
- Produces:
  - `require('../agent-java/build')` → `{ build(): string, javaBin(name: string): string, JAVA_HOME: string, REPO: string, JAR: string }`
    - `build()`은 만든 jar의 경로를 돌려준다. 실패하면 Error를 던진다.
  - `TestApp <port>`
    - 기동이 끝나면 stdout에 `READY`를 출력한다.
    - 경로: `/ok`, `/fail`, `/boom`, `/slow`, `/hello`, `/app.js`
  - 테스트 파일의 `startApp(collectorUrl)` → `{ port, proc, stdout, stderr }`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/java-agent.test.js`:

```js
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
  repoJar('org.apache.tomcat', 'tomcat-annotations-api', '9.0.43'),
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

  test('기동하면 에이전트 안내 한 줄이 출력된다', () => {
    assert.ok(app.stdout.includes(`[apm] mini-apm agent → ${collectorUrl} (test)`), app.stdout);
  });
});
```

`agent-java/test/TestApp.java`:

```java
import java.io.File;
import java.io.IOException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;

// 에이전트 테스트용 앱: 내장 Tomcat + Derby 메모리 DB. 인자는 포트 하나.
public class TestApp {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(args[0]);
    Connection db = DriverManager.getConnection("jdbc:derby:memory:t;create=true");
    try (Statement s = db.createStatement()) { // 요청 밖의 SQL: 기록되면 안 된다
      s.execute("create table item (id int, name varchar(20))");
      s.execute("insert into item values (1, 'a')");
    }

    Tomcat tomcat = new Tomcat();
    tomcat.setPort(port);
    tomcat.setBaseDir(new File(System.getProperty("java.io.tmpdir"), "apm-testapp-" + port).getPath());
    tomcat.getConnector(); // Tomcat 9는 이 호출로 기본 커넥터를 만든다
    Context ctx = tomcat.addContext("", null);
    Tomcat.addServlet(ctx, "app", new HttpServlet() {
      @Override
      protected void doGet(HttpServletRequest req, HttpServletResponse res) throws ServletException, IOException {
        try {
          switch (req.getServletPath()) {
            case "/ok":
              try (PreparedStatement p = db.prepareStatement(
                  "select name\n    from item\n   where id = ?\n     and name <> 'q\"\\'")) {
                p.setInt(1, 1);
                p.executeQuery().close();
              }
              break;
            case "/fail":
              try (Statement s = db.createStatement()) {
                s.executeQuery("select * from missing_table");
              }
              break;
            case "/boom":
              throw new IllegalStateException("boom");
            case "/slow":
              Thread.sleep(1500);
              break;
            default: // /hello, /app.js
              break;
          }
          res.getWriter().write("ok");
        } catch (SQLException | InterruptedException e) {
          throw new ServletException(e);
        }
      }
    });
    ctx.addServletMappingDecoded("/", "app");
    tomcat.start();
    System.out.println("READY");
    tomcat.getServer().await();
  }
}
```

- [ ] **Step 2: 테스트 실행, 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: FAIL. 원인은 `Cannot find module '../agent-java/build'`이다.

- [ ] **Step 3: 빌드 스크립트와 빈 에이전트 작성**

`agent-java/build.js`:

```js
// Java 에이전트 빌드: Maven 없이 JDK 8의 javac와 jar로 Byte Buddy를 담은 jar 하나를 만든다.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const JAVA_HOME = process.env.APM_JAVA_HOME || 'D:/AnyBuilder/bin/java/jdk1.8.0_102-x64';
const REPO = 'D:/AnyBuilder/data/.tool/maven/repository';
const BYTEBUDDY = process.env.APM_BYTEBUDDY_JAR ||
  path.join(REPO, 'net/bytebuddy/byte-buddy/1.10.20/byte-buddy-1.10.20.jar');
// RequestAdvice가 쓰는 javax.servlet 타입 때문에 컴파일 때만 쓴다. jar에는 넣지 않는다.
const SERVLET = path.join(REPO, 'org/apache/tomcat/embed/tomcat-embed-core/9.0.43/tomcat-embed-core-9.0.43.jar');

const SRC = path.join(__dirname, 'src', 'apm');
const BUILD = path.join(__dirname, 'build');
const CLASSES = path.join(BUILD, 'classes');
const JAR = path.join(__dirname, 'dist', 'mini-apm-agent.jar');

const javaBin = (name) => path.join(JAVA_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

function build() {
  for (const [what, p] of [['JDK (APM_JAVA_HOME)', javaBin('javac')], ['Byte Buddy (APM_BYTEBUDDY_JAR)', BYTEBUDDY], ['tomcat-embed-core', SERVLET]]) {
    if (!fs.existsSync(p)) throw new Error(`${what} 없음: ${p}`);
  }
  fs.rmSync(CLASSES, { recursive: true, force: true });
  fs.mkdirSync(CLASSES, { recursive: true });
  fs.mkdirSync(path.dirname(JAR), { recursive: true });

  const sources = fs.readdirSync(SRC).filter((f) => f.endsWith('.java')).map((f) => path.join(SRC, f));
  run(javaBin('javac'), ['-source', '8', '-target', '8', '-encoding', 'UTF-8', '-nowarn',
    '-cp', [BYTEBUDDY, SERVLET].join(path.delimiter), '-d', CLASSES, ...sources]);
  run(javaBin('jar'), ['xf', BYTEBUDDY], CLASSES);
  fs.rmSync(path.join(CLASSES, 'META-INF', 'MANIFEST.MF'), { force: true });

  const manifest = path.join(BUILD, 'MANIFEST.MF');
  fs.writeFileSync(manifest, 'Premain-Class: apm.Agent\nCan-Retransform-Classes: true\n');
  run(javaBin('jar'), ['cfm', JAR, manifest, '-C', CLASSES, '.']);
  return JAR;
}

if (require.main === module) {
  try {
    console.log(build());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build, javaBin, JAVA_HOME, REPO, JAR };
```

`agent-java/src/apm/Agent.java`:

```java
package apm;

import java.lang.instrument.Instrumentation;

// 미니 APM Java 에이전트. `-javaagent:mini-apm-agent.jar`로 앱의 main보다 먼저 실행된다.
// JENNIFER의 -javaagent처럼, 앱 클래스가 로드될 때 바이트코드에 계측 코드를 끼워 넣는다.
public final class Agent {
  public static void premain(String args, Instrumentation inst) {
    String collector = env("APM_COLLECTOR", "http://localhost:7700");
    String agent = env("APM_AGENT", "java");
    System.out.println("[apm] mini-apm agent → " + collector + " (" + agent + ")");
  }

  private static String env(String key, String def) {
    String v = System.getenv(key);
    return v == null || v.isEmpty() ? def : v;
  }
}
```

`.gitignore`:

```
agent-java/build/
agent-java/dist/
```

`package.json`의 `scripts`를 다음으로 바꾼다:

```json
  "scripts": {
    "test": "node --test",
    "demo": "node demo.js",
    "build:java": "node agent-java/build.js"
  }
```

- [ ] **Step 4: 테스트 실행, 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS 1/1. `agent-java/dist/mini-apm-agent.jar`가 생긴다.

Run: `fnm exec --using=22 node agent-java/build.js`
Expected: jar 경로 한 줄이 출력되고 종료 코드는 0이다.

- [ ] **Step 5: 전체 테스트, 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 21/21 pass. 기존 20개에 새 1개가 더해진다.

```bash
git add .gitignore package.json agent-java test/java-agent.test.js
git commit -m "feat: Java agent build script, empty premain and test app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 요청 트랜잭션 기록과 전송

**Files:**
- Create: `agent-java/src/apm/Tracer.java`
- Create: `agent-java/src/apm/RequestAdvice.java`
- Modify: `agent-java/src/apm/Agent.java` (전체 교체)
- Modify: `test/java-agent.test.js` (describe 안에 helper와 테스트 추가)

**Interfaces:**
- Consumes: Task 1의 `startApp`, `waitFor`, `freePort`, `sleep`, 그리고 TestApp의 경로들.
- Produces:
  - `apm.Tracer`의 public static 멤버
    - 필드: `String collector`, `String agent`
    - `Tx begin(String method, String uri)`: 기록하지 않을 요청이면 `null`을 돌려준다.
    - `void end(Tx tx, int status)`: `tx`가 `null`이면 아무것도 하지 않는다.
    - `void startSender(long intervalMs)`
  - 클래스: `public static final class Tx`, `public static final class Span`
    - `Span`의 필드는 `text`, `t0`, `offset`, `elapsed`, `error`이다.
    - Task 3에서 SQL 메서드를 추가한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/java-agent.test.js`의 `describe` 안, 첫 `test` 바로 앞에 helper를 추가한다:

```js
  const get = (p) => fetch(`http://localhost:${app.port}${p}`).then((r) => r.status);
  const stored = (name) => store.points(0).filter((p) => p.name === name);
  // 이름이 name인 트랜잭션이 count개 저장될 때까지 기다렸다가 count번째의 상세를 돌려준다.
  async function waitTx(name, count = 1) {
    const pts = await waitFor(() => stored(name).length >= count && stored(name), `${name} 트랜잭션`, 10000);
    return store.get(pts[count - 1].id);
  }
```

같은 `describe` 안, 첫 `test` 뒤에 테스트를 추가한다:

```js
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
```

- [ ] **Step 2: 테스트 실행, 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: FAIL. `GET /hello 트랜잭션: 시간 초과`가 나야 한다. 처리 중 목록 테스트와 실패 메시지 테스트도 실패한다. 기동 안내 테스트는 계속 통과한다.

- [ ] **Step 3: Tracer, RequestAdvice, Agent 작성**

`agent-java/src/apm/Tracer.java`:

```java
package apm;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

// 트랜잭션과 구간을 기록하고 1초마다 수집 서버로 보낸다. 형식은 Node 에이전트(agent/index.js)와 같다.
// Advice가 대상 클래스 안으로 복사한 코드가 이 클래스의 public static 메서드를 부른다.
public final class Tracer {
  static final int MAX_SPANS = 1000;  // 트랜잭션당 기록할 구간 수. 넘으면 개수만 센다
  static final int MAX_BUFFER = 5000; // 전송 대기 트랜잭션 수
  static final int MAX_SQL = 1000;    // SQL 문장 길이. 큰 SQL 1000개가 수집 서버 1MB 한도를 넘지 않게
  static final Set<String> STATIC_EXT = new HashSet<>(Arrays.asList(
      "js", "css", "png", "jpg", "gif", "svg", "ico", "woff", "woff2", "map"));

  public static String collector = "http://localhost:7700";
  public static String agent = "java";

  // Tomcat은 요청 하나를 스레드 하나가 끝까지 처리하므로 '지금 어느 트랜잭션인가'는 스레드에 둔다.
  private static final ThreadLocal<Tx> CURRENT = new ThreadLocal<>();
  private static final Map<String, Tx> OPEN = new ConcurrentHashMap<>(); // 처리 중
  private static List<Tx> done = new ArrayList<>();                     // 전송 대기. Tracer.class로 잠근다
  private static boolean failing;                                        // 전송 스레드만 쓴다

  public static final class Tx {
    final String id = UUID.randomUUID().toString();
    final String name;
    final long start = System.currentTimeMillis();
    final long t0 = System.nanoTime();
    final List<Span> spans = Collections.synchronizedList(new ArrayList<Span>());
    int dropped;
    double elapsed;
    int status;
    String error;

    Tx(String name) {
      this.name = name;
    }
  }

  public static final class Span {
    final String text;
    final long t0 = System.nanoTime();
    final double offset;
    double elapsed;
    String error;

    Span(String text, double offset) {
      this.text = text;
      this.offset = offset;
    }
  }

  static double ms(long nanos) {
    return Math.round(nanos / 100_000.0) / 10.0; // 소수 첫째 자리
  }

  static boolean isStatic(String uri) {
    int dot = uri.lastIndexOf('.');
    return dot > uri.lastIndexOf('/') && STATIC_EXT.contains(uri.substring(dot + 1).toLowerCase(Locale.ROOT));
  }

  public static Tx begin(String method, String uri) {
    try {
      if (CURRENT.get() != null) return null; // 같은 스레드에서 다시 불려도 요청당 한 번만
      int semi = uri.indexOf(';'); // ;jsessionid=...
      if (semi >= 0) uri = uri.substring(0, semi);
      if (isStatic(uri)) return null;
      Tx tx = new Tx(method + " " + uri);
      CURRENT.set(tx);
      OPEN.put(tx.id, tx);
      return tx;
    } catch (Throwable t) {
      return null;
    }
  }

  public static void end(Tx tx, int status) {
    if (tx == null) return;
    CURRENT.remove();
    OPEN.remove(tx.id);
    tx.elapsed = ms(System.nanoTime() - tx.t0);
    tx.status = status;
    if (status >= 500) {
      tx.error = "HTTP " + status;
      synchronized (tx.spans) {
        for (Span s : tx.spans) if (s.error != null) tx.error = s.error; // 마지막으로 실패한 구간
      }
    }
    synchronized (Tracer.class) {
      done.add(tx);
      if (done.size() > MAX_BUFFER) done.subList(0, done.size() - MAX_BUFFER).clear();
    }
  }

  public static void startSender(final long intervalMs) {
    Thread t = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(intervalMs);
        } catch (InterruptedException e) {
          return;
        }
        flush();
      }
    }, "apm-sender");
    t.setDaemon(true);
    t.start();
  }

  static void flush() {
    List<Tx> batch;
    synchronized (Tracer.class) {
      batch = done;
      done = new ArrayList<>();
    }
    byte[] body = payload(batch, OPEN.values(), System.nanoTime()).getBytes(StandardCharsets.UTF_8);
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(collector + "/ingest").openConnection();
      c.setConnectTimeout(1000);
      c.setReadTimeout(1000);
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      try (OutputStream out = c.getOutputStream()) {
        out.write(body);
      }
      int code = c.getResponseCode();
      c.disconnect();
      if (code >= 400) throw new IOException("HTTP " + code);
      failing = false;
    } catch (Exception e) { // 그 묶음은 버린다
      if (!failing) System.err.println("[apm] 전송 실패: " + e);
      failing = true;
    }
  }

  // ---- JSON: 앱의 Jackson 버전과 부딪히지 않게 직접 쓴다 ----

  static String payload(List<Tx> txs, Collection<Tx> open, long now) {
    StringBuilder b = new StringBuilder(1024).append("{\"agent\":");
    str(b, agent);
    b.append(",\"txs\":[");
    for (int i = 0; i < txs.size(); i++) {
      if (i > 0) b.append(',');
      tx(b, txs.get(i));
    }
    b.append("],\"active\":[");
    boolean first = true;
    for (Tx t : open) {
      if (!first) b.append(',');
      first = false;
      String last = null;
      synchronized (t.spans) {
        if (!t.spans.isEmpty()) last = t.spans.get(t.spans.size() - 1).text;
      }
      b.append("{\"id\":");
      str(b, t.id);
      b.append(",\"name\":");
      str(b, t.name);
      b.append(",\"elapsed\":");
      num(b, ms(now - t.t0));
      b.append(",\"lastSpan\":");
      str(b, last);
      b.append('}');
    }
    return b.append("]}").toString();
  }

  static void tx(StringBuilder b, Tx t) {
    b.append("{\"id\":");
    str(b, t.id);
    b.append(",\"name\":");
    str(b, t.name);
    b.append(",\"start\":").append(t.start).append(",\"elapsed\":");
    num(b, t.elapsed);
    b.append(",\"status\":").append(t.status).append(",\"error\":");
    str(b, t.error);
    if (t.dropped > 0) b.append(",\"droppedSpans\":").append(t.dropped);
    b.append(",\"spans\":[");
    synchronized (t.spans) {
      for (int i = 0; i < t.spans.size(); i++) {
        Span s = t.spans.get(i);
        if (i > 0) b.append(',');
        b.append("{\"type\":\"sql\",\"text\":");
        str(b, s.text);
        b.append(",\"offset\":");
        num(b, s.offset);
        b.append(",\"elapsed\":");
        num(b, s.elapsed);
        b.append(",\"error\":");
        str(b, s.error);
        b.append('}');
      }
    }
    b.append("]}");
  }

  static void str(StringBuilder b, String s) {
    if (s == null) {
      b.append("null");
      return;
    }
    b.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"') b.append("\\\"");
      else if (c == '\\') b.append("\\\\");
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    b.append('"');
  }

  static void num(StringBuilder b, double d) {
    b.append(Double.isNaN(d) || Double.isInfinite(d) ? 0 : d);
  }
}
```

`agent-java/src/apm/RequestAdvice.java`:

```java
package apm;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import net.bytebuddy.asm.Advice;

// Tomcat StandardHostValve.invoke(Request, Response)의 앞뒤. 이 메서드들의 몸체가 대상 메서드 안으로 복사된다.
// HttpServlet.service보다 바깥이라 Spring Security 필터 시간까지 응답시간에 들어간다.
public final class RequestAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Tx enter(@Advice.Argument(0) HttpServletRequest req) {
    return Tracer.begin(req.getMethod(), req.getRequestURI());
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Tx tx, @Advice.Argument(1) HttpServletResponse res,
      @Advice.Thrown Throwable thrown) {
    Tracer.end(tx, thrown != null ? 500 : res.getStatus());
  }
}
```

`agent-java/src/apm/Agent.java`를 다음으로 바꾼다:

```java
package apm;

import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

import java.lang.instrument.Instrumentation;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.utility.JavaModule;

// 미니 APM Java 에이전트. `-javaagent:mini-apm-agent.jar`로 앱의 main보다 먼저 실행된다.
// JENNIFER의 -javaagent처럼, 앱 클래스가 로드될 때 바이트코드에 계측 코드를 끼워 넣는다.
public final class Agent {
  public static void premain(String args, Instrumentation inst) {
    Tracer.collector = env("APM_COLLECTOR", Tracer.collector);
    Tracer.agent = env("APM_AGENT", Tracer.agent);
    long interval = 1000;
    try {
      interval = Long.parseLong(env("APM_INTERVAL", "1000"));
    } catch (NumberFormatException ignored) {
      // 기본값을 쓴다
    }
    System.out.println("[apm] mini-apm agent → " + Tracer.collector + " (" + Tracer.agent + ")");

    new AgentBuilder.Default()
        .with(new AgentBuilder.Listener.Adapter() {
          @Override
          public void onError(String type, ClassLoader loader, JavaModule module, boolean loaded, Throwable t) {
            // ponytail: 대상인지 이름으로만 거른다. 하위 타입 판정 중 무관한 클래스에서 나는 오류는 숨긴다.
            if (type.endsWith("StandardHostValve") || type.contains("Statement") || type.contains("Connection")) {
              System.err.println("[apm] 계측 실패: " + type + " " + t);
            }
          }
        })
        .type(named("org.apache.catalina.core.StandardHostValve"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(RequestAdvice.class).on(named("invoke").and(takesArguments(2)))))
        .installOn(inst);

    Tracer.startSender(interval);
  }

  private static String env(String key, String def) {
    String v = System.getenv(key);
    return v == null || v.isEmpty() ? def : v;
  }
}
```

- [ ] **Step 4: 테스트 실행, 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS 7/7

- [ ] **Step 5: 전체 테스트, 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 27/27 pass

```bash
git add agent-java/src test/java-agent.test.js
git commit -m "feat: Java agent records Tomcat requests and sends them to the collector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: SQL 구간

**Files:**
- Create: `agent-java/src/apm/SqlAdvice.java`
- Create: `agent-java/src/apm/PrepareAdvice.java`
- Modify: `agent-java/src/apm/Tracer.java` (SQL 메서드 추가)
- Modify: `agent-java/src/apm/Agent.java` (계측 대상 두 개 추가)
- Modify: `test/java-agent.test.js` (테스트 추가)

**Interfaces:**
- Consumes: Task 2의 `Tracer.Tx`, `Tracer.Span`, `CURRENT`, `MAX_SPANS`, `MAX_SQL`, `ms()`, 그리고 helper `get`, `waitTx`.
- Produces:
  - `public static Tracer.Span sqlStart(Object stmt, Object[] args)`: 기록하지 않으면 `null`을 돌려준다. 깊이는 항상 1 올린다.
  - `public static void sqlEnd(Tracer.Span s, Throwable thrown)`: 깊이를 항상 1 내린다.
  - `public static void remember(Object stmt, String sql)`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/java-agent.test.js`의 `describe` 안 마지막에 추가한다:

```js
  test('PreparedStatement 실행이 SQL 구간 하나로 기록되고 문장은 공백이 정리된다', async () => {
    assert.equal(await get('/ok'), 200);
    const tx = await waitTx('GET /ok');
    assert.equal(tx.status, 200);
    assert.equal(tx.spans.length, 1);
    const [s] = tx.spans;
    assert.equal(s.type, 'sql');
    assert.equal(s.text, `select name from item where id = ? and name <> 'q"\\'`);
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

  test('요청 밖에서 실행된 SQL(기동 시 create table)은 어디에도 기록되지 않는다', () => {
    for (const p of store.points(0)) {
      for (const s of store.get(p.id).spans) assert.doesNotMatch(s.text, /create table|insert into/);
    }
  });
```

- [ ] **Step 2: 테스트 실행, 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: FAIL. 처음 두 테스트에서 `tx.spans.length`가 기대한 1이 아니라 0으로 나온다. 세 번째 테스트는 통과한다. 지금은 구간이 하나도 없어서 이 테스트는 다음 단계에서 퇴행만 막는 역할이다.

- [ ] **Step 3: SQL 계측 작성**

`Tracer.java`의 `private static boolean failing;` 다음 줄에 추가한다:

```java
  // SQL은 Hikari 프록시 → log4jdbc → 드라이버로 겹쳐 불린다. 가장 바깥 호출만 기록하려고 스레드별 깊이를 센다.
  private static final ThreadLocal<int[]> DEPTH = ThreadLocal.withInitial(() -> new int[1]);
  // PreparedStatement는 SQL을 꺼낼 방법이 없어서, prepareStatement 때 문장 객체와 SQL을 묶어 둔다.
  private static final Map<Object, String> SQL = Collections.synchronizedMap(new WeakHashMap<Object, String>());
```

import에 `import java.util.WeakHashMap;`을 추가한다.

`Tracer.java`의 `public static void startSender` 바로 앞에 추가한다:

```java
  public static void remember(Object stmt, String sql) {
    if (stmt != null && sql != null) SQL.put(stmt, sql);
  }

  public static Span sqlStart(Object stmt, Object[] args) {
    int[] depth = DEPTH.get();
    if (depth[0]++ > 0) return null;
    try {
      Tx tx = CURRENT.get();
      if (tx == null) return null; // 요청 밖의 SQL
      if (tx.spans.size() >= MAX_SPANS) {
        tx.dropped++;
        return null;
      }
      String sql = args.length > 0 && args[0] instanceof String ? (String) args[0] : SQL.get(stmt);
      Span s = new Span(sql == null ? "?" : normalize(sql), ms(System.nanoTime() - tx.t0));
      tx.spans.add(s);
      return s;
    } catch (Throwable t) {
      return null;
    }
  }

  public static void sqlEnd(Span s, Throwable thrown) {
    DEPTH.get()[0]--;
    if (s == null) return;
    s.elapsed = ms(System.nanoTime() - s.t0);
    if (thrown != null) s.error = thrown.getMessage() != null ? thrown.getMessage() : thrown.getClass().getName();
  }

  static String normalize(String sql) {
    String s = sql.replaceAll("\\s+", " ").trim();
    return s.length() > MAX_SQL ? s.substring(0, MAX_SQL) : s;
  }
```

`agent-java/src/apm/SqlAdvice.java`:

```java
package apm;

import net.bytebuddy.asm.Advice;

// Statement/PreparedStatement의 execute* 앞뒤. 깊이 카운터 때문에 sqlStart를 불렀으면 sqlEnd도 반드시 불린다.
public final class SqlAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This Object stmt, @Advice.AllArguments Object[] args) {
    return Tracer.sqlStart(stmt, args);
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.sqlEnd(span, thrown);
  }
}
```

`agent-java/src/apm/PrepareAdvice.java`:

```java
package apm;

import net.bytebuddy.asm.Advice;

// Connection.prepareStatement(String, ...)/prepareCall(String, ...)의 뒤. 돌려준 문장 객체에 SQL을 묶어 둔다.
// Hikari·log4jdbc 프록시 연결도 계측되므로, 앱이 받는 가장 바깥 문장 객체도 맵에 들어간다.
public final class PrepareAdvice {
  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(@Advice.Argument(0) String sql, @Advice.Return Object stmt) {
    Tracer.remember(stmt, sql);
  }
}
```

`Agent.java`의 static import를 다음으로 바꾼다:

```java
import static net.bytebuddy.matcher.ElementMatchers.isAbstract;
import static net.bytebuddy.matcher.ElementMatchers.isInterface;
import static net.bytebuddy.matcher.ElementMatchers.isSubTypeOf;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
import static net.bytebuddy.matcher.ElementMatchers.not;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;
```

일반 import에 `import java.sql.Connection;`, `import java.sql.Statement;`를 추가한다.

`Agent.java`의 `.installOn(inst);` 바로 앞에 추가한다:

```java
        // 추상 클래스도 포함한다. Hikari의 ProxyPreparedStatement·ProxyConnection은 추상 클래스지만 실행 메서드를 직접 구현한다.
        .type(isSubTypeOf(Statement.class).and(not(isInterface())))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(SqlAdvice.class).on(not(isAbstract()).and(namedOneOf(
                "execute", "executeQuery", "executeUpdate", "executeBatch", "executeLargeUpdate", "executeLargeBatch")))))
        .type(isSubTypeOf(Connection.class).and(not(isInterface())))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(PrepareAdvice.class).on(not(isAbstract())
                .and(namedOneOf("prepareStatement", "prepareCall")).and(takesArgument(0, String.class)))))
```

- [ ] **Step 4: 테스트 실행, 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS 10/10. stderr에 `[apm] 계측 실패`가 없어야 한다. 있으면 원인을 찾는다.

- [ ] **Step 5: 전체 테스트, 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 30/30 pass

```bash
git add agent-java/src test/java-agent.test.js
git commit -m "feat: Java agent records outermost JDBC calls as SQL spans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: README, 그리고 IP-Finance에서 직접 확인

**Files:**
- Modify: `README.md` (`## 다음 학습 후보` 바로 앞에 섹션 추가, 4번째 줄 문구 수정)

**Interfaces:**
- Consumes: Task 1의 `npm run build:java`, Task 1~3의 jar 동작.

- [ ] **Step 1: README 수정**

4번째 줄을 다음 문구로 바꾼다.
- 기존: `Node 22 기본 기능만 쓴다(외부 라이브러리 없음).`
- 새 문구: `Node 22 기본 기능만 쓴다(외부 라이브러리 없음). Java 에이전트만 Byte Buddy를 jar에 담아 쓴다.`

`## 다음 학습 후보` 바로 앞에 추가한다:

````markdown
## Java 에이전트 (`agent-java/`)

같은 수집 서버·대시보드를 Java 앱에 붙인다.
- `-javaagent`로 앱 소스를 고치지 않고, 클래스가 로드될 때 바이트코드에 계측 코드를 끼워 넣는다. JENNIFER와 같은 방식이다.
- 대상은 Java 8 이상의 내장 Tomcat 앱(Spring Boot 2.x)이다.

```powershell
npm run build:java        # agent-java/dist/mini-apm-agent.jar
node collector/server.js  # 수집 서버만 따로 띄울 때
```

Eclipse 실행 설정(Run Configurations → 해당 Application)에 두 가지를 넣는다.
- **Arguments → VM arguments**: `-javaagent:C:/Users/jjshs/mini-apm/agent-java/dist/mini-apm-agent.jar`
- **Environment**: `APM_AGENT=ipfinance` (대시보드에 표시될 이름)

앱 콘솔에 `[apm] mini-apm agent → ...` 한 줄이 보이면 붙은 것이다.

빌드는 JDK 8(`APM_JAVA_HOME`)과 Byte Buddy 1.10.20(`APM_BYTEBUDDY_JAR`)을 쓴다. 기본값은 `D:\AnyBuilder` 아래 경로다.

| 에이전트 | JENNIFER | 여기서 배우는 것 |
|---|---|---|
| `Agent.premain` | `-javaagent` | 앱 main보다 먼저 실행되는 진입점 |
| `RequestAdvice` → `StandardHostValve.invoke` | 서블릿 트랜잭션 계측 | 어느 지점을 감싸야 필터 시간까지 잡히는가 |
| `SqlAdvice` + 깊이 카운터 | JDBC 계측 | 커넥션 풀·로깅 프록시가 겹쳐도 SQL 하나를 한 번만 세는 법 |
| `PrepareAdvice` | SQL 문장 수집 | `PreparedStatement`에서 SQL을 얻으려면 만들 때 잡아야 한다 |

### Java 에이전트의 한계
- **비동기 컨트롤러**: `DeferredResult`나 `CompletableFuture`를 반환하는 컨트롤러는 처리 스레드가 바뀐다. 그러면 SQL 구간을 놓친다. 트랜잭션은 스레드에 붙어 있기 때문이다.
- **외부 호출**: `HttpURLConnection`, OkHttp는 계측하지 않는다. 그 시간은 "앱 자체 처리"에 섞인다.
- **정적 파일 판단**: 확장자(`js css png jpg gif svg ico woff woff2 map`)로만 판단한다.
- **요청 밖의 SQL**: Quartz 배치처럼 요청 밖에서 도는 SQL은 기록하지 않는다.
````

- [ ] **Step 2: 전체 테스트**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 30/30 pass

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs: how to attach the Java agent and its limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: jar 빌드**

Run: `fnm exec --using=22 node agent-java/build.js`
Expected: `...agent-java\dist\mini-apm-agent.jar`

- [ ] **Step 5: IP-Finance 직접 확인 (사람이 한다)**

Eclipse 실행 설정은 사람이 넣는다. 결과를 받아 다음을 확인한다.
1. 앱 콘솔에 `[apm] mini-apm agent → http://localhost:7700 (ipfinance)`가 보이고, `[apm] 계측 실패`는 없다.
2. 화면 몇 개를 누르면 X-View에 점이 찍히고, 정적 파일 점은 없다.
3. 점을 눌렀을 때 상세 화면에 SQL 구간이 보인다.
   - **SQL 하나가 막대 하나다.** 같은 문장이 같은 시각에 두세 번 나오면 깊이 카운터가 겹 사이에서 끊긴 것이다. 이때는 systematic-debugging으로 조사한다.
   - 문장이 `?`로만 나오면 `PrepareAdvice`가 바깥 객체를 놓친 것이다.
