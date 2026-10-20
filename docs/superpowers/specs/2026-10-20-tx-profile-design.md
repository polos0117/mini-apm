# 트랜잭션 상세 프로파일: 앱 메서드 흐름, MyBatis SQL ID, 요청 정보 (Java 에이전트)

## 목표

- 트랜잭션 상세에서 SQL만이 아니라 어떤 Controller → Service → 매퍼를 거쳤는지, 누가 어느 화면에서 무엇을 보냈는지 보인다.
- 대상 앱 코드와 Eclipse 설정은 그대로(필요하면 환경변수만).
- 같은 브랜치의 `2026-10-20-exception-errors-design.md`(예외 구간)와 함께 구현한다. 예외 구간도 아래 `depth` 규칙을 따른다.

대상 앱: 이름이 `Controller`(254), `ServiceImpl`(297), `Service`(10)로 끝나는 클래스, `@MapperScan` 매퍼 인터페이스(705),
MyBatis 3.5.6, Spring Security 5.4.5, 세션 속성 `loginUser`(`LoginUser`).

## 1. 구간 공통: `depth`

- 모든 Java 구간에 `depth`(정수, 0부터)를 더한다. 스레드의 트랜잭션에 "지금 열린 메서드·매퍼 구간 수"(`Tx.level`)를 두고,
  구간을 만들 때의 `level`이 그 구간의 `depth`다.
- 메서드·매퍼 구간은 들어갈 때 열고(`level++`), 나올 때 닫는다(`level--`). 구간을 만들었을 때만 올리고 그 구간을 닫을 때 내린다
  (한도에 걸려 구간을 못 만들면 그 뒤 구간도 모두 못 만들므로 들여쓰기가 어긋날 일이 없다).
- 구간은 지금처럼 시작 순서대로 `spans`에 쌓는다. 그래서 목록 순서 + `depth`로 들여쓴 나무가 된다.
- Node 에이전트는 바꾸지 않는다(`depth` 없음 = 0).

## 2. 앱 메서드 구간(`type: "method"`)

- 대상 클래스: 이름이 앱 패키지(`Tracer.appPackage`)로 시작하고 `Controller`·`ServiceImpl`·`Service`로 끝나며,
  `$`를 포함하지 않고(Spring CGLIB 프록시 `$$…`, 안쪽 클래스 `$1`), 인터페이스가 아닌 클래스.
  앱 패키지가 `null`이면 메서드 구간을 계측하지 않는다.
- 대상 메서드: public, static 아님, 생성자 아님, synthetic 아님, `toString`·`equals`·`hashCode` 아님, abstract 아님.
  getter·setter는 서비스 클래스에서만 뺀다(최종 검토 후 변경: 컨트롤러의 `getAcnutList()`처럼 `@GetMapping` 요청 처리 메서드가 getter 모양일 수 있다).
- `text` = `단순클래스명.메서드명`(예: `EvlServiceImpl.saveEvl`).
- 메서드가 예외를 던지며 끝나면 그 구간 `error` = `단순클래스명: 메시지`(메시지 null이면 이름만). 요청 에러 판단에는 쓰지 않는다
  (요청 에러는 예외 스펙의 규칙대로: 예외 로그 → 500 → 없음).
- 요청 밖(트랜잭션 없음)에서는 아무것도 하지 않는다.
- SQL·외부 호출의 깊이 카운터(`DEPTH`)와는 따로다. 메서드 안의 SQL은 그대로 기록된다.

## 3. 매퍼 구간(`type: "mapper"`)

- 계측 대상: `org.apache.ibatis.executor.Executor`를 구현한 클래스(인터페이스 제외. `BaseExecutor`처럼 추상 클래스라도 몸체가 있는 메서드는 포함)의
  `query(MappedStatement, Object, RowBounds, ResultHandler)`(인자 4개)와 `update(MappedStatement, Object)`.
  `CachingExecutor`가 `SimpleExecutor`에 넘기는 식으로 겹쳐 불리므로 스레드별 깊이로 바깥 한 번만 기록한다.
- `text` = 첫 인자 `MappedStatement.getId()`에서 namespace의 단순 이름 + `.` + id
  (`org.kipa…EvlMapper.insertResult` → `EvlMapper.insertResult`). id에 `.`이 없으면 그대로.
- 예외로 끝나면 `error` = `단순클래스명: 메시지`.
- Advice는 MyBatis 타입에서 문자열을 꺼내 `Tracer`에 넘긴다. MyBatis jar는 빌드할 때 컴파일 클래스패스에만 쓴다.

## 4. 처리 중 목록의 `lastSpan`

- 지금처럼 마지막 SQL 또는 외부 구간의 `text`(1,000자 자름). 메서드·매퍼·예외 구간은 건너뛴다.

## 5. 요청 정보(`req`)

