# 처리 중 요청의 현재 위치 + Java 외부 HTTP 구간 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 처리 중 목록에 요청 스레드의 현재 앱 메서드(`where`)를 보이고, Java 에이전트가 `HttpURLConnection`·OkHttp 동기 호출을 `http` 구간으로 기록한다.

**Architecture:** 전송 스레드가 처리 중 트랜잭션마다 요청 스레드의 스택을 읽어 `where`를 만든다. `Tracer`를 별도 `mini-apm-boot.jar`로 빼서 `Boot-Class-Path`로 부트스트랩 로더에 올리고, 두 번째 `AgentBuilder`가 JDK의 `sun.net.www.protocol.http.HttpURLConnection.getInputStream()`을 계측한다. OkHttp는 기존 빌더에 `RealCall.execute()`를 추가한다.

**Tech Stack:** Java 8(javac/jar, JDK `D:/AnyBuilder/bin/java/jdk1.8.0_102-x64`), Byte Buddy 1.10.20, Node 22 `node:test`, OkHttp 3.14.9 + okio 1.17.2(로컬 Maven 저장소).

**Spec:** `docs/superpowers/specs/2026-10-19-active-where-http-design.md`

## Global Constraints

- 대상 앱과 `D:\AnyBuilder` 아래는 아무것도 고치지 않는다. Eclipse 설정의 `-javaagent:` 한 줄은 그대로 쓸 수 있어야 한다.
- Java 소스는 `-source 8 -target 8`. Maven을 쓰지 않는다(`agent-java/build.js`).
- `Tracer`는 OkHttp·Byte Buddy·servlet 타입을 참조하지 않는다(부트스트랩에 올라가므로 `java.*`만).
- 수집 서버(`collector/`)는 바꾸지 않는다.
- 전체 테스트(Git Bash): `fnm exec --using=22 npm.cmd test` — Java 테스트만: `fnm exec --using=22 node --test test/java-agent.test.js`
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. Spring Boot devtools의 RestartClassLoader가 다시 올린 앱에서도 `Tracer`가 부트스트랩의 한 벌만 쓰여, 요청·SQL·HTTP가 같은 트랜잭션에 모인다(자동 테스트 없음, IP-Finance로 사람이 확인).
2. WTP 외부 Tomcat(EVL의 `KIPA_EVL_MANAGE.launch`)에서 웹앱 클래스로더가 부트스트랩의 `apm.Tracer`를 찾는다.
3. 고정 길이 스트리밍 POST(`setFixedLengthStreamingMode`)처럼 연결이 `getOutputStream()`에서 일어나는 호출도 구간 하나로, 응답 대기 시간만 잡힌다.
4. `getInputStream()` 안의 리다이렉트·인증 재시도도 깊이 카운터 덕에 구간 하나다.
5. `where`의 앱 패키지 자동 판단(`sun.java.command`)이 `-jar app.jar`, Tomcat Bootstrap, 패키지 없는 main에서 `없음`이 된다(`mainPackage` 분기, 자동 테스트 없음).

---

## File Structure

- `agent-java/src/apm/Tracer.java` — `Tx.thread`, `appPackage`, `where()`, `Span.type`, `httpStart/httpEnd`, JSON의 `type`·`where`.
- `agent-java/src/apm/Agent.java` — 앱 패키지 결정, 기동 안내 줄, OkHttp 변환 추가, `HttpURLConnection`용 두 번째 빌더.
- `agent-java/src/apm/HttpAdvice.java` (새 파일) — `HttpURLConnection.getInputStream()` 앞뒤.
- `agent-java/src/apm/OkHttpAdvice.java` (새 파일) — `RealCall.execute()` 앞뒤.
- `agent-java/build.js` — 부트 jar 분리, `Boot-Class-Path`, OkHttp 컴파일 클래스패스.
- `agent-java/test/TestApp.java` — 두 번째 인자(가짜 서버 주소), `/http`, `/okhttp`.
- `test/java-agent.test.js` — 가짜 서버, `APM_APP_PACKAGE`, 새 테스트.
- `dashboard/app.mjs` — 처리 중 목록에 `where` 줄.
- `README.md` — 새 기능, `APM_APP_PACKAGE`, jar 두 개, 한계 갱신.

