# 미니 APM

JENNIFER 같은 APM(애플리케이션 성능 모니터링)이 어떻게 동작하는지 직접 만들어 보는 학습용 프로젝트.
Node 22 기본 기능만 쓴다(외부 라이브러리 없음). Java 에이전트만 Byte Buddy를 jar에 담아 쓴다.

## 실행

PowerShell에서 이 폴더로 이동하면 fnm이 `.node-version`을 읽어 Node 22로 바꿔 준다.

```powershell
npm run demo        # 동시 사용자 10명
npm run demo -- 30  # 30명
npm test
```

Git Bash에서는 `fnm exec --using=22 node demo.js`, `fnm exec --using=22 npm.cmd test`.

브라우저에서 http://localhost:7700 을 연다. 끝내려면 Ctrl+C.

맨 위 메뉴에서 [실시간]과 [API별 통계]를 오간다(`http://localhost:7700/#stats`로 바로 열 수 있다). 경보(에러 난 요청, 앱 끊김)는 어느 메뉴에서든 대시보드 탭이 열려 있을 때만 울린다. 다른 창을 보고 있을 때 Windows 알림을 받으려면 맨 위 [알림 켜기]를 한 번 누른다.

| 포트 | 프로세스 |
|---|---|
| 7700 | 수집 서버 + 대시보드 |
| 7701 | 샘플 앱 (`node --require ./agent sample/app.js`) |
| 7702 | 결제 서비스 (에이전트 없음 = 외부 시스템) |

## JENNIFER와 대응

| 이 프로젝트 | JENNIFER | 배울 점 |
|---|---|---|
| `agent/index.js` + `--require` | `-javaagent` 바이트코드 계측 | 앱 코드를 고치지 않고 런타임 함수를 바꿔 끼우는 법 |
| `AsyncLocalStorage` | 스레드 로컬(Java) | 비동기 흐름을 따라 '지금 어느 요청인가'를 이어 가는 법 |
| span (`sql`, `http`) | 프로파일(SQL, 외부 호출) | 응답시간을 구간별로 쪼개 원인을 찾는 법 |
| 처리 중인 요청 | 액티브 서비스 | 끝난 요청이 아니라 지금 멈춰 있는 요청을 보는 이유 |
| X-View 산점도 + 드래그 | X-View | 평균이 숨기는 느린 요청을 점 하나하나로 보는 법 |
| p95 | 응답시간 백분위 | 평균과 p95가 갈라지는 순간이 문제의 신호 |
| 에이전트의 `try/catch`, 버퍼 상한 | 에이전트 안정성 | 모니터링 도구가 앱을 망가뜨리면 안 된다 |
| 앱 버튼 + 최근 에러 + 경보(`dashboard/alerts.mjs`) | 도메인/인스턴스 선택, 이벤트·경보 | 경보는 '처음 본 순간'만 알리고 반복은 묶어야 쓸 만하다 |
| API별 통계(`/routes`, Spring 패턴으로 묶기) | 서비스 통계(URL별 호출 수·응답시간) | 총 시간(느림 × 많이 불림) 순으로 보면 서버 시간을 가장 많이 쓰는 곳이 맨 위에 온다 |
| X-View 끌기 → 무엇이 다른가(`POST /compare`) | X-View 끌기 → 목록 (비교는 Honeycomb BubbleUp·Datadog Watchdog Insights) | 느린 점을 하나씩 열기 전에, 나머지와 비율이 크게 다른 값(API·사용자·화면·매퍼)부터 보면 원인 후보가 좁혀진다 |
| 타일 추이선(연결 첫 메시지의 `series`) + 액티브 이퀄라이저 | 대시보드 TPS·응답시간 차트, 액티브 서비스 이퀄라이저 | 숫자 하나보다 5분 흐름을, 처리 중 목록보다 구간별 막대(1·3·8초)를 보면 '어느 앱이 언제부터 막히나'가 먼저 보인다 |

## 샘플 앱의 일부러 넣은 증상

