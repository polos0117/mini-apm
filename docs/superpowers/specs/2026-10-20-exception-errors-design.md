# 앱이 잡아서 로그로 남긴 예외도 에러로 (Java 에이전트)

## 목표

- 앱이 예외를 잡고 로그만 남긴 채 200으로 끝낸 요청도 에러로 보이고, 기존 에러 경보가 울린다.
- 에러 내용이 `HTTP 500` 대신 `NullPointerException: …`처럼 원인을 보여 준다.
- 대상 앱(KIPA_IP-Finance, KIPA_EVL_MANAGE) 코드와 Eclipse 설정은 그대로.

대상 앱: SLF4J → Logback 1.2.3(`logback-spring.xml`). `log.error(…, e)` 67곳, `e.printStackTrace()` 37곳.
공통 예외 처리기(`@ControllerAdvice`)는 없다.

## 1. 에이전트가 잡는 것

### Logback ERROR 로그

- 계측 대상: `ch.qos.logback.classic.Logger.callAppenders(ILoggingEvent)` 진입.
  레벨 판단을 통과한 로그만, 로그 한 건당 한 번 불린다(로거 계층은 이 메서드 안에서 돈다).
- `event.getLevel()`이 ERROR일 때만 기록한다.
  - 예외가 있으면(`getThrowableProxy() != null`): `error` = `단순클래스명: 예외 메시지`, `text` = 로그 메시지(`getFormattedMessage()`).
  - 예외가 없으면: `error`와 `text` 모두 로그 메시지.
  - 단순클래스명은 `IThrowableProxy.getClassName()`에서 마지막 `.` 뒤. 예외 메시지가 null이면 단순클래스명만.
  - 로그 메시지가 null이거나 비면 `text`는 `(메시지 없음)`.
- Advice는 Logback 타입을 문자열로 바꿔 `Tracer`에 넘긴다. `Tracer`는 Logback을 모른다(부트스트랩에 있으므로).
  Logback jar는 빌드할 때 컴파일 클래스패스에만 쓴다(OkHttp와 같은 방식).
- Spring Boot는 Tomcat(java.util.logging)이 남기는 "처리 안 된 예외" 로그도 Logback으로 넘기므로, 앱 밖으로 나간 500 예외도 이 경로로 이름이 붙는다.

### `printStackTrace()`

- 계측 대상: `java.lang.Throwable.printStackTrace()`(인자 없는 것) 진입. 외부 HTTP 때 만든 두 번째 `AgentBuilder`
  (부트스트랩 클래스, 이미 로드된 클래스 다시 변환)에 대상으로 더한다.
- `error` = `단순클래스명: 메시지`(메시지 null이면 단순클래스명만), `text` = `printStackTrace()`.

### 기록 형식

- 트랜잭션에 구간 `{ type: "exception", text, offset, elapsed: 0, error }`를 더한다. offset은 기록한 시점.
- 요청 밖(스레드에 트랜잭션 없음: 배치, 에이전트 전송 스레드)에서는 기록하지 않는다.
- SQL·외부 호출의 깊이 카운터는 쓰지 않는다. SQL 실행 안에서 남긴 로그(log4jdbc의 에러 로그 등)도 기록한다.
- 구간 수 한도(`MAX_SPANS`)와 글자 수 한도(`MAX_BODY`)는 다른 구간과 함께 쓴다. 넘으면 `dropped`로 센다.
- `text`와 `error`는 `MAX_SQL`(10만 자)에서 자른다.
- `Tracer` API: `public static void exception(String text, String error)`. 안에서 생기는 예외는 앱으로 새지 않는다.

## 2. 요청의 에러 판단(`Tracer.end`)

요청이 끝날 때 차례로:

1. 예외 구간이 있으면 → 첫 번째 예외 구간의 `error`. 응답 코드와 상관없다.
2. 없고 응답이 500 이상이면 → 지금처럼 마지막으로 실패한 SQL·외부 구간의 `error`, 없으면 `HTTP <코드>`.
3. 그 밖에는 `null`.

`status`는 실제 응답 코드 그대로 둔다.

## 3. 대시보드

- 트랜잭션 상세의 구간 종류: `sql` → `SQL`, `http` → `외부`, `exception` → `예외`.
  줄은 기존처럼 `text  (error)`, 막대는 그 시점의 얇은 빨간 표시(기존 최소 폭 0.5%).
- 그 밖(빨간 점, 에러 타일, 최근 에러, 경보)은 바꾸지 않는다. 요청의 `error`가 채워지면 그대로 동작한다.

## 테스트

`test/java-agent.test.js`. 테스트 앱 클래스패스에 `logback-classic 1.2.3`, `logback-core 1.2.3`, `slf4j-api 1.7.30`을 넣는다
(설정 파일이 없으면 Logback 기본 설정: DEBUG 이상 콘솔 출력).

| 주소 | 하는 일 | 확인 |
|---|---|---|
| `/caught` | `IllegalStateException("재고 없음")`을 잡아 `log.error("주문 저장 실패", e)`, 200 | `status` 200, `error` `IllegalStateException: 재고 없음`, 예외 구간 하나(`text` `주문 저장 실패`) |
| `/errlog` | `log.error("결재 실패 id={}", 7)` | `error` `결재 실패 id=7` |
| `/printed` | `new IllegalArgumentException("잘못된 값").printStackTrace()` | `error` `IllegalArgumentException: 잘못된 값`, `text` `printStackTrace()` |
| `/warn` | `log.warn("경고", e)` | `error` null, 예외 구간 없음 |
| `/twice` | `log.error("첫째", new RuntimeException("a"))` 뒤 `log.error("둘째", new RuntimeException("b"))` | `error` `RuntimeException: a`, 예외 구간 둘 |

- 기동 시(요청 밖) `log.error("기동 중 에러")`를 남기고, 어떤 트랜잭션에도 그 구간이 없다.
- 기존 테스트는 모두 그대로 통과한다(`/boom` 500의 `error`는 Logback을 거치지 않으므로 지금처럼 `HTTP 500`).

## 범위 밖

- WARN 로그, Log4j2·java.util.logging에 직접 남기는 로그(Spring Boot가 Logback으로 넘기는 것은 잡힌다).
- 스택 트레이스 전문, 같은 예외 중복 제거.
- Java 17 이상(Byte Buddy 1.10.20 한계로 `Throwable` 계측이 실패할 수 있다. 기동 시 `[apm] 계측 실패`).
