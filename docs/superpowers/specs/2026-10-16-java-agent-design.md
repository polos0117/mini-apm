# mini-apm Java 에이전트 설계

## 목적

학습용. JENNIFER가 `-javaagent`로 Java 앱을 계측하는 방식을 직접 만들어 본다.
대상은 `D:\AnyBuilder\workspace\KIPA_IP-Finance`이다. 대상 앱의 소스는 고치지 않는다.
수집 서버와 대시보드는 기존 것을 그대로 쓴다.

**성공 기준**: Eclipse에서 IP-Finance를 에이전트와 함께 띄우고 화면을 누르면 다음이 보인다.
- X-View에 요청 점이 찍힌다.
- 점을 누르면 상세 화면에 SQL 구간 막대가 보인다.
- SQL 하나는 막대 하나로 나온다.

## 대상 환경 (확인한 사실)

| 항목 | 값 |
|---|---|
| 실행 | Eclipse 실행 설정 "KIPA_IP-Finance - Application", main `org.kipa.ipfinance.Application` |
| JDK | JavaSE-1.8 → `D:/AnyBuilder/bin/java/jdk1.8.0_102-x64` |
| 프레임워크 | Spring Boot 2.4.3 (`javax.servlet`), 내장 Tomcat 9, devtools |
| DB | MariaDB (`mariadb-java-client` 2.7.2), HikariCP, log4jdbc-log4j2 1.16, MyBatis |
| 빌드 도구 | 오프라인 Maven, jar를 묶는 플러그인(shade/assembly/jar) 없음 |
| 로컬 저장소 | `D:/AnyBuilder/data/.tool/maven/repository`. Byte Buddy 1.10.20, tomcat-embed-core 9.0.43, tomcat-annotations-api 9.0.43 있음 |
| 테스트 DB | JDK 8 내장 Derby (`<JDK>/db/lib/derby.jar`) |

## 범위

- **계측함**: 들어오는 HTTP 요청, JDBC SQL 실행.
- **계측 안 함**: `HttpURLConnection`, OkHttp 외부 호출. 그 시간은 "앱 자체 처리"로 보인다.
- **기록 안 함**: 요청 밖에서 도는 SQL(Quartz 배치, 기동 시 쿼리), 정적 파일 요청.

## 구조

```
agent-java/
  src/apm/Agent.java          premain: Byte Buddy AgentBuilder로 계측 설치, 전송 스레드 시작
  src/apm/Tracer.java         트랜잭션·SQL 구간 기록, 처리 중 목록, 전송, JSON 작성
  src/apm/RequestAdvice.java  StandardHostValve.invoke 앞뒤
  src/apm/SqlAdvice.java      Statement/PreparedStatement execute* 앞뒤
  src/apm/PrepareAdvice.java  Connection.prepareStatement(String, ...) 반환값에 SQL 연결
  test/TestApp.java           자동 테스트용 앱 (내장 Tomcat + Derby)
  build.js                    javac + jar → agent-java/dist/mini-apm-agent.jar (require하면 build() 등을 내보냄)
test/java-agent.test.js       자동 테스트 (기존 npm test에 포함)
```

`package.json`에 `"build:java": "node agent-java/build.js"`를 추가한다. `agent-java/dist/`와 `agent-java/build/`는 `.gitignore`에 넣는다.

## 계측 지점

### 요청: `org.apache.catalina.core.StandardHostValve.invoke(Request, Response)`

- **왜 이 지점인가**: `HttpServlet.service`보다 바깥이다.
  - Spring Security 필터 시간이 응답시간에 포함된다.
  - forward/include로 서블릿이 다시 불려도 요청당 한 번만 잡힌다.
- **들어갈 때**
  - 정적 파일이면 아무것도 하지 않는다. URI가 `.js .css .png .jpg .gif .svg .ico .woff .woff2 .map` 중 하나로 끝나면 정적 파일로 본다.
  - 아니면 트랜잭션을 시작한다. 이름은 `<METHOD> <URI>`이고 쿼리스트링은 빼고 붙인다.
- **나올 때**: 상태는 `response.getStatus()`이다. 예외가 터져 나왔으면 500으로 본다.