---

### Task 1: 현재 위치(`where`)

**Files:**
- Modify: `agent-java/src/apm/Tracer.java` (`Tx`, 필드, `active()`)
- Modify: `agent-java/src/apm/Agent.java` (`premain` 앞부분, `env` 아래)
- Modify: `dashboard/app.mjs` (`showActive`)
- Test: `test/java-agent.test.js`

**Interfaces:**
- Produces: `Tracer.appPackage`(public static String, 클래스 이름 접두어 또는 null), `Tracer.where(StackTraceElement[]) → String|null`, 처리 중 항목 JSON 필드 `"where"`, `Agent.mainPackage(String) → String|null`.

- [ ] **Step 1: 테스트 수정·추가**

`test/java-agent.test.js`의 `startApp` 환경변수에 `APM_APP_PACKAGE`를 넣는다.

```js
  ], { env: { ...process.env, APM_COLLECTOR: collectorUrl, APM_AGENT: 'test', APM_INTERVAL: '200', APM_APP_PACKAGE: 'TestApp' } });
```

첫 테스트의 기대 문자열을 바꾼다.

```js
  test('기동하면 에이전트 안내 한 줄이 출력된다', () => {
    assert.ok(app.stdout.includes(`[apm] mini-apm agent → ${collectorUrl} (test, 앱 패키지 TestApp)`), app.stdout);
  });
```

`'처리 중인 요청이 수집 서버의 처리 중 목록에 보인다'` 테스트 바로 아래에 추가한다.

```js
  test('처리 중인 요청에 지금 실행 중인 앱 메서드와 맨 위 프레임이 보인다', async () => {
    const res = get('/slow');
    const item = await waitFor(
      () => store.active().find((a) => a.name === 'GET /slow' && /sleep/.test(a.where ?? '')), '현재 위치', 5000);
    assert.match(item.where, /^TestApp\$1\.doGet:\d+ → Thread\.sleep$/);
    assert.equal(await res, 200);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: FAIL 2개 — 안내 줄 테스트(`(test)`만 출력), 현재 위치 테스트(`현재 위치: 시간 초과`). 나머지는 통과.

- [ ] **Step 3: Tracer 구현**

`Tx`에 필드를 추가한다(`final long t0 ...` 아래).

```java
    final Thread thread = Thread.currentThread(); // begin은 요청 스레드에서 불린다. 처리 중 위치를 읽을 때 쓴다
```

`public static String agent = "java";` 아래에 추가한다.

```java
  public static String appPackage; // 앱 클래스 이름 접두어(예: org.kipa.ipfinance.). null이면 모른다
```

`active()`에서 `lastSpan` 다음에 `where`를 쓴다.

```java
      b.append(",\"lastSpan\":");
      str(b, last);
      b.append(",\"where\":");
      str(b, where(t.thread.getStackTrace()));
      b.append('}');
```

`active()` 바로 위에 추가한다.

```java
  // 처리 중 요청이 지금 어디서 멈춰 있는지: 첫 앱 프레임(줄 번호 포함)과, 다르면 맨 위 프레임.
  // 예: EvlServiceImpl.selectList:120 → SocketInputStream.socketRead0
  static String where(StackTraceElement[] st) {
    if (st.length == 0) return null;
    StackTraceElement app = null;
    if (appPackage != null) {
      for (StackTraceElement e : st) {
        String c = e.getClassName();
        if (c.startsWith(appPackage) && !c.contains("$$")) { // $$: CGLIB 프록시
          app = e;
          break;
        }
      }
    }
    String top = simple(st[0]);
    if (app == null) return top;
    String a = simple(app) + ":" + app.getLineNumber();
    return app == st[0] ? a : a + " → " + top;
  }

  static String simple(StackTraceElement e) {
    String c = e.getClassName();
    return c.substring(c.lastIndexOf('.') + 1) + "." + e.getMethodName();
  }
