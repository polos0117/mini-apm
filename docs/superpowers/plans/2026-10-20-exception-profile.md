# 예외 에러 + 트랜잭션 상세 프로파일 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Java 에이전트가 앱이 로그로 남긴 예외를 에러로 기록하고, 트랜잭션 상세에 앱 메서드 흐름·MyBatis SQL ID·요청 정보를 보여 준다.

**Architecture:** 새 Advice 넷(`LogAdvice` Logback, `PrintAdvice` Throwable, `MethodAdvice` 앱 클래스, `MapperAdvice` MyBatis Executor)과
요청 정보 도우미 `RequestInfo`가 문자열만 `Tracer`(부트 jar)에 넘긴다. `Tracer`는 구간에 `depth`를 매기고 요청 끝에 에러를 정한다.
대시보드 상세는 `depth`로 들여쓰고 요청 정보 한 줄을 보인다.

**Tech Stack:** Java 8, Byte Buddy 1.10.20(Advice 인라인), Logback 1.2.3·MyBatis 3.5.6(컴파일 전용), Node 22 `node:test`, Playwright(확인용).

**Spec:** `docs/superpowers/specs/2026-10-20-exception-errors-design.md`, `docs/superpowers/specs/2026-10-20-tx-profile-design.md`

## Global Constraints

- 대상 앱 코드·`D:\AnyBuilder` 아래는 고치지 않는다. 에이전트 jar 두 개(`mini-apm-agent.jar`, `mini-apm-boot.jar`) 구조 그대로.
- `Tracer`는 부트 jar에 있다: Logback·MyBatis·서블릿 타입을 쓰지 않는다. Advice·`RequestInfo`(에이전트 jar)가 문자열로 바꿔 넘긴다.
- Advice는 대상 클래스 안으로 복사되므로 `Tracer`의 **public** 멤버만 부른다(다른 로더라 패키지 접근 불가).
- 계측 코드의 예외는 앱으로 새지 않는다(`suppress = Throwable.class`, `Tracer` 안 try/catch).
- 구간 JSON: `{type, text, offset, elapsed, error, depth}`. 종류 `sql`·`http`·`exception`·`method`·`mapper`.
- 예외 표시 = `단순클래스명: 메시지`(메시지 null이면 `단순클래스명`). 로그 메시지가 null/빈 문자열이면 `(메시지 없음)`.
- 요청 에러: 첫 예외 구간의 `error` → 없고 500 이상이면 마지막 실패 `sql`/`http` 구간 → 없으면 `HTTP <코드>` → 그 밖 null.
- `lastSpan`은 `sql`/`http` 구간만, 1,000자 자름(기존).
- 비밀 파라미터 이름(소문자 포함): `pass`, `pw`, `secret`, `token`, `jumin`, `rrn`, `ssn` → `****`. 값 200자(`...`), 전체 2,000자(`...`).
- 사용자: `SPRING_SECURITY_CONTEXT` → `getAuthentication().getName()`, 없으면 세션 `APM_USER_ATTR`(기본 `loginUser`)의
  `getUserId`/`getUsername`/`getLoginId`/`getId` 처음 있는 것. 세션 없으면 만들지 않는다.
- 대시보드는 `textContent`만. 상세 종류 이름: 메서드·매퍼·SQL·외부·예외. 들여쓰기 `depth × 16px`.
- Java 소스·테스트는 CRLF 파일이다: 고칠 때 Edit 도구를 쓴다(셸 문자열 치환 금지).
- Git Bash: `fnm exec --using=22 npm.cmd test`, Java만 `fnm exec --using=22 node --test test/java-agent.test.js`.
- 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. 실제 Spring Boot 앱에서 `MethodAdvice`가 CGLIB 프록시·devtools 재시작 로더·`@Transactional` 서비스와 함께 한 호출을 한 줄로만 남기는가(테스트 앱엔 Spring이 없다).
2. `java.lang.Throwable` 재변환이 JDK 8에서 앱 기동을 깨지 않는가, 실패해도 `[apm] 계측 실패` 한 줄로 끝나는가.
3. 세션이 무효화된 요청(로그아웃)·`getParameterMap`이 폼 본문을 읽는 POST에서 앱 응답이 바뀌지 않는가 — `RequestInfo.collect`가 모든 예외를 삼키고, 응답이 끝난 뒤 읽는다.
4. 반복문 속 서비스 호출이 구간 한도(1,000)를 먼저 채워 SQL이 "생략"으로 빠지는 경우 — 스펙 범위 밖, 상세 하단 생략 문구로 드러나는지.
5. Logback 이벤트가 요청 스레드가 아닌 곳(비동기 appender 아님: `callAppenders`는 호출 스레드에서 불린다)에서만 오면 기록되지 않는가 — 기동 시 ERROR 로그 테스트(Task 1).

---

### Task 1: 예외 로그를 에러로 (Logback ERROR, printStackTrace)