### SQL

- **계측 대상**: `java.sql.Statement`를 구현한 모든 클래스(인터페이스 제외, 추상 클래스 포함)에서 몸체가 있는 메서드 `execute`, `executeQuery`, `executeUpdate`, `executeBatch`, `executeLargeUpdate`, `executeLargeBatch`.
- **가장 바깥 호출만 기록**: 이 앱의 SQL 호출은 Hikari 프록시 → log4jdbc → MariaDB로 겹쳐 있다. 스레드별 깊이 카운터를 두고 깊이 0에서 들어온 호출만 기록한다.
- **SQL 문장을 얻는 방법**
  - `Statement.execute*(String sql, ...)`: 첫 인자를 쓴다.
  - `PreparedStatement`: `Connection.prepareStatement(String, ...)`를 계측해서, 반환된 문장 객체와 SQL을 약한 참조 맵(`Collections.synchronizedMap(new WeakHashMap<>())`)에 넣어 둔다. 실행 시 이 맵에서 찾는다.
    - Hikari나 log4jdbc 프록시가 반환한 바깥 객체도 같은 `prepareStatement` 계측을 거치므로 맵에 들어간다. 그래서 가장 바깥 실행 객체로 찾을 수 있다.
    - 못 찾으면 문장을 `?`로 기록한다.
  - `java.sql.Connection` 구현 클래스(인터페이스 제외, 추상 클래스 포함)의 몸체가 있는 `prepareStatement(String, ...)`, `prepareCall(String, ...)`를 계측한다. 모든 겹에서 맵에 넣는다.
  - 추상 클래스를 포함하는 이유: Hikari의 `ProxyPreparedStatement`·`ProxyConnection`은 추상 클래스지만 실행 메서드를 직접 구현한다.
- **문장 정리**: 연속된 공백은 공백 하나로 줄인다. 앞뒤 공백을 자른다. 1,000자를 넘으면 1,000자에서 자른다.

## 트랜잭션과 구간 기록 (`Tracer`)

- 현재 트랜잭션은 `ThreadLocal`에 둔다. Tomcat은 요청 하나를 스레드 하나가 끝까지 처리한다.
- 처리 중 목록은 `ConcurrentHashMap<String, Tx>`이다.

### 트랜잭션 레코드

Node 에이전트와 같은 필드를 쓴다.

```json
{ "id": "uuid", "name": "GET /x.do", "start": 1760000000000, "elapsed": 12.3,
  "status": 200, "error": null, "spans": [ ... ], "droppedSpans": 3 }
```

- `start`는 `System.currentTimeMillis()`이다.
- `elapsed`는 `System.nanoTime()` 차이를 ms로 바꾼 값이다. 소수 첫째 자리로 반올림한다.
- `droppedSpans`는 0보다 클 때만 넣는다.
- `error` 결정
  - 상태가 500 이상이면, 실패한 마지막 구간의 `error`를 쓴다.
  - 실패한 구간이 없으면 `"HTTP <status>"`를 쓴다.
  - 상태가 500 미만이면 `null`이다.

### 구간 레코드

```json
{ "type": "sql", "text": "select ...", "offset": 1.2, "elapsed": 3.4, "error": null }
```

- `offset`은 트랜잭션 시작부터 구간 시작까지의 ms이다.
- `error`
  - 예외가 났으면 예외의 `getMessage()`를 쓴다.
  - 메시지가 null이면 예외 클래스 이름을 쓴다.
- 트랜잭션당 구간은 1,000개까지만 기록한다. 넘는 호출은 `droppedSpans`만 1씩 늘린다.

### 처리 중 목록 항목

Node 에이전트와 같은 형식이다. `lastSpan`은 마지막 구간의 문장이고, 없으면 `null`이다.

```json
{ "id": "uuid", "name": "GET /x.do", "elapsed": 812.0, "lastSpan": "select ..." }
```

## 전송

