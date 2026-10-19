# 처리 중 요청의 현재 위치 + 외부 HTTP 호출 (Java 에이전트)

## 목표

- 처리 중인 요청 목록에서 "지금 어느 메서드에서 멈춰 있는가"를 보여 준다.
- Java 에이전트가 외부 HTTP 호출(`HttpURLConnection`, OkHttp)을 SQL처럼 구간으로 기록한다.
- 대상 앱 코드는 고치지 않는다. Eclipse 실행 설정의 `-javaagent:` 한 줄도 그대로 쓴다.

대상 앱(KIPA_IP-Finance, KIPA_EVL_MANAGE)이 쓰는 외부 호출: `HttpURLConnection` 직접 사용 21곳,
`new RestTemplate()` 1곳(기본 팩토리라 `HttpURLConnection`), OkHttp 3.14.9 16곳. Apache HttpClient는 없다.

## 1. 현재 위치(`where`)

### 에이전트

- `Tracer.Tx`가 생성될 때 `Thread.currentThread()`를 `thread` 필드로 기억한다. `begin`은 요청 스레드에서 불린다.
- 전송 스레드가 `active(...)`를 만들 때 처리 중 트랜잭션마다 `thread.getStackTrace()`를 한 번 읽고
  `where(StackTraceElement[])` 결과를 `"where"` 필드로 보낸다. 주기는 전송 간격(기본 1초)과 같다.
- `where` 규칙:
  - 앱 프레임 = 위에서부터 처음으로 클래스 이름이 앱 패키지로 시작하고 `$$`를 포함하지 않는 프레임
    (`$$`는 CGLIB 프록시). 표시는 `단순클래스명.메서드:줄번호` (예: `EvlServiceImpl.selectList:120`).
  - 맨 위 프레임(`stack[0]`)이 앱 프레임이 아니면 뒤에 ` → 단순클래스명.메서드`를 붙인다
    (예: `EvlServiceImpl.selectList:120 → SocketInputStream.socketRead0`).
  - 앱 프레임이 없으면(앱 패키지를 모르거나 스택에 없음) 맨 위 프레임만. 스택이 비었으면 `null`.
- 앱 패키지:
  - 환경변수 `APM_APP_PACKAGE`가 있으면 그 값을 접두어로 쓴다.
  - 없으면 `sun.java.command`의 첫 토큰(main 클래스)에서 패키지를 뗀 값 + `.`
    (`org.kipa.ipfinance.Application` → `org.kipa.ipfinance.`).
  - main 클래스에 패키지가 없거나 `org.apache.`·`org.springframework.boot.loader.`로 시작하면
    (WTP 외부 Tomcat, fat jar 런처) 앱 패키지 없음.
- 기동 안내 줄에 앱 패키지를 함께 찍는다: `[apm] mini-apm agent → <수집 서버> (<에이전트>, 앱 패키지 <값|없음>)`.

### 대시보드

- 처리 중 목록은 요청당 최대 세 줄: ① 이름·경과 시간 ② `where` ③ `lastSpan`(마지막 SQL 또는 외부 호출).
  ②③은 값이 있을 때만, 한 줄로 자르고 `…`, 전체는 툴팁.
- Node 에이전트는 `where`를 보내지 않으므로 ②줄이 없다. 수집 서버는 `active` 항목을 그대로 넘기므로 바꾸지 않는다.

## 2. 외부 HTTP 구간

### 형식

- 구간 `type`은 `"http"`. Node 에이전트와 같은 모양이라 대시보드는 이미 `외부`로 그린다.
  Java의 `Span`에 `type` 필드를 추가하고, 지금 `"sql"`로 고정해 쓰는 JSON도 이 필드를 쓴다.
- `text`는 `메서드 + " " + 전체 URL`(쿼리 포함, Node와 같음). 길이는 SQL과 같은 `MAX_SQL`로 자른다.
- `error`:
  - 응답 코드 500 이상 → `HTTP <코드>`
  - 응답 코드를 못 받았는데 예외가 났다(연결 실패, 타임아웃) → 예외 메시지(없으면 클래스 이름)
  - 그 밖(2xx~4xx) → `null`. 4xx는 Node처럼 에러로 보지 않는다.
- 요청 밖(스레드에 트랜잭션 없음)의 호출은 기록하지 않는다. 에이전트 자신의 전송(`apm-sender` 스레드)도 여기에 해당한다.
- 바깥 호출 하나만 기록한다. SQL과 같은 스레드별 깊이 카운터를 쓴다(외부 호출과 SQL은 서로 겹쳐 불리지 않는다).

### `HttpURLConnection`

- 계측 대상: `sun.net.www.protocol.http.HttpURLConnection.getInputStream()` 하나(이름이 정확히 같은 클래스만).
  - `getResponseCode()`도 이 메서드를 거친다. 기본 모드에서는 POST 본문도 이 안에서 보낸다.
  - https는 `HttpsURLConnectionImpl`이 이 클래스를 상속한 위임 객체를 부르므로 같은 지점에서 한 번 잡힌다.
  - 응답 본문을 읽는 시간은 들어가지 않는다.