```

- [ ] **Step 4: Agent 구현**

`premain`의 `Tracer.agent = ...` 아래에 추가하고, 안내 줄을 바꾼다.

```java
    Tracer.appPackage = env("APM_APP_PACKAGE", mainPackage(System.getProperty("sun.java.command")));
```

```java
    System.out.println("[apm] mini-apm agent → " + Tracer.collector + " (" + Tracer.agent + ", 앱 패키지 "
        + (Tracer.appPackage == null ? "없음" : Tracer.appPackage) + ")");
```

`env(...)` 아래에 추가한다.

```java
  // main 클래스의 패키지 + '.'. Tomcat Bootstrap, fat jar 런처, -jar, 패키지 없는 main이면 모른다(null).
  static String mainPackage(String command) {
    if (command == null || command.trim().isEmpty()) return null;
    String main = command.trim().split("\\s+")[0];
    int dot = main.lastIndexOf('.');
    if (dot < 0 || main.endsWith(".jar") || main.startsWith("org.apache.")
        || main.startsWith("org.springframework.boot.loader.")) return null;
    return main.substring(0, dot + 1);
  }
```

- [ ] **Step 5: 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS 전부(테스트 13개).

- [ ] **Step 6: 대시보드에 `where` 줄**

`dashboard/app.mjs`의 `showActive`에서 `if (a.lastSpan) { ... }` 블록을 아래로 바꾸고, 위 주석을 고친다.

```js
  // 좁은 패널이라 ① 이름·시간 ② 현재 위치 ③ 마지막 호출을 각각 한 줄로. 넘치면 …로 자르고 전체는 툴팁으로.
```

```js
    for (const text of [a.where, a.lastSpan]) {
      if (!text) continue;
      const sub = row('td', [text]);
      sub.className = `sub ${level}`;
      sub.firstChild.colSpan = 2;
      sub.firstChild.className = 'ell';
      sub.firstChild.title = text;
      table.append(sub);
    }
```

화면 확인(버리는 스크립트): 스크래치패드의 `active-shot.cjs`처럼 수집 서버를 띄우고 `/ingest`에 `where: 'EvlServiceImpl.selectList:120 → SocketInputStream.socketRead0'`가 있는 처리 중 항목을 보낸 뒤 `#active`를 찍어, 요청 하나가 세 줄(이름·시간 / 위치 / SQL)로 가로로 나오는지 본다.

- [ ] **Step 7: 전체 테스트 후 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 테스트 34개 통과.

```bash
git add agent-java/src/apm/Tracer.java agent-java/src/apm/Agent.java dashboard/app.mjs test/java-agent.test.js
git commit -m "feat: show where each active request is running (app frame and top frame)"
```

---

### Task 2: `HttpURLConnection` 외부 구간 + 부트 jar

**Files:**
- Create: `agent-java/src/apm/HttpAdvice.java`
- Modify: `agent-java/src/apm/Tracer.java` (`Span`, `sqlStart/sqlEnd`, JSON)
- Modify: `agent-java/src/apm/Agent.java` (리스너 변수, 두 번째 빌더)
- Modify: `agent-java/build.js`
- Modify: `agent-java/test/TestApp.java`
- Test: `test/java-agent.test.js`

**Interfaces:**
- Consumes: Task 1의 `Tracer` 구조.
- Produces: `Tracer.Span(String type, String text, double offset)`, `public static Span httpStart(String method, String url)`(url이 null이면 기록하지 않고 깊이만 센다), `public static void httpEnd(Span s, int code, Throwable thrown)`(code 모르면 -1), `TestApp`의 두 번째 인자 = 가짜 서버 주소(`http://127.0.0.1:<port>`), 테스트의 `stubUrl`.