**Files:**
- Modify: `agent-java/src/apm/Tracer.java` (Span `depth`, `full`, `exception`, `logError`, `printed`, `end` 규칙, JSON `depth`)
- Create: `agent-java/src/apm/LogAdvice.java`, `agent-java/src/apm/PrintAdvice.java`
- Modify: `agent-java/src/apm/Agent.java` (Logback 계측, 두 번째 빌더에 Throwable, 오류 필터)
- Modify: `agent-java/build.js` (컴파일 클래스패스에 Logback·SLF4J)
- Modify: `agent-java/test/TestApp.java`, `test/java-agent.test.js` (클래스패스, 엔드포인트, 테스트)

**Interfaces:**
- Produces (Tracer, public): `exception(String text, String error)`, `logError(String msg, String throwableClass, String throwableMsg)`,
  `printed(String throwableClass, String throwableMsg)`, `static String exceptionText(String className, String msg)`.
  Span 필드 `depth`(int), Tx 필드 `level`(int). `private static boolean full(Tx)`(한도 넘으면 `dropped++` 후 true).

- [ ] **Step 1: 클래스패스와 테스트 앱**

`test/java-agent.test.js`의 `APP_CP`에 추가(derby 줄 앞):

```js
  repoJar('ch.qos.logback', 'logback-classic', '1.2.3'),
  repoJar('ch.qos.logback', 'logback-core', '1.2.3'),
  repoJar('org.slf4j', 'slf4j-api', '1.7.30'),
  repoJar('org.mybatis', 'mybatis', '3.5.6'),
```

`agent-java/test/TestApp.java`:
- import 추가: `import org.slf4j.Logger;`, `import org.slf4j.LoggerFactory;`
- 클래스 첫 줄에 `static final Logger log = LoggerFactory.getLogger(TestApp.class);`
- `main`에서 `Tomcat tomcat = new Tomcat();` 바로 앞에 `log.error("기동 중 에러"); // 요청 밖: 기록되면 안 된다`
- `switch`의 `case "/slow":` 앞에:

```java
            case "/caught": // 잡아서 로그만 남기고 200
              try {
                throw new IllegalStateException("재고 없음");
              } catch (IllegalStateException e) {
                log.error("주문 저장 실패", e);
              }
              break;
            case "/errlog":
              log.error("결재 실패 id={}", 7);
              break;
            case "/printed":
              new IllegalArgumentException("잘못된 값").printStackTrace();
              break;
            case "/warn":
              log.warn("경고", new IllegalStateException("w"));
              break;
            case "/twice":
              log.error("첫째", new RuntimeException("a"));
              log.error("둘째", new RuntimeException("b"));
              break;
```

- [ ] **Step 2: 실패하는 테스트**

`test/java-agent.test.js`의 'SQL 없이 예외로 끝난 요청은 500…' 테스트 뒤에:

```js
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
```

- [ ] **Step 3: 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: 새 테스트 5개 중 '/warn'을 뺀 4개 FAIL(에러 null 또는 예외 구간 없음). 기존 테스트는 통과.

- [ ] **Step 4: `build.js`**

`OKHTTP` 정의 아래:

```js
// LogAdvice·MapperAdvice가 쓰는 Logback·MyBatis 타입 때문에 컴파일 때만 쓴다(SLF4J는 ILoggingEvent가 참조).
const COMPILE_ONLY = [
  'ch/qos/logback/logback-classic/1.2.3/logback-classic-1.2.3.jar',
  'ch/qos/logback/logback-core/1.2.3/logback-core-1.2.3.jar',
  'org/slf4j/slf4j-api/1.7.30/slf4j-api-1.7.30.jar',
  'org/mybatis/mybatis/3.5.6/mybatis-3.5.6.jar',
].map((p) => path.join(REPO, p));
```

`build()`의 존재 검사 배열에 `...COMPILE_ONLY.map((p) => [path.basename(p), p])`를 더하고,
javac `-cp`를 `[BYTEBUDDY, SERVLET, OKHTTP, ...COMPILE_ONLY].join(path.delimiter)`로.
(`const SRC =path.join` 띄어쓰기도 `const SRC = path.join`으로.)

- [ ] **Step 5: `Tracer.java`**

`Span`:

```java
  public static final class Span {
    final String type; // "sql", "http", "exception", "method", "mapper"
    final String text;
    final long t0 = System.nanoTime();
    final double offset;
    final int depth; // 열린 메서드·매퍼 구간 수(들여쓰기)
    double elapsed;
    String error;

    Span(String type, String text, double offset, int depth) {
      this.type = type;
      this.text = text;
      this.offset = offset;
      this.depth = depth;
    }
  }
```

`Tx`에 `int level; // 지금 열린 메서드·매퍼 구간 수` 추가.

`outer()`와 `open()`:

```java
  // 구간 수·글자 수 한도를 넘었으면 개수만 센다
  private static boolean full(Tx tx) {
    if (tx.spans.size() < MAX_SPANS && tx.chars < MAX_BODY) return false;
    tx.dropped++;
    return true;
  }

  // 바깥 호출이고 요청 안이면 지금 트랜잭션을, 아니면 null. 깊이는 늘 올리고 짝이 되는 *End가 내린다.
  private static Tx outer() {
    if (DEPTH.get()[0]++ > 0) return null;
    Tx tx = CURRENT.get();
    return tx == null || full(tx) ? null : tx;
  }

  private static Span open(Tx tx, String type, String text) {
    Span s = new Span(type, text, ms(System.nanoTime() - tx.t0), tx.level);
    tx.chars += text.length();
    tx.spans.add(s);
    return s;
  }

  static String cut(String s) {
    return s != null && s.length() > MAX_SQL ? s.substring(0, MAX_SQL) : s;
  }

  // 예외 표시: 단순클래스명: 메시지
  public static String exceptionText(String className, String msg) {
    String simple = className.substring(className.lastIndexOf('.') + 1);
    return msg == null ? simple : simple + ": " + msg;
  }

  // 앱이 남긴 예외(ERROR 로그, printStackTrace). 요청 밖이면 버린다. SQL 깊이와 상관없이 기록한다.
  public static void exception(String text, String error) {
    try {
      Tx tx = CURRENT.get();
      if (tx == null || full(tx)) return;
      open(tx, "exception", cut(text)).error = cut(error);
    } catch (Throwable ignored) {
      // 앱으로 새지 않게
    }
  }

  // Logback ERROR 이벤트. throwableClass가 null이면 예외 없는 로그
  public static void logError(String msg, String throwableClass, String throwableMsg) {
    String text = msg == null || msg.isEmpty() ? "(메시지 없음)" : msg;
    exception(text, throwableClass == null ? text : exceptionText(throwableClass, throwableMsg));
  }

  public static void printed(String throwableClass, String throwableMsg) {
    exception("printStackTrace()", exceptionText(throwableClass, throwableMsg));
  }
```

`end()`의 에러 판단을 바꾼다:

```java
    tx.status = status;
    synchronized (tx.spans) {
      for (Span s : tx.spans) {
        if ("exception".equals(s.type)) { // 앱이 남긴 첫 예외가 원인에 가깝다
          tx.error = s.error;
          break;
        }
      }
      if (tx.error == null && status >= 500) {
        tx.error = "HTTP " + status;
        for (Span s : tx.spans) { // 마지막으로 실패한 SQL·외부 구간
          if (s.error != null && ("sql".equals(s.type) || "http".equals(s.type))) tx.error = s.error;
        }
      }
    }
```

(기존 `if (status >= 500) { … }` 블록을 위로 바꾼다.)

`tx()`의 구간 JSON에서 `one.append(",\"error\":"); str(one, s.error);` 뒤에 `one.append(",\"depth\":").append(s.depth);`.

- [ ] **Step 6: Advice 둘**

`agent-java/src/apm/LogAdvice.java`:

```java
package apm;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import net.bytebuddy.asm.Advice;

// Logback Logger.callAppenders(이벤트) 앞. 레벨 판단을 통과한 로그만, 한 건당 한 번 불린다. ERROR만 예외로 남긴다.
// Spring Boot가 Tomcat(java.util.logging)의 "처리 안 된 예외" 로그도 Logback으로 넘기므로 그것도 여기로 온다.
public final class LogAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static void enter(@Advice.Argument(0) ILoggingEvent e) {
    if (e.getLevel().toInt() != Level.ERROR_INT) return;
    IThrowableProxy t = e.getThrowableProxy();
    Tracer.logError(e.getFormattedMessage(), t == null ? null : t.getClassName(), t == null ? null : t.getMessage());
  }
}
```

`agent-java/src/apm/PrintAdvice.java`:

```java
package apm;

import net.bytebuddy.asm.Advice;

// JDK Throwable.printStackTrace() 앞. 로거를 거치지 않는 예외 출력도 예외로 남긴다.
public final class PrintAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static void enter(@Advice.This Throwable t) {
    Tracer.printed(t.getClass().getName(), t.getMessage());
  }
}
```

- [ ] **Step 7: `Agent.java`**

오류 필터에 `|| type.endsWith("Executor") || type.equals("ch.qos.logback.classic.Logger") || type.equals("java.lang.Throwable")`를 더한다
(Executor는 Task 2에서 쓴다).

주 빌더의 OkHttp 변환 뒤(`.installOn(inst)` 앞)에:

```java
        // Logback: 레벨 판단을 통과한 로그 이벤트가 appender로 가기 직전
        .type(named("ch.qos.logback.classic.Logger"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(LogAdvice.class).on(named("callAppenders").and(takesArguments(1)))))
```

두 번째 빌더(부트스트랩 클래스)를 HttpURLConnection과 Throwable 두 대상으로:

```java
        .type(named("sun.net.www.protocol.http.HttpURLConnection"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(HttpAdvice.class).on(named("getInputStream").and(takesArguments(0))))
                .visit(Advice.to(ConnectAdvice.class).on(namedOneOf("connect", "getOutputStream").and(takesArguments(0)))))
        // 로거를 거치지 않는 e.printStackTrace()
        .type(named("java.lang.Throwable"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(PrintAdvice.class).on(named("printStackTrace").and(takesArguments(0)))))
        .installOn(inst);
```

주석 "JDK의 HttpURLConnection은 부트스트랩 로더가 올린다…"를 "JDK 클래스(HttpURLConnection, Throwable)는 부트스트랩 로더가 올린다…"로.

- [ ] **Step 8: 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS, 실패 0(기존 `/boom`은 `HTTP 500` 그대로).

- [ ] **Step 9: 커밋**