- **스레드**: 데몬 스레드 `apm-sender`가 `APM_INTERVAL` ms(기본 1000)마다 보낸다. 완료 목록을 통째로 바꿔치기해서 꺼낸다.
- **요청**: `POST <APM_COLLECTOR>/ingest`. 본문은 `{"agent": APM_AGENT, "txs": [...], "active": [...]}`이다.
  - `HttpURLConnection`을 쓴다. 연결 타임아웃과 응답 타임아웃은 각각 1,000ms이다.
- **설정 기본값**: `APM_COLLECTOR`는 `http://localhost:7700`, `APM_AGENT`는 `java`이다.
- **완료 버퍼**: 5,000건이 상한이다. 넘으면 오래된 것부터 버린다.
- **전송 실패**: 그 묶음은 버린다. stderr에 `[apm] 전송 실패: <메시지>`를 출력한다.
  - 다음 성공 전까지는 다시 출력하지 않는다.
  - 성공하면 출력 상태를 초기화한다.
- **JSON 작성**
  - 라이브러리 없이 직접 만든다.
  - 문자열은 `"`, `\`, 제어문자(U+0000–U+001F)를 이스케이프한다.
  - 숫자가 NaN이나 무한대면 0으로 쓴다.
- **기동 메시지**: stdout에 `[apm] mini-apm agent → <APM_COLLECTOR> (<APM_AGENT>)`를 출력한다.

## 앱 보호

- Advice 코드는 `suppress = Throwable.class`로 둔다. 에이전트 내부 오류는 삼키고 앱 흐름은 바꾸지 않는다.
- 앱이 던진 예외는 기록만 한다. Byte Buddy Advice의 `onThrowable`을 쓰므로 원래 예외가 그대로 전파된다.
- Byte Buddy가 계측에 실패해도 앱은 계측 없이 뜬다. 실패 클래스 이름은 stderr에 한 줄 출력한다.
  - 리스너의 `onError`에서 출력한다.
  - 대상 클래스(`StandardHostValve`, `Statement`·`Connection` 구현체)에 대한 오류만 출력한다.

## 클래스로더

- `-javaagent` jar는 시스템 클래스로더에 올라간다. 내장 Tomcat 클래스와 JDBC 드라이버도 시스템 클래스로더에서 로드되므로, 끼워 넣은 코드가 `apm.Tracer`를 찾을 수 있다.
- devtools 재시작 클래스로더는 앱 코드만 다시 로드하고 계측 대상과 겹치지 않는다.
- JDK 내부 클래스(부트스트랩 클래스로더)는 계측하지 않는다.
- Byte Buddy는 패키지 이름을 바꾸지 않고 jar에 넣는다. 앱 클래스패스에 Byte Buddy가 있더라도 Spring Boot 2.4.3이 관리하는 버전이 같은 1.10.20이다.

## 빌드 (`agent-java/build.js`)

1. JDK 경로는 `APM_JAVA_HOME`이다. 기본값은 `D:/AnyBuilder/bin/java/jdk1.8.0_102-x64`.
2. Byte Buddy jar 경로는 `APM_BYTEBUDDY_JAR`이다. 기본값은 `D:/AnyBuilder/data/.tool/maven/repository/net/bytebuddy/byte-buddy/1.10.20/byte-buddy-1.10.20.jar`.
3. `agent-java/build/classes`를 비운다.
4. `javac -source 8 -target 8 -encoding UTF-8 -cp <bytebuddy>;<tomcat-embed-core 9.0.43> -d build/classes src/apm/*.java`로 컴파일한다. tomcat-embed-core는 `RequestAdvice`가 쓰는 `javax.servlet.http` 타입 때문에 컴파일 때만 쓰고 jar에는 넣지 않는다.
5. `build/classes`에서 `jar xf <bytebuddy>`로 Byte Buddy 클래스를 푼다. 그 jar의 `META-INF/MANIFEST.MF`는 지운다.
6. 매니페스트에 `Premain-Class: apm.Agent`와 `Can-Retransform-Classes: true`를 쓴다.
7. `jar cfm agent-java/dist/mini-apm-agent.jar <manifest> -C build/classes .`로 묶는다.

JDK나 Byte Buddy jar가 없으면 경로를 알려 주는 메시지를 출력하고 종료 코드 1로 끝난다.

## 테스트

### 자동 테스트 (`test/java-agent.test.js`)

- **건너뛰는 경우**: `APM_JAVA_HOME`(기본값 포함)에 `bin/javac`가 없으면 전체를 `skip`한다.
- TestApp은 `-Dfile.encoding=UTF-8`로 띄운다. Java 8 콘솔 인코딩이 cp949라서, 이 옵션이 없으면 한글 메시지를 비교할 수 없다.
- **준비**
  1. `build.js`의 `build()`로 jar를 만든다.
  2. `TestApp.java`를 컴파일한다. 클래스패스는 tomcat-embed-core 9.0.43, tomcat-annotations-api 9.0.43, Derby이다.
  3. 실제 수집 서버를 띄운다. 기존 `createCollector()`를 임의 포트로 쓴다.
  4. TestApp을 `-javaagent`와 함께 띄운다. `APM_COLLECTOR`, `APM_AGENT=test`, `APM_INTERVAL=200`을 준다.
- **TestApp**
  - 내장 Tomcat을 `PORT`(인자)로 연다.
  - 기동 시 Derby 메모리 DB `jdbc:derby:memory:t;create=true`에 테이블 하나를 만든다. 요청 밖에서 도는 SQL이므로 기록되지 않아야 한다.
  - 서블릿 경로
    - `/ok`: `PreparedStatement`로 여러 줄짜리 SELECT를 한 번 실행하고 200을 응답한다.
    - `/fail`: 없는 테이블을 SELECT하고, 그 예외를 `ServletException`으로 던진다. Tomcat이 500으로 응답한다.
    - `/slow`: 1,500ms를 잔 뒤 200을 응답한다.
    - `/app.js`: 200을 응답한다.
- **확인 항목**
  1. 기동 stdout에 `[apm] mini-apm agent` 한 줄이 있다.
  2. `/ok`
     - 상태 200 트랜잭션 하나가 저장된다. 이름은 `GET /ok`이다.
     - `/tx/:id`로 받은 상세에 `sql` 구간이 정확히 하나 있다.
     - 그 구간의 문장은 공백이 하나로 정리돼 있다.
  3. `/fail`: 상태 500이고, `error`가 Derby 예외 메시지(테이블 이름 포함)이다.
  4. `/app.js`는 저장되지 않는다.
  5. `/slow`가 진행 중일 때 수집 서버의 처리 중 목록에 `GET /slow`가 있다.
  6. 수집 서버가 없는 포트를 `APM_COLLECTOR`로 주고 띄운 TestApp에서
     - `/ok`가 200으로 응답한다.
     - 1초 넘게 기다려도 stderr의 `[apm] 전송 실패` 줄은 정확히 하나다.
  7. 기동 시 SQL은 기록되지 않는다. 확인할 때 저장된 트랜잭션은 요청한 것뿐이다.

### 직접 확인

1. `npm run build:java`로 jar를 만든다.
2. 수집 서버를 띄운다 (`node collector/server.js`).
3. Eclipse "KIPA_IP-Finance - Application" 실행 설정에 두 가지를 넣는다.
   - VM arguments: `-javaagent:C:/Users/jjshs/mini-apm/agent-java/dist/mini-apm-agent.jar`
   - Environment: `APM_AGENT=ipfinance`
   - 실행 설정 파일은 Eclipse가 관리하므로 사람이 직접 넣는다.
4. 앱을 띄우고 화면을 몇 개 누른다. 다음을 확인한다.
   - X-View에 점이 찍힌다.
   - 상세 화면에 SQL 구간이 보인다.
   - **SQL 하나가 막대 하나로만 나온다.** Hikari → log4jdbc → MariaDB 세 겹 호출은 테스트 앱으로 재현하지 않으므로 여기서 확인한다.
   - 정적 파일 요청이 X-View에 없다.

## 알려진 한계 (학습 노트로 README에 남김)

- 비동기 서블릿(`DeferredResult`, `CompletableFuture` 반환 컨트롤러)은 스레드가 바뀌어 SQL 구간을 놓친다.
- 외부 호출은 계측하지 않으므로 "앱 자체 처리"에 섞인다.
- 정적 파일은 확장자 목록으로만 판단한다.