- [ ] **Step 1: 테스트 — 가짜 서버와 `/http` 테스트**

`test/java-agent.test.js` 위쪽 require에 추가한다.

```js
const http = require('node:http');
```

`describe` 안의 변수 줄과 `before`/`after`를 바꾼다.

```js
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
    app = await startApp(collectorUrl);
  });
  after(() => {
    app?.proc.kill();
    collector?.close();
    stub?.close();
  });
```

`startApp`은 `describe` 밖에 있으므로 가짜 서버 주소를 인자로 받게 한다.

```js
async function startApp(collectorUrl, stubUrl = '') {
```

```js
    'TestApp', String(port), stubUrl,
```

`before`의 호출을 `app = await startApp(collectorUrl, stubUrl);`로 바꾼다.

`'요청 밖에서 실행된 SQL...'` 테스트 바로 위에 추가한다.

```js
  test('HttpURLConnection 호출이 외부 구간으로 기록되고, 반복 호출·https 위임에도 호출당 하나다', async () => {
    assert.equal(await get('/http'), 200);
    const tx = await waitTx('GET /http');
    assert.deepEqual(tx.spans.map((s) => s.type), ['http', 'http', 'http', 'http']);
    const [ok, err, nf, dead] = tx.spans;
    assert.deepEqual([ok.text, ok.error], [`GET ${stubUrl}/ok`, null]);
    assert.deepEqual([err.text, err.error], [`GET ${stubUrl}/err`, 'HTTP 500']);
    assert.deepEqual([nf.text, nf.error], [`GET ${stubUrl}/nf`, null]); // 4xx는 에러가 아니다
    assert.match(dead.text, /^GET https:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(dead.error, /Connection refused/);
    assert.ok(ok.offset >= 0 && ok.elapsed >= 0);
  });
```

- [ ] **Step 2: TestApp — `/http`**

import에 추가한다.

```java
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
```

`main`의 `int port = ...` 아래에 추가한다.

```java
    String stub = args.length > 1 ? args[1] : ""; // 외부 호출 대상(Node 테스트의 가짜 서버)
```

`switch`에 `/slow` 앞으로 추가한다.

```java
            case "/http":
              call(stub + "/ok", true);   // 코드 먼저, 그다음 본문
              call(stub + "/err", false); // 본문 먼저 → 500 예외 → 코드 확인
              call(stub + "/nf", true);   // 404
              call("https://127.0.0.1:" + deadPort() + "/", false); // 연결 실패, https 위임 객체
              break;
```

`main` 아래에 추가한다.

```java
  // 앱에서 흔한 두 순서: 코드를 먼저 보고 본문 열기, 본문을 먼저 열고 실패하면 코드 보기. 어느 쪽이든 구간은 하나여야 한다.
  static void call(String url, boolean codeFirst) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(2000);
      if (codeFirst && c.getResponseCode() >= 400) return;
      c.getInputStream().close();
    } catch (IOException e) {
      try {
        if (c != null) c.getResponseCode();
      } catch (IOException ignored) {
        // 연결 실패
      }
    }
  }

  static int deadPort() throws IOException {
    try (ServerSocket s = new ServerSocket(0)) {
      return s.getLocalPort(); // 닫고 돌려주므로 연결하면 거절된다
    }
  }
```

`doGet`의 `catch (SQLException | InterruptedException e)`는 그대로 둔다(`deadPort`의 `IOException`은 `doGet`이 이미 던진다).

- [ ] **Step 3: 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: FAIL 1개 — 새 테스트, `tx.spans`가 `[]`. 나머지는 통과.

- [ ] **Step 4: Tracer — 구간 종류와 HTTP API**

`Span`에 `type`을 넣는다.

```java
  public static final class Span {
    final String type; // "sql" 또는 "http"
    final String text;
    final long t0 = System.nanoTime();
    final double offset;
    double elapsed;
    String error;

    Span(String type, String text, double offset) {
      this.type = type;
      this.text = text;
      this.offset = offset;
    }
  }
```