```bash
git add agent-java/build.js agent-java/src/apm/Tracer.java agent-java/src/apm/Agent.java agent-java/src/apm/LogAdvice.java agent-java/src/apm/PrintAdvice.java agent-java/test/TestApp.java test/java-agent.test.js
git commit -m "feat(agent-java): logged exceptions (Logback ERROR, printStackTrace) make the request an error"
```

---

### Task 2: 앱 메서드 흐름과 매퍼(MyBatis SQL ID)

**Files:**
- Modify: `agent-java/src/apm/Tracer.java` (`methodStart`/`methodEnd`/`mapperStart`/`mapperEnd`, `lastSpan` 필터)
- Create: `agent-java/src/apm/MethodAdvice.java`, `agent-java/src/apm/MapperAdvice.java`
- Modify: `agent-java/src/apm/Agent.java`
- Modify: `agent-java/test/TestApp.java`, `test/java-agent.test.js`

**Interfaces:**
- Consumes: Task 1의 `full`, `open`(depth), `exceptionText`, Span `depth`, Tx `level`.
- Produces (Tracer, public): `Span methodStart(String typeName, String method)`, `void methodEnd(Span, Throwable)`,
  `Span mapperStart(String statementId)`, `void mapperEnd(Span, Throwable)`, `static String mapperName(String id)`.

- [ ] **Step 1: 테스트 앱 클래스**

`TestApp.java` 끝(클래스 `TestApp` 닫는 `}` 뒤)에 같은 파일의 top-level 클래스로:

```java
// 앱 메서드 흐름 테스트용. 이름이 앱 패키지(TestApp)로 시작하고 Controller·ServiceImpl로 끝나야 계측된다.
class TestAppOrderController {
  private final TestAppOrderServiceImpl service;

  TestAppOrderController(TestAppOrderServiceImpl service) {
    this.service = service;
  }

  public String save(int id) {
    return service.saveOrder(id);
  }

  public String saveFail() {
    try {
      return service.failOrder();
    } catch (IllegalStateException e) {
      return "fail"; // 잡고 로그는 안 남긴다
    }
  }

  public String saveSlow(int id) throws InterruptedException {
    return service.saveSlow(id);
  }
}

class TestAppOrderServiceImpl {
  private final org.apache.ibatis.session.SqlSessionFactory factory;
  private int count;

  TestAppOrderServiceImpl(org.apache.ibatis.session.SqlSessionFactory factory) {
    this.factory = factory;
  }

  public int getCount() { // getter: 구간이 되면 안 된다
    return count;
  }

  public String saveOrder(int id) {
    count = getCount() + 1;
    try (org.apache.ibatis.session.SqlSession s = factory.openSession(true)) {
      return s.getMapper(TestAppItemMapper.class).name(id);
    }
  }

  public String failOrder() {
    throw new IllegalStateException("재고 없음");
  }

  public String saveSlow(int id) throws InterruptedException {
    String name = saveOrder(id);
    pause(); // SQL 뒤 메서드에서 멈춤: 처리 중 목록의 마지막 호출은 그래도 SQL이어야 한다
    return name;
  }

  public void pause() throws InterruptedException {
    Thread.sleep(1500);
  }
}

interface TestAppItemMapper {
  @org.apache.ibatis.annotations.Select("select name from item where id = #{id}")
  String name(int id);
}
```

`main`에서 `Tomcat tomcat = new Tomcat();` 앞(기동 중 에러 로그 앞)에:

```java
    org.apache.ibatis.session.Configuration mybatis = new org.apache.ibatis.session.Configuration(
        new org.apache.ibatis.mapping.Environment("t", new org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory(),
            new org.apache.ibatis.datasource.unpooled.UnpooledDataSource(
                "org.apache.derby.jdbc.EmbeddedDriver", "jdbc:derby:memory:t", null, null)));
    mybatis.addMapper(TestAppItemMapper.class);
    TestAppOrderController orders = new TestAppOrderController(new TestAppOrderServiceImpl(
        new org.apache.ibatis.session.SqlSessionFactoryBuilder().build(mybatis)));
```

`orders`를 서블릿 익명 클래스에서 쓰므로 effectively final로 둔다. `switch`에 추가:

```java
            case "/flow":
              orders.save(1);
              break;
            case "/flowfail":
              orders.saveFail();
              break;
            case "/flowslow":
              orders.saveSlow(1);
              break;
```

- [ ] **Step 2: 실패하는 테스트**

예외 테스트들 뒤에:

```js
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
```

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: `/flow`·`/flowfail` FAIL(메서드·매퍼 구간 없음 → `flow`가 `[['sql','select name',0]]`).
`/flowslow`는 아직 메서드 구간이 없어 `lastSpan`이 SQL이라 통과한다 — 이 테스트의 RED는 Step 6에서 본다.

- [ ] **Step 3: `Tracer.java` — 메서드·매퍼 구간**