| 경로 | 증상 | 상세 화면에서 보이는 모습 |
|---|---|---|
| `GET /orders` | 상관 하위 쿼리 + 인덱스 없음 | SQL 막대가 대부분 |
| `POST /checkout` | 느리고 가끔 실패하는 결제 호출 | 외부 막대가 대부분, 실패 시 빨강 |
| `GET /report` | 무거운 계산 | "앱 자체 처리"가 대부분 |
| `GET /boom` | 예외 → 500 | 에러 점 |

### 직접 확인해 볼 APM의 맹점

`node:sqlite`는 동기식이라 느린 SQL이 도는 동안 다른 요청은 소켓에서 기다린다. 그런데 에이전트는 `'request'` 이벤트가 온 순간부터 재기 때문에, **그 대기 시간은 응답시간에 잡히지 않는다**(`/products`는 화면상 1ms 안팎이지만 실제 사용자는 수백 ms를 기다린다). 대신 이미 진행 중이던 외부 호출은 응답을 처리할 차례가 늦게 와서 **실제보다 길게** 측정된다(결제 서비스는 최대 2초인데 `/checkout`의 외부 구간이 3~4초로 찍힌다). 앱 안에서 재는 APM이 무엇을 볼 수 있고 무엇을 못 보는지 생각해 보기 좋은 지점이다.

## Java 에이전트 (`agent-java/`)

같은 수집 서버·대시보드를 Java 앱에 붙인다.
- `-javaagent`로 앱 소스를 고치지 않고, 클래스가 로드될 때 바이트코드에 계측 코드를 끼워 넣는다. JENNIFER와 같은 방식이다.
- 대상은 Java 8 이상의 내장 Tomcat 앱(Spring Boot 2.x)이다.

```powershell
npm run build:java        # agent-java/dist/mini-apm-agent.jar + mini-apm-boot.jar (같은 폴더에 둔다)
node collector/server.js  # 수집 서버만 따로 띄울 때
```

Eclipse 실행 설정(Run Configurations → 해당 Application)에 두 가지를 넣는다.
- **Arguments → VM arguments**: `-javaagent:C:/Users/jjshs/mini-apm/agent-java/dist/mini-apm-agent.jar`
- **Environment**: `APM_AGENT=ipfinance` (보내는 쪽 이름. 대시보드 맨 위 앱 버튼에 이 이름이 나온다. EVL은 `evl`)
- **Environment(선택)**: `APM_APP_PACKAGE=org.kipa.ipfinance.` — 처리 중 목록의 "현재 위치"에서 앱 메서드를 고를 때 쓰는 클래스 이름 접두어. 없으면 main 클래스의 패키지를 쓰고, WTP 외부 Tomcat처럼 main이 Tomcat이면 맨 위 프레임만 보인다. 트랜잭션 상세의 메서드 흐름도 이 접두어로 고른다(없으면 메서드 흐름 없음).
- **Environment(선택)**: `APM_USER_ATTR=loginUser` — 상세의 사용자를 읽을 세션 속성 이름(Spring Security가 먼저).

앱 콘솔에 `[apm] mini-apm agent → ... (ipfinance, 앱 패키지 org.kipa.ipfinance.)` 한 줄이 보이면 붙은 것이다.

SQL 구간에는 바인드 값이 끼워 넣어진 문장이 보인다(예: `where id = 7 and name = '홍길동'`). **DB의 실제 데이터가 대시보드에 그대로 보이므로**, 수집 서버는 이 PC(`127.0.0.1`)에서만 접속을 받는다.

SQL 문장은 10만 자까지 그대로 보이고, 바인드 값 하나는 200자에서 잘라 `...`을 붙인다.

빌드는 JDK 8(`APM_JAVA_HOME`)과 Byte Buddy 1.10.20(`APM_BYTEBUDDY_JAR`)을 쓴다. 기본값은 `D:\AnyBuilder` 아래 경로다.