- 요청이 끝날 때(`RequestAdvice` 나가기) 읽어 트랜잭션 JSON에 `"req": { ip, user, referer, params }`로 붙인다. 값이 없으면 `null`.
  - `ip`: `X-Forwarded-For` 헤더의 첫 값(쉼표 앞, 앞뒤 공백 제거), 없으면 `getRemoteAddr()`.
  - `referer`: `Referer` 헤더.
  - `user`: 기존 세션이 있을 때만(`getSession(false)`).
    1. 세션 속성 `SPRING_SECURITY_CONTEXT` → `getAuthentication()` → `getName()`(리플렉션, 공개 메서드).
    2. 없으면 세션 속성 `APM_USER_ATTR`(기본 `loginUser`) 값이 문자열이면 그대로, 객체면
       `getUserId`·`getUsername`·`getLoginId`·`getId` 가운데 처음 있는 인자 없는 공개 메서드의 결과를 문자열로.
    3. 그래도 없으면 `null`. 세션이 무효화됐거나 리플렉션이 실패하면 `null`(앱 응답에 영향 없음).
  - `params`: `getParameterMap()`을 `이름=값&…` 모양으로(값 여러 개면 이름을 반복). 이름(소문자)에
    `pass`·`pw`·`secret`·`token`·`jumin`·`rrn`·`ssn`이 들어가면 값을 `****`로. 값 하나는 `MAX_PARAM`(200자, 넘으면 `...`),
    전체는 2,000자에서 자르고 `...`. 파라미터가 없으면 `null`.
- JSON 본문은 읽지 않는다(앱의 요청 스트림을 건드리지 않기 위해).
- 정리하는 코드는 에이전트 jar의 `apm.RequestInfo`(서블릿 타입 사용)에 두고, `Tracer`에는 문자열만 넘긴다.

## 6. 대시보드 트랜잭션 상세

- 제목 줄 아래 한 줄: `사용자 hong01 · IP 127.0.0.1 · 화면 /…/evl/list · 파라미터 evlId=123`. 값이 있는 것만, 하나도 없으면 줄 없음.
  긴 값은 줄바꿈해 다 보인다.
- 구간 종류: `method` → `메서드`, `mapper` → `매퍼`, `sql` → `SQL`, `http` → `외부`, `exception` → `예외`.
- 내용 칸을 `depth × 16px` 들여쓴다.
- 메서드·매퍼 막대는 흐린 색(`--dim`), 에러면 빨강. SQL·외부는 지금 색.
- "앱 자체 처리" = 전체 시간 − `depth`가 0(또는 없음)인 구간들의 시간 합.

## 테스트

`test/java-agent.test.js`. 테스트 앱 클래스패스에 `mybatis 3.5.6`을 넣는다. 테스트 앱 클래스는 기본 패키지라 `APM_APP_PACKAGE=TestApp`.

- `/flow`: `TestAppOrderController.save(1)` → `TestAppOrderServiceImpl.saveOrder(1)`(안에서 getter 하나 호출) →
  MyBatis 매퍼 `TestAppItemMapper.name(1)`(`@Select`, Derby `item` 테이블) → SQL.
  구간 = `[method TestAppOrderController.save d0, method TestAppOrderServiceImpl.saveOrder d1, mapper TestAppItemMapper.name d2, sql … d3]`.
  getter·`$$` 클래스 구간 없음.
- `/flowfail`: 서비스 메서드가 `IllegalStateException("재고 없음")`을 던지고 컨트롤러가 잡아 200.
  서비스 구간 `error` = `IllegalStateException: 재고 없음`, 요청 `error`는 null(로그를 안 남겼으므로).
- `/req?x=1&password=secret&x=2`: `Referer: http://localhost/list`, `X-Forwarded-For: 10.0.0.9, 10.0.0.1`,
  세션에 가짜 Spring Security 객체(이름 `hong01`).
  `req` = `{ ip: '10.0.0.9', user: 'hong01', referer: 'http://localhost/list', params: 'x=1&x=2&password=****' }`(이름 순서는 `getParameterMap` 순서).
- `/req2`: 세션에 `loginUser` = `getUserId()`가 `kim02`인 객체 → `user` `kim02`. 세션 없는 `/hello`는 `user` null, `params` null.
- 처리 중 목록: `/flow`류 요청의 `lastSpan`이 메서드 이름이 아니라 SQL.
- 대시보드: Playwright로 들여쓰기·종류·요청 정보 줄을 확인.

## 범위 밖

- JSON 본문, 헤더 전체, User-Agent.
- 앱 패키지 밖 클래스(프레임워크, 유틸)의 메서드, `Controller`·`Service` 이름 규칙을 안 따르는 클래스.
- 메서드 구간이 구간 한도(1,000)를 먼저 채워 SQL이 생략되는 경우의 별도 처리.