```java
  // 겹쳐 불리는 MyBatis Executor(CachingExecutor → SimpleExecutor) 가운데 바깥 한 번만
  private static final ThreadLocal<int[]> MAPPER = ThreadLocal.withInitial(() -> new int[1]);

  // 메서드·매퍼 구간: 만들면 level을 올리고, 닫을 때 내린다. 요청 밖이거나 한도면 만들지 않는다.
  private static Span enter(String type, String text) {
    Tx tx = CURRENT.get();
    if (tx == null || full(tx)) return null;
    Span s = open(tx, type, text);
    tx.level++;
    return s;
  }

  private static void leave(Span s, Throwable thrown) {
    if (s == null) return;
    Tx tx = CURRENT.get();
    if (tx != null) tx.level--;
    s.elapsed = ms(System.nanoTime() - s.t0);
    if (thrown != null) s.error = exceptionText(thrown.getClass().getName(), thrown.getMessage());
  }

  public static Span methodStart(String typeName, String method) {
    try {
      return enter("method", typeName.substring(typeName.lastIndexOf('.') + 1) + "." + method);
    } catch (Throwable t) {
      return null;
    }
  }

  public static void methodEnd(Span s, Throwable thrown) {
    try {
      leave(s, thrown);
    } catch (Throwable ignored) {
      // 앱으로 새지 않게
    }
  }

  public static Span mapperStart(String statementId) {
    if (MAPPER.get()[0]++ > 0) return null;
    try {
      return enter("mapper", mapperName(statementId));
    } catch (Throwable t) {
      return null;
    }
  }

  public static void mapperEnd(Span s, Throwable thrown) {
    MAPPER.get()[0]--;
    methodEnd(s, thrown);
  }

  // org.kipa…EvlMapper.insertResult → EvlMapper.insertResult
  static String mapperName(String id) {
    int dot = id.lastIndexOf('.');
    if (dot < 0) return id;
    String ns = id.substring(0, dot);
    return ns.substring(ns.lastIndexOf('.') + 1) + id.substring(dot);
  }
```

- [ ] **Step 4: Advice 둘**

`agent-java/src/apm/MethodAdvice.java`:

```java
package apm;

import net.bytebuddy.asm.Advice;

// 앱 Controller·Service 클래스의 public 메서드 앞뒤. 메서드 흐름(들여쓰기)을 만든다.
public final class MethodAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.Origin("#t") String type, @Advice.Origin("#m") String method) {
    return Tracer.methodStart(type, method);
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.methodEnd(span, thrown);
  }
}
```

`agent-java/src/apm/MapperAdvice.java`:

```java
package apm;

import net.bytebuddy.asm.Advice;
import org.apache.ibatis.mapping.MappedStatement;

// MyBatis Executor의 query(4개 인자)·update 앞뒤. 매퍼 인터페이스는 몸체가 없어 계측할 수 없으므로
// 모든 매퍼 호출과 sqlSession.selectList("id") 직접 호출이 지나는 이곳에서 SQL ID를 얻는다.
public final class MapperAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.Argument(0) MappedStatement ms) {
    return Tracer.mapperStart(ms.getId());
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.mapperEnd(span, thrown);
  }
}
```

주의: `mapperStart`가 `MappedStatement.getId()`에서 예외로 빠지면 `MAPPER` 카운터가 안 올라가 `mapperEnd`가 음수로 만든다.
`getId()`는 필드 getter라 예외가 없다고 본다(바꾸지 않음).

- [ ] **Step 5: `Agent.java`**

import 추가: `hasSuperType`, `isConstructor`, `isGetter`, `isPublic`, `isSetter`, `isStatic`, `isSynthetic`, `nameContains`, `nameEndsWith`
(모두 `net.bytebuddy.matcher.ElementMatchers`).

주 빌더를 변수로 나눈다: `AgentBuilder main = new AgentBuilder.Default() … (Logback 변환까지);` 다음에

```java
    // MyBatis: 모든 매퍼 호출이 지나는 Executor. BaseExecutor처럼 추상 클래스도 몸체 있는 메서드는 포함
    main = main.type(hasSuperType(named("org.apache.ibatis.executor.Executor")).and(not(isInterface())))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(MapperAdvice.class).on(not(isAbstract()).and(
                named("query").and(takesArguments(4)).or(named("update").and(takesArguments(2)))))));
    // 앱 메서드 흐름: 앱 패키지의 *Controller·*ServiceImpl·*Service. $가 든 이름(CGLIB 프록시, 안쪽 클래스)은 빼서 한 호출이 한 줄
    if (Tracer.appPackage != null) {
      main = main.type(nameStartsWith(Tracer.appPackage)
              .and(nameEndsWith("Controller").or(nameEndsWith("ServiceImpl")).or(nameEndsWith("Service")))
              .and(not(nameContains("$"))).and(not(isInterface())))
          .transform((builder, type, loader, module) ->
              builder.visit(Advice.to(MethodAdvice.class).on(isPublic().and(not(isStatic())).and(not(isAbstract()))
                  .and(not(isConstructor())).and(not(isGetter())).and(not(isSetter())).and(not(isSynthetic()))
                  .and(not(namedOneOf("toString", "equals", "hashCode"))))));
    }
    main.installOn(inst);
```

- [ ] **Step 6: 실행 — 흐름 통과, 마지막 호출 RED**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: `/flow`·`/flowfail` PASS. '처리 중 목록의 마지막 호출은 메서드가 아니라 SQL'만 FAIL(`lastSpan`이 `TestAppOrderServiceImpl.pause`).