| 에이전트 | JENNIFER | 여기서 배우는 것 |
|---|---|---|
| `Agent.premain` | `-javaagent` | 앱 main보다 먼저 실행되는 진입점 |
| `RequestAdvice` → `StandardHostValve.invoke` | 서블릿 트랜잭션 계측 | 어느 지점을 감싸야 필터 시간까지 잡히는가 |
| `SqlAdvice` + 깊이 카운터 | JDBC 계측 | 커넥션 풀·로깅 프록시가 겹쳐도 SQL 하나를 한 번만 세는 법 |
| `PrepareAdvice` | SQL 문장 수집 | `PreparedStatement`에서 SQL을 얻으려면 만들 때 잡아야 한다 |
| `HttpAdvice` + `Boot-Class-Path` | 외부 호출 계측 | JDK 클래스에 넣은 계측 코드가 에이전트 클래스를 보려면 부트스트랩 로더에 올려야 한다 |
| 처리 중 목록의 현재 위치 | 액티브 서비스 스택 | 끝나지 않은 요청이 어디서 멈췄는지는 그 스레드의 스택으로 본다 |
| `LogAdvice`·`PrintAdvice` | 예외 이벤트 | 앱이 잡아서 로그로만 남긴 예외도 '에러'로 봐야 경보가 산다 |
| `MethodAdvice`·`MapperAdvice` | 메서드 프로파일 | 어느 Controller→Service→매퍼가 그 SQL을 불렀는지 |

### Java 에이전트의 한계
- **비동기 컨트롤러**: `DeferredResult`나 `CompletableFuture`를 반환하는 컨트롤러는 처리 스레드가 바뀐다. 그러면 SQL 구간을 놓친다. 트랜잭션은 스레드에 붙어 있기 때문이다.
- **외부 호출**: `HttpURLConnection`(`RestTemplate` 기본 포함)과 OkHttp 동기 호출만 기록한다. OkHttp `enqueue`, Apache HttpClient, WebClient는 "앱 자체 처리"에 섞인다. `HttpURLConnection`은 연결부터 응답 헤더를 받을 때까지만 재고, 응답 본문을 읽는 시간은 빠진다. Java 17 이상에서는 Byte Buddy 1.10.20이 JDK 클래스를 못 읽어 `HttpURLConnection`이 기록되지 않는다(기동 시 `[apm] 계측 실패`).
- **정적 파일 판단**: 확장자(`js css png jpg gif svg ico woff woff2 map`)로만 판단한다.
- **메서드 흐름**: 앱 패키지의 이름이 `Controller`·`ServiceImpl`·`Service`로 끝나는 클래스의 public 메서드만. 반복문 속 서비스 호출이 많으면 구간 한도(1,000)를 먼저 채워 뒤 SQL이 생략될 수 있다.
- **요청 정보**: JSON 본문은 읽지 않는다(React 화면의 POST는 파라미터가 비어 보인다).
- **API별 묶기**: Spring MVC가 고른 매핑 패턴이 실제 경로와 맞을 때만 패턴으로 묶는다. 패턴이 없는 요청(필터가 직접 응답, 정적 파일, 404)은 주소 그대로 묶인다. 에러로 `/error`에 넘어간 요청은 넘어가기 직전(`ApplicationDispatcher.forward`)의 패턴으로 묶인다. "서버 켠 뒤 전체"는 수집 서버 메모리에만 있어 다시 띄우면 0부터이고, p95는 약 10% 오차의 근사다.
- **예외**: Logback ERROR와 `printStackTrace()`만. WARN, Log4j2·java.util.logging에 직접 남긴 로그는 빠진다.
- **요청 밖의 SQL**: Quartz 배치처럼 요청 밖에서 도는 SQL은 기록하지 않는다.
- **배치 실행의 바인드 값**: `addBatch`를 여러 번 한 뒤 `executeBatch`하면 마지막 행의 값만 보인다.
- **커넥션 확인 쿼리**: 한동안 쉬던 커넥션을 쓰는 요청에는 Hikari의 `SELECT 1`이 구간으로 하나 더 보인다. 실제로 DB에 다녀온 시간이다.

## 다음 학습 후보

분산 추적(서비스 간 ID 전달), CPU·메모리 수집, `node:sqlite`로 시계열 디스크 저장, 여러 서버 묶기, 경보.