`sqlStart`/`sqlEnd`를 공통 부분으로 나누고 HTTP를 추가한다. `DEPTH` 주석의 첫 문장 뒤에 `외부 호출과 SQL은 서로 겹쳐 불리지 않으므로 같은 카운터를 쓴다.`를 붙인다.

```java
  // 바깥 호출이고 요청 안이면 지금 트랜잭션을, 아니면 null. 깊이는 늘 올리고 짝이 되는 *End가 내린다.
  private static Tx outer() {
    if (DEPTH.get()[0]++ > 0) return null;
    Tx tx = CURRENT.get();
    if (tx != null && tx.spans.size() >= MAX_SPANS) {
      tx.dropped++;
      return null;
    }
    return tx;
  }

  private static Span open(Tx tx, String type, String text) {
    Span s = new Span(type, text, ms(System.nanoTime() - tx.t0));
    tx.spans.add(s);
    return s;
  }

  private static void close(Span s, String error) {
    DEPTH.get()[0]--;
    if (s == null) return;
    s.elapsed = ms(System.nanoTime() - s.t0);
    s.error = error;
  }

  static String message(Throwable t) {
    return t.getMessage() != null ? t.getMessage() : t.getClass().getName();
  }

  public static Span sqlStart(Object stmt, Object[] args) {
    try {
      Tx tx = outer();
      if (tx == null) return null; // 겹친 호출, 요청 밖의 SQL
      String sql;
      if (args.length > 0 && args[0] instanceof String) {
        sql = (String) args[0];
      } else {
        sql = SQL.get(stmt);
        Map<Integer, String> params = PARAMS.get(stmt);
        if (sql != null && params != null) sql = fill(sql, params);
      }
      return open(tx, "sql", sql == null ? "?" : normalize(sql));
    } catch (Throwable t) {
      return null;
    }
  }

  public static void sqlEnd(Span s, Throwable thrown) {
    close(s, thrown != null ? message(thrown) : null);
  }

  // url이 null이면 이미 응답을 받은 연결의 반복 호출이라 기록하지 않는다(깊이는 센다).
  public static Span httpStart(String method, String url) {
    try {
      Tx tx = outer();
      if (tx == null || url == null) return null;
      String text = method + " " + url;
      return open(tx, "http", text.length() > MAX_SQL ? text.substring(0, MAX_SQL) : text);
    } catch (Throwable t) {
      return null;
    }
  }

  // code: 응답 코드, 모르면 -1. 4xx는 Node 에이전트처럼 에러로 보지 않는다.
  public static void httpEnd(Span s, int code, Throwable thrown) {
    close(s, code >= 500 ? "HTTP " + code : code < 0 && thrown != null ? message(thrown) : null);
  }
```

주의: `outer()`의 `DEPTH` 증가는 `try` 안에 있지만 예외를 던질 수 있는 코드 앞이라 짝이 맞는다.

`tx(...)`의 구간 JSON 첫 줄을 바꾼다.

```java
        StringBuilder one = new StringBuilder(s.text.length() + 80).append("{\"type\":");
        str(one, s.type);
        one.append(",\"text\":");
        str(one, s.text);
```

- [ ] **Step 5: HttpAdvice**

`agent-java/src/apm/HttpAdvice.java`:

```java
package apm;

import java.io.InputStream;
import java.net.HttpURLConnection;
import net.bytebuddy.asm.Advice;

// JDK의 sun.net.www.protocol.http.HttpURLConnection.getInputStream() 앞뒤. 연결·요청 전송·응답 헤더 대기가 이 안에서 일어난다.
// getResponseCode()도 이 메서드를 거치고, https는 이 클래스를 상속한 위임 객체가 부른다.
public final class HttpAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This HttpURLConnection c,
      @Advice.FieldValue("inputStream") InputStream cached,
      @Advice.FieldValue("rememberedException") Exception remembered) {
    // 이미 응답을 받았거나 실패한 연결은 저장해 둔 결과를 돌려줄 뿐이라 기록하지 않는다
    boolean repeat = cached != null || remembered != null;
    return Tracer.httpStart(c.getRequestMethod(), repeat ? null : String.valueOf(c.getURL()));
  }

  // 응답 코드는 필드에서 읽는다. getResponseCode()를 다시 부르면 실패한 연결을 재시도할 수 있다.
  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.FieldValue("responseCode") int code,
      @Advice.Thrown Throwable thrown) {
    Tracer.httpEnd(span, code, thrown);
  }
}
```

필드 이름은 JDK 8의 `sun.net.www.protocol.http.HttpURLConnection`(`inputStream`, `rememberedException`)과 `java.net.HttpURLConnection`(`responseCode`) 것이다. 다르면 계측 실패가 `[apm] 계측 실패: ...HttpURLConnection`로 찍힌다. 그때는 `javap -p -cp <JDK>/jre/lib/rt.jar sun.net.www.protocol.http.HttpURLConnection`으로 이름을 확인하고 Ruling으로 남긴다.

- [ ] **Step 6: Agent — 두 번째 빌더**

import에 추가한다.

```java
import static net.bytebuddy.matcher.ElementMatchers.none;
```

`premain`에서 기존 리스너를 변수로 빼고(두 빌더가 같이 쓴다), 이름 필터에 `HttpURLConnection`을 넣는다.

```java
    AgentBuilder.Listener errors = new AgentBuilder.Listener.Adapter() {
      @Override
      public void onError(String type, ClassLoader loader, JavaModule module, boolean loaded, Throwable t) {
        // ponytail: 대상인지 이름으로만 거른다. 하위 타입 판정 중 무관한 클래스에서 나는 오류는 숨긴다.
        if (type.endsWith("StandardHostValve") || type.contains("Statement") || type.contains("Connection")) {
          System.err.println("[apm] 계측 실패: " + type + " " + t);
        }
      }
    };

    new AgentBuilder.Default()
        .with(errors)
```

(`type.contains("Connection")`이 `HttpURLConnection`도 덮으므로 필터 조건은 그대로 둔다.)

기존 빌더의 `.installOn(inst);` 뒤, `Tracer.startSender(interval);` 앞에 추가한다.

```java
    // JDK의 HttpURLConnection은 부트스트랩 로더가 올린다. 기본 무시 규칙(부트스트랩 제외)을 풀고 이름이 같은 이 클래스 하나만,
    // 이미 로드됐어도 다시 변환한다. 위 빌더와 나눠서 SQL 쪽 매칭(MyBatis 부트스트랩 프록시 제외)은 그대로 둔다.
    // Advice가 부르는 Tracer는 Boot-Class-Path(mini-apm-boot.jar)로 부트스트랩에서 보인다.
    new AgentBuilder.Default()
        .disableClassFormatChanges()
        .ignore(none())
        .with(errors)
        .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
        .type(named("sun.net.www.protocol.http.HttpURLConnection"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(HttpAdvice.class).on(named("getInputStream").and(takesArguments(0)))))
        .installOn(inst);
```

- [ ] **Step 7: build.js — 부트 jar**

상수에 추가한다.

```js
const BOOT_JAR = path.join(__dirname, 'dist', 'mini-apm-boot.jar');
```

`build()`의 `run(javaBin('jar'), ['xf', BYTEBUDDY], CLASSES);` 위에서 Tracer 클래스를 부트 jar로 옮기고, 매니페스트에 `Boot-Class-Path`를 넣는다.