- [ ] **Step 7: `active()`의 마지막 호출을 SQL·외부로 한정**

`Tracer.active()`의 `if (!t.spans.isEmpty()) last = t.spans.get(t.spans.size() - 1).text;`를:

```java
        for (int i = t.spans.size() - 1; i >= 0 && last == null; i--) { // 마지막 SQL·외부 호출(메서드·매퍼·예외 줄은 건너뜀)
          Span s = t.spans.get(i);
          if ("sql".equals(s.type) || "http".equals(s.type)) last = s.text;
        }
```

Run 같은 명령 → Expected: PASS, 실패 0.

- [ ] **Step 8: 커밋**

```bash
git add agent-java/src/apm/Tracer.java agent-java/src/apm/Agent.java agent-java/src/apm/MethodAdvice.java agent-java/src/apm/MapperAdvice.java agent-java/test/TestApp.java test/java-agent.test.js
git commit -m "feat(agent-java): app method flow and MyBatis statement ids as nested spans"
```

---

### Task 3: 요청 정보(사용자·IP·화면·파라미터)

**Files:**
- Create: `agent-java/src/apm/RequestInfo.java`
- Modify: `agent-java/src/apm/RequestAdvice.java`, `agent-java/src/apm/Tracer.java`, `agent-java/src/apm/Agent.java`
- Modify: `agent-java/test/TestApp.java`, `test/java-agent.test.js`

**Interfaces:**
- Produces: `Tracer.request(Tx tx, String ip, String user, String referer, String params)`(public), 트랜잭션 JSON `"req":{"ip","user","referer","params"}`.
  `RequestInfo.collect(Tracer.Tx, HttpServletRequest)`(예외 삼킴), `RequestInfo.userAttr`(static, Agent가 설정).

- [ ] **Step 1: 테스트 앱**

top-level 클래스 추가(`TestAppItemMapper` 뒤):

```java
// 세션 속성으로 넣을 가짜 Spring Security 컨텍스트와 로그인 사용자. 공개 클래스가 아니어도 읽혀야 한다.
class TestAppSecurityContext {
  public TestAppAuth getAuthentication() {
    return new TestAppAuth();
  }
}

class TestAppAuth {
  public String getName() {
    return "hong01";
  }
}

class TestAppLoginUser {
  public String getUserId() {
    return "kim02";
  }
}
```

`switch`에 추가:

```java
            case "/req":
              req.getSession().setAttribute("SPRING_SECURITY_CONTEXT", new TestAppSecurityContext());
              break;
            case "/req2":
              req.getSession().setAttribute("loginUser", new TestAppLoginUser());
              break;
```

- [ ] **Step 2: 실패하는 테스트**

```js
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
```

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: 새 3개 FAIL(`tx.req` undefined).

- [ ] **Step 3: `RequestInfo.java`**

```java
package apm;

import java.lang.reflect.Method;
import java.util.Locale;
import java.util.Map;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpSession;

// 요청이 끝날 때 사용자·IP·화면·파라미터를 문자열로 정리해 Tracer에 넘긴다. 서블릿 타입을 쓰므로 에이전트 jar에 둔다.
public final class RequestInfo {
  public static String userAttr = "loginUser"; // APM_USER_ATTR
  static final String[] SECRET = {"pass", "pw", "secret", "token", "jumin", "rrn", "ssn"};
  static final String[] USER_GETTERS = {"getUserId", "getUsername", "getLoginId", "getId"};
  static final int MAX_VALUE = 200;
  static final int MAX_PARAMS = 2000;

  // 무엇이 실패해도 앱 응답과 트랜잭션 종료에 영향이 없게 모두 삼킨다
  public static void collect(Tracer.Tx tx, HttpServletRequest r) {
    if (tx == null) return;
    String ip = null, user = null, referer = null, params = null;
    try {
      ip = ip(r);
      referer = r.getHeader("Referer");
      params = params(r);
      user = user(r);
    } catch (Throwable ignored) {
      // 세션 무효화 등
    }
    Tracer.request(tx, ip, user, referer, params);
  }

  static String ip(HttpServletRequest r) {
    String xff = r.getHeader("X-Forwarded-For");
    if (xff != null && !xff.trim().isEmpty()) return xff.split(",")[0].trim();
    return r.getRemoteAddr();
  }

  static String user(HttpServletRequest r) throws Exception {
    HttpSession s = r.getSession(false);
    if (s == null) return null;
    Object ctx = s.getAttribute("SPRING_SECURITY_CONTEXT");
    Object auth = ctx == null ? null : call(ctx, "getAuthentication");
    Object name = auth == null ? null : call(auth, "getName");
    if (name != null) return name.toString();
    Object u = s.getAttribute(userAttr);
    if (u == null || u instanceof String) return (String) u;
    for (String g : USER_GETTERS) {
      Method m = method(u, g);
      if (m != null) {
        Object v = m.invoke(u);
        return v == null ? null : v.toString();
      }
    }
    return null;
  }

  static String params(HttpServletRequest r) {
    StringBuilder b = new StringBuilder();
    for (Map.Entry<String, String[]> e : r.getParameterMap().entrySet()) {
      boolean secret = isSecret(e.getKey());
      for (String v : e.getValue()) {
        if (b.length() > 0) b.append('&');
        b.append(e.getKey()).append('=');
        b.append(secret ? "****" : v.length() > MAX_VALUE ? v.substring(0, MAX_VALUE) + "..." : v);
        if (b.length() > MAX_PARAMS) return b.substring(0, MAX_PARAMS) + "...";
      }
    }
    return b.length() == 0 ? null : b.toString();
  }

  static boolean isSecret(String name) {
    String n = name.toLowerCase(Locale.ROOT);
    for (String s : SECRET) if (n.contains(s)) return true;
    return false;
  }

  static Method method(Object o, String name) {
    try {
      Method m = o.getClass().getMethod(name);
      m.setAccessible(true); // 공개 클래스가 아니어도 부를 수 있게
      return m;
    } catch (NoSuchMethodException e) {
      return null;
    }
  }

  static Object call(Object o, String name) throws Exception {
    Method m = method(o, name);
    return m == null ? null : m.invoke(o);
  }
}
```