- 이미 응답을 받았거나 실패한 연결(`inputStream` 또는 `rememberedException` 필드가 채워짐)에 다시 부르는 `getInputStream()`은
  저장된 결과를 돌려줄 뿐이라 기록하지 않는다. 앱에서 흔한 "코드 먼저 보고 본문 열기" 순서가 구간 두 개가 되지 않게 한다.
- 응답 코드는 진입 후 `responseCode` 필드(`java.net.HttpURLConnection`의 protected 필드)를 직접 읽는다.
  `getResponseCode()`를 다시 부르면 실패한 연결을 재시도할 수 있어서 부르지 않는다.
- 이 클래스는 부트스트랩 로더가 올린다. 그래서:
  - 빌드가 `Tracer`(와 안쪽 클래스)만 담은 `dist/mini-apm-boot.jar`를 따로 만들고,
    에이전트 jar 매니페스트에 `Boot-Class-Path: mini-apm-boot.jar`를 넣는다(에이전트 jar 기준 상대 경로).
    에이전트 jar에는 `Tracer`를 넣지 않는다. 두 jar는 같은 폴더에 있어야 한다.
  - 기존 `AgentBuilder`와 별도의 `AgentBuilder`를 하나 더 만든다. 기본 무시 규칙(부트스트랩 클래스 제외)을 풀고
    대상 클래스를 이름으로만 고르며, 이미 로드된 경우를 위해 `RETRANSFORMATION`과 `disableClassFormatChanges()`를 쓴다.
    SQL·요청 계측의 매칭 규칙은 바꾸지 않는다(MyBatis의 부트스트랩 프록시가 계속 제외되도록).

### OkHttp

- 계측 대상: `okhttp3.RealCall.execute()`(3.x)와 `okhttp3.internal.connection.RealCall.execute()`(4.x 이름).
  4.x 이름은 테스트하지 않는다.
- 동기 호출만. 비동기 `enqueue`는 기록하지 않는다.
- Advice가 `call.request()`에서 메서드와 URL을, 반환된 `Response.code()`에서 응답 코드를 꺼내 `Tracer`에 문자열과 숫자로 넘긴다.
  `Tracer`는 OkHttp 타입을 모른다(부트스트랩에 있으므로). OkHttp jar는 컴파일 때만 쓴다.

### Tracer API

- `public static Span httpStart(String method, String url)`
- `public static void httpEnd(Span s, int code, Throwable thrown)` — `code`는 모르면 `-1`.

## 테스트

`test/java-agent.test.js`에 추가한다. 테스트 앱 클래스패스에 `okhttp 3.14.9`, `okio 1.17.2`를 넣는다.
Node 테스트가 127.0.0.1에 가짜 서버를 띄운다(`/ok` 200, `/err` 500, `/nf` 404). `TestApp`은 그 주소를 두 번째 인자로 받는다.
연결 실패용 포트는 `TestApp`이 `ServerSocket(0)`을 열었다 닫아서 얻는다. 테스트 앱은 `APM_APP_PACKAGE=TestApp`으로 띄운다.

- `/slow` 처리 중 항목의 `where`가 `TestApp$1.doGet:<줄> → Thread.sleep`.
- 기동 안내 줄에 `앱 패키지 TestApp`.
- `/http`(`HttpURLConnection`): 구간 4개, 순서대로
  1. `GET <stub>/ok` — `getResponseCode()` 뒤 `getInputStream()`, 에러 없음(반복 호출은 구간을 더 만들지 않는다)
  2. `GET <stub>/err` — `getInputStream()`이 예외 뒤 `getResponseCode()`, 에러 `HTTP 500`
  3. `GET <stub>/nf` — `getResponseCode()`, 에러 없음
  4. `GET https://127.0.0.1:<닫힌 포트>/` — 연결 실패, 에러에 `Connection refused`, https 위임에도 구간은 하나
- `/okhttp`: 구간 3개 — `/ok` 에러 없음, `/err` 에러 `HTTP 500`, 닫힌 포트 연결 실패 에러.
- 기존 테스트는 모두 그대로 통과한다(부트 jar 분리 후에도 요청·SQL 계측이 동작).

## 범위 밖

- OkHttp 비동기 호출, Apache HttpClient, WebClient.
- `HttpURLConnection` 응답 본문 읽기 시간.
- 앱 패키지 자동 판단(main 클래스) 경로의 자동 테스트. 테스트 앱이 기본 패키지라 환경변수 경로만 테스트하고,
  자동 판단은 IP-Finance 기동 안내 줄로 사람이 확인한다.
- 대시보드에 에이전트 이름 표시.