```js
  // Tracer는 부트스트랩 로더에 올린다(JDK의 HttpURLConnection 안에 들어간 계측 코드가 부르므로). 에이전트 jar에서는 뺀다.
  const apm = path.join(CLASSES, 'apm');
  const tracer = fs.readdirSync(apm).filter((f) => /^Tracer(\$.*)?\.class$/.test(f));
  run(javaBin('jar'), ['cf', BOOT_JAR, ...tracer.flatMap((f) => ['-C', CLASSES, `apm/${f}`])]);
  for (const f of tracer) fs.rmSync(path.join(apm, f));
```

```js
  fs.writeFileSync(manifest,
    `Premain-Class: apm.Agent\nCan-Retransform-Classes: true\nBoot-Class-Path: ${path.basename(BOOT_JAR)}\n`);
```

맨 위 주석을 `// Java 에이전트 빌드: Maven 없이 JDK 8의 javac와 jar로 에이전트 jar(Byte Buddy 포함)와 부트 jar(Tracer)를 만든다. 두 jar는 같은 폴더에 둔다.`로 바꾼다.

- [ ] **Step 8: 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS 전부(테스트 14개). 앱 stderr에 `[apm] 계측 실패`가 없어야 한다.

- [ ] **Step 9: 전체 테스트 후 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 테스트 35개 통과.

```bash
git add agent-java/src/apm/Tracer.java agent-java/src/apm/Agent.java agent-java/src/apm/HttpAdvice.java agent-java/build.js agent-java/test/TestApp.java test/java-agent.test.js
git commit -m "feat: record HttpURLConnection calls as http spans (Tracer on the boot class path)"
```

---

### Task 3: OkHttp 외부 구간 + README

**Files:**
- Create: `agent-java/src/apm/OkHttpAdvice.java`
- Modify: `agent-java/src/apm/Agent.java` (기존 빌더에 OkHttp 변환)
- Modify: `agent-java/build.js` (컴파일 클래스패스)
- Modify: `agent-java/test/TestApp.java` (`/okhttp`)
- Modify: `test/java-agent.test.js` (`APP_CP`, 새 테스트)
- Modify: `README.md` (Java 에이전트 절)

**Interfaces:**
- Consumes: Task 2의 `Tracer.httpStart(String, String)`, `Tracer.httpEnd(Span, int, Throwable)`, `stubUrl`, `TestApp`의 `stub`·`deadPort()`.

- [ ] **Step 1: 테스트 — 클래스패스와 `/okhttp` 테스트**

`APP_CP`에 추가한다.

```js
  repoJar('com.squareup.okhttp3', 'okhttp', '3.14.9'),
  repoJar('com.squareup.okio', 'okio', '1.17.2'),
```

HttpURLConnection 테스트 아래에 추가한다.

```js
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
```

- [ ] **Step 2: TestApp — `/okhttp`**

import에 추가한다.

```java
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
```

`switch`의 `/http` 아래에 추가한다.

```java
            case "/okhttp":
              OkHttpClient ok = new OkHttpClient();
              for (String u : new String[] {stub + "/ok", stub + "/err", "http://127.0.0.1:" + deadPort() + "/"}) {
                try (Response r = ok.newCall(new Request.Builder().url(u).build()).execute()) {
                  r.code();
                } catch (IOException expected) {
                  // 연결 실패
                }
              }
              break;
```

- [ ] **Step 3: 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: FAIL 1개 — 새 테스트, `tx.spans.length`가 0.

- [ ] **Step 4: OkHttpAdvice와 Agent·build.js**

`agent-java/src/apm/OkHttpAdvice.java`:

```java
package apm;

import net.bytebuddy.asm.Advice;
import okhttp3.Call;
import okhttp3.Response;

// OkHttp RealCall.execute()(동기 호출) 앞뒤. Tracer는 OkHttp 타입을 모르므로 문자열과 응답 코드만 넘긴다.
public final class OkHttpAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This Call call) {
    return Tracer.httpStart(call.request().method(), call.request().url().toString());
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Return Response res, @Advice.Thrown Throwable thrown) {
    Tracer.httpEnd(span, res != null ? res.code() : -1, thrown);
  }
}
```