- [ ] **Step 4: `Tracer`, `RequestAdvice`, `Agent`**

`Tracer.Tx`에 `String ip, user, referer, params;` 추가. 메서드:

```java
  // 요청이 끝날 때 RequestInfo가 정리해 넘긴다
  public static void request(Tx tx, String ip, String user, String referer, String params) {
    tx.ip = ip;
    tx.user = user;
    tx.referer = cut(referer);
    tx.params = params;
  }
```

`tx()` JSON의 `if (dropped > 0) …` 앞에:

```java
    b.append(",\"req\":{\"ip\":");
    str(b, t.ip);
    b.append(",\"user\":");
    str(b, t.user);
    b.append(",\"referer\":");
    str(b, t.referer);
    b.append(",\"params\":");
    str(b, t.params);
    b.append('}');
```

`RequestAdvice.exit`:

```java
  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Tx tx, @Advice.Argument(0) HttpServletRequest req,
      @Advice.Argument(1) HttpServletResponse res, @Advice.Thrown Throwable thrown) {
    RequestInfo.collect(tx, req); // 예외를 삼키므로 아래 end는 늘 불린다
    Tracer.end(tx, thrown != null ? 500 : res.getStatus());
  }
```

`Agent.premain`의 `Tracer.appPackage = …` 아래: `RequestInfo.userAttr = env("APM_USER_ATTR", RequestInfo.userAttr);`

- [ ] **Step 5: 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS, 실패 0.

- [ ] **Step 6: 커밋**

```bash
git add agent-java/src/apm/RequestInfo.java agent-java/src/apm/RequestAdvice.java agent-java/src/apm/Tracer.java agent-java/src/apm/Agent.java agent-java/test/TestApp.java test/java-agent.test.js
git commit -m "feat(agent-java): request info (user, ip, referer, masked params) on each transaction"
```

---

### Task 4: 대시보드 상세 — 종류·들여쓰기·요청 정보, README

**Files:**
- Modify: `dashboard/calc.mjs` (`selfTime`), `dashboard/app.mjs` (`showDetail`, `spanRow`), `dashboard/index.html` (CSS)
- Modify: `README.md`
- Test: `test/calc.test.mjs`

**Interfaces:**
- Consumes: Task 1~3의 구간 `type`·`depth`, 트랜잭션 `req`.
- Produces: `selfTime(elapsed, spans) → number` (calc.mjs).

- [ ] **Step 1: 실패하는 테스트** — `test/calc.test.mjs`

import에 `selfTime` 추가, 끝에:

```js
test('selfTime: 전체 − 맨 바깥(depth 0 또는 없음) 구간 합, 음수면 0', () => {
  const spans = [
    { elapsed: 80, depth: 0 }, // 메서드
    { elapsed: 70, depth: 1 }, // 그 안의 SQL: 두 번 빼면 안 된다
    { elapsed: 5 },            // Node 에이전트 구간(depth 없음)
  ];
  assert.equal(selfTime(100, spans), 15);
  assert.equal(selfTime(50, spans), 0);
  assert.equal(selfTime(10, []), 10);
});
```

Run: `fnm exec --using=22 node --test test/calc.test.mjs` → Expected: FAIL(`selfTime` export 없음).

- [ ] **Step 2: `calc.mjs`**

```js
// 앱 자체 처리 시간: 전체 − 맨 바깥 구간들(depth 0 또는 없음). 안쪽 구간은 바깥 구간 시간에 이미 들어 있다.
export function selfTime(elapsed, spans) {
  return Math.max(0, elapsed - spans.filter((s) => !s.depth).reduce((sum, s) => sum + s.elapsed, 0));
}
```

Run 같은 명령 → PASS.

- [ ] **Step 3: `app.mjs`**

import에 `selfTime`. 상수에 `const KIND = { method: '메서드', mapper: '매퍼', sql: 'SQL', http: '외부', exception: '예외' };`

`showDetail`:

```js
  const self = selfTime(tx.elapsed, tx.spans);

  const head = document.createElement('p');
  head.textContent = `${tx.name}   ${Math.round(tx.elapsed)}ms   상태 ${tx.status}${tx.error ? `   — ${tx.error}` : ''}`;
  if (tx.error) head.className = 'err';
  // 누가 어느 화면에서 무엇을 보냈나(Java 에이전트만). 값이 있는 것만
  const r = tx.req ?? {};
  const info = [['사용자', r.user], ['IP', r.ip], ['화면', r.referer], ['파라미터', r.params]]
    .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('  ·  ');
  const req = document.createElement('p');
  req.className = 'req';
  req.textContent = info;

  const table = document.createElement('table');
  for (const s of tx.spans) {
    const label = s.error ? `${s.text}  (${s.error})` : s.text;
    table.append(spanRow(KIND[s.type] ?? s.type, label, s.offset / total, s.elapsed, s.elapsed / total, s.error,
      s.depth ?? 0, s.type === 'method' || s.type === 'mapper'));
  }
  if (tx.droppedSpans) table.append(row('td', ['…', `호출 ${tx.droppedSpans}개 생략(트랜잭션당 1000개까지 기록, 생략분 시간은 아래에 포함)`]));
  table.append(spanRow('앱', '앱 자체 처리', null, self, 0, null, 0, false));
  box.replaceChildren(...(info ? [head, req, table] : [head, table]));
```

`spanRow(kind, text, left, elapsed, width, error, depth, dim)`: `tr.children[1].className = 'text';` 아래에
`tr.children[1].style.paddingLeft = `${8 + depth * 16}px`;`, 막대 `fill.className = error ? 'err' : dim ? 'dim' : '';`.

- [ ] **Step 4: `index.html` CSS** (`.bar i.err` 다음)

```css
  .bar i.dim { background: var(--dim); opacity: 0.6; }
  .req { margin: -4px 0 8px; color: var(--dim); word-break: break-all; }
```

- [ ] **Step 5: 화면 확인(Playwright)**

스크래치 스크립트: 수집 서버를 `PORT=7710`으로 띄우고, `/ingest`에 `agent: 'ipfinance'`로 아래 트랜잭션 하나(에러 있음)를 POST한 뒤
`http://localhost:7710`을 열어 최근 에러 첫 줄을 눌러 상세를 스크린샷한다.

```js
{ id: 'p1', name: 'POST /evl/save', start: Date.now() - 900, elapsed: 820, status: 200, error: 'IllegalStateException: 재고 없음',
  req: { ip: '10.0.0.9', user: 'hong01', referer: 'http://localhost/evl/list', params: 'evlId=123&password=****' },
  spans: [
    { type: 'method', text: 'EvlController.save', offset: 2, elapsed: 815, error: null, depth: 0 },
    { type: 'method', text: 'EvlServiceImpl.saveEvl', offset: 3, elapsed: 790, error: null, depth: 1 },
    { type: 'mapper', text: 'EvlMapper.insertResult', offset: 10, elapsed: 640, error: null, depth: 2 },
    { type: 'sql', text: 'insert into TB_EVL_RSLT values (1)', offset: 11, elapsed: 639, error: null, depth: 3 },
    { type: 'exception', text: '주문 저장 실패', offset: 700, elapsed: 0, error: 'IllegalStateException: 재고 없음', depth: 2 },
  ] }
```

확인: 요청 정보 줄, 종류(메서드/매퍼/SQL/예외), 들여쓰기 0·16·32·48px, 메서드·매퍼 막대 흐림, 예외 빨간 얇은 표시,
"앱 자체 처리" 5ms(820−815). `page.$$eval('#detail td.text', …)`로 paddingLeft 값도 읽는다. 끝나면 프로세스 정리.

- [ ] **Step 6: README** (Java 절)

- 에이전트 표에 줄 추가:
  `| \`LogAdvice\`·\`PrintAdvice\` | 예외 이벤트 | 앱이 잡아서 로그로만 남긴 예외도 '에러'로 봐야 경보가 산다 |`
  `| \`MethodAdvice\`·\`MapperAdvice\` | 메서드 프로파일 | 어느 Controller→Service→매퍼가 그 SQL을 불렀는지 |`
- Environment 목록에 `- **Environment(선택)**: \`APM_USER_ATTR=loginUser\` — 상세의 사용자를 읽을 세션 속성 이름(Spring Security가 먼저).`
- 한계에 추가:
  `- **메서드 흐름**: 앱 패키지의 이름이 \`Controller\`·\`ServiceImpl\`·\`Service\`로 끝나는 클래스의 public 메서드만. 반복문 속 서비스 호출이 많으면 구간 한도(1,000)를 먼저 채워 뒤 SQL이 생략될 수 있다.`
  `- **요청 정보**: JSON 본문은 읽지 않는다(React 화면의 POST는 파라미터가 비어 보인다).`
  `- **예외**: Logback ERROR와 \`printStackTrace()\`만. WARN, Log4j2·java.util.logging에 직접 남긴 로그는 빠진다.`

- [ ] **Step 7: 전체 테스트**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 실패 0 (53 + Task1 5 + Task2 3 + Task3 3 + calc 1 = 65).

- [ ] **Step 8: 커밋**

```bash
git add dashboard/calc.mjs dashboard/app.mjs dashboard/index.html README.md test/calc.test.mjs
git commit -m "feat(dashboard): span kinds, nested indentation and request info in transaction detail"
```