`Agent`의 기존 빌더에서 `Connection` 변환 다음, `.installOn(inst);` 앞에 추가한다.

```java
        // OkHttp 동기 호출. 3.x는 okhttp3.RealCall, 4.x는 okhttp3.internal.connection.RealCall(4.x는 테스트하지 않음)
        .type(namedOneOf("okhttp3.RealCall", "okhttp3.internal.connection.RealCall"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(OkHttpAdvice.class).on(named("execute").and(takesArguments(0)))))
```

리스너 이름 필터에 `|| type.endsWith("RealCall")`을 붙인다.

`build.js`: `SERVLET` 아래에 추가하고, 존재 확인 목록과 `javac -cp`에 넣는다.

```js
// OkHttpAdvice가 쓰는 OkHttp 타입 때문에 컴파일 때만 쓴다.
const OKHTTP = path.join(REPO, 'com/squareup/okhttp3/okhttp/3.14.9/okhttp-3.14.9.jar');
```

```js
  for (const [what, p] of [['JDK (APM_JAVA_HOME)', javaBin('javac')], ['Byte Buddy (APM_BYTEBUDDY_JAR)', BYTEBUDDY], ['tomcat-embed-core', SERVLET], ['okhttp', OKHTTP]]) {
```

```js
    '-cp', [BYTEBUDDY, SERVLET, OKHTTP].join(path.delimiter), '-d', CLASSES, ...sources]);
```

- [ ] **Step 5: 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS 전부(테스트 15개).

- [ ] **Step 6: README**

`## Java 에이전트` 절에서:
- `npm run build:java` 주석을 `# agent-java/dist/mini-apm-agent.jar + mini-apm-boot.jar (같은 폴더에 둔다)`로.
- **Environment** 항목을 아래로 바꾼다.

```markdown
- **Environment**: `APM_AGENT=ipfinance` (보내는 쪽 이름. 대시보드에는 아직 표시하지 않는다)
- **Environment(선택)**: `APM_APP_PACKAGE=org.kipa.ipfinance.` — 처리 중 목록의 "현재 위치"에서 앱 메서드를 고를 때 쓰는 클래스 이름 접두어. 없으면 main 클래스의 패키지를 쓰고, WTP 외부 Tomcat처럼 main이 Tomcat이면 맨 위 프레임만 보인다.
```

- 안내 줄 문장을 `앱 콘솔에 `[apm] mini-apm agent → ... (ipfinance, 앱 패키지 org.kipa.ipfinance.)` 한 줄이 보이면 붙은 것이다.`로.
- 표에 두 줄 추가.

```markdown
| `HttpAdvice` + `Boot-Class-Path` | 외부 호출 계측 | JDK 클래스에 넣은 계측 코드가 에이전트 클래스를 보려면 부트스트랩 로더에 올려야 한다 |
| 처리 중 목록의 현재 위치 | 액티브 서비스 스택 | 끝나지 않은 요청이 어디서 멈췄는지는 그 스레드의 스택으로 본다 |
```

- 한계의 **외부 호출** 항목을 바꾼다.

```markdown
- **외부 호출**: `HttpURLConnection`(`RestTemplate` 기본 포함)과 OkHttp 동기 호출만 기록한다. OkHttp `enqueue`, Apache HttpClient, WebClient는 "앱 자체 처리"에 섞인다. `HttpURLConnection`은 응답 헤더를 받을 때까지만 재고, 본문을 읽는 시간은 빠진다.
```

- [ ] **Step 7: 전체 테스트, jar 재빌드 확인, 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 테스트 36개 통과. `agent-java/dist/`에 `mini-apm-agent.jar`, `mini-apm-boot.jar` 두 개.

```bash
git add agent-java/src/apm/OkHttpAdvice.java agent-java/src/apm/Agent.java agent-java/build.js agent-java/test/TestApp.java test/java-agent.test.js README.md
git commit -m "feat: record OkHttp sync calls as http spans; document where/http in README"
```
