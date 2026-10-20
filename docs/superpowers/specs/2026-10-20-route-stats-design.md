# API(URL)별 통계

## 목표

- "어떤 API가 느린가, 어떤 API가 많이 불리나"를 점을 하나하나 보지 않고 표 하나로 안다.
- 경로 안의 값(`/qna/P001/list`, `/qna/P002/list`)은 Spring 매핑 패턴(`/qna/{procsCode}/list`)으로 한 줄에 모인다.
- 최근 10분과 수집 서버를 켠 뒤 전체를 바꿔 본다.
- 표의 한 줄을 누르면 그 API의 트랜잭션 목록이, 거기서 한 줄을 누르면 지금처럼 상세가 나온다.
- 대상 앱 코드와 Eclipse 설정은 그대로.

## 1. Java 에이전트: `route`

- 요청이 끝날 때(`RequestAdvice` 나가기, `RequestInfo.collect` 안에서) 요청 속성
  `org.springframework.web.servlet.HandlerMapping.bestMatchingPattern`을 읽어 `toString()`한다
  (`String`이든 Spring 5.3 `PathPattern`이든 패턴 글자가 나온다).
- 패턴을 쓰는 조건(모두 맞아야 한다):
  - `*`·`?`가 없다(정적 파일·404를 받는 `/**` 등을 거른다).
  - `getRequestURI()`에서 `getContextPath()`를 뺀 경로와 `/`로 나눈 조각 수가 같다(빈 끝 조각은 버린다).
  - 조각마다 글자가 같거나, 패턴 조각이 `{`로 시작하고 `}`로 끝난다(`{id}`, `{id:.+}`).
  - 에러로 `/error`에 넘어가 패턴이 바뀐 요청은 이 조건에 걸러진다.
- 맞으면 `route` = `메서드 + " " + 컨텍스트 경로 + 패턴`(예: `GET /KIPA_IP-Finance/qna/{procsCode}/list`). 아니면 `null`.
- 트랜잭션 JSON에 `"route": "…"` 또는 `"route": null`을 더한다.
- 읽다가 무엇이 실패해도 `route`만 `null`이고 다른 요청 정보와 응답에는 영향이 없다.
- Node 에이전트는 바꾸지 않는다(`route` 없음).

## 2. 수집 서버

### 묶는 단위

- 키 = `route`(비어 있지 않은 문자열일 때) 또는 `name`. 앱(에이전트 이름)마다 따로 묶는다.

### 최근 10분

- 지금 보관 중인 트랜잭션(`KEEP_MS` 10분)으로 요청받을 때 계산한다.
- 값: `count`, `errors`(`error`가 있는 수), `avg`, `p95`(기존 `p95` 함수), `max`, `total`(응답시간 합). 시간은 ms, 반올림.

### 서버 켠 뒤 전체

- 트랜잭션을 저장할 때(`ingest`, 중복 id 제외) 키마다 `count`, `errors`, `total`, `max`, 응답시간 구간별 개수를 더한다.
- 구간: `i = ms < 1 ? 0 : floor(log(ms) / log(1.1)) + 1`. `p95` = 개수를 작은 구간부터 더해 95%(`ceil(0.95 × count)`)에 닿는 구간의
  위 경계(`1.1^i`), `max`보다 크면 `max`. 오차는 약 10% 이내(구간은 쓰인 것만 Map에 둔다).
- 앱마다 키는 2,000개까지. 이미 2,000개인데 새 키가 오면 `(기타)`에 더한다.
- 수집 서버 메모리에만 있다. 다시 띄우면 0부터.

### 주소

- `GET /routes?range=all`: 서버 켠 뒤 전체. `range`가 없거나 다른 값이면 최근 10분.
  응답: `{ range: "10m"|"all", rows: [{ agent, key, count, errors, avg, p95, max, total }] }`. 순서는 정하지 않는다(정렬은 대시보드).
- `GET /routes/txs?agent=<앱>&key=<키>`: 최근 10분 트랜잭션 가운데 그 앱·키의 점(`/stream`의 점과 같은 모양)을 응답시간이 긴 순으로.
  `(기타)`는 해당하는 트랜잭션이 없으므로 빈 목록. 둘 중 하나라도 없으면 빈 목록.

## 3. 대시보드: "API별 통계" 패널

- 위치: "최근 에러" 아래, "고른 트랜잭션" 위.
- 머리글 줄에 `[최근 10분] [서버 켠 뒤 전체]` 버튼. 고른 쪽이 켜진 모양(앱 버튼과 같은 `on`).
- 열: `API`, `횟수`, `에러`, `평균(ms)`, `p95(ms)`, `최대(ms)`, `총 시간(s)`(소수 한 자리).
  전체 기간의 p95는 앞에 `≈`.
- 정렬: 머리글을 누르면 그 열로. 같은 열을 다시 누르면 방향을 뒤집는다. 새 열은 숫자면 큰 순, `API`면 가나다순.
  기본은 `총 시간` 큰 순. 정렬 중인 열 머리글 끝에 `▼`/`▲`.
- 위에서 고른 앱만. 앱을 안 골랐으면 모든 앱이고 `API` 칸 앞에 `[앱]`.
- 50줄까지, 넘으면 `… 외 N개`. 없으면 `없음`.
- 에러가 1 이상인 칸은 빨강(`err`).
- 5초마다, 그리고 기간·앱을 바꿀 때 `/routes`를 다시 받는다. 받기에 실패하면 표는 그대로 둔다.
- 줄을 누르면 `/routes/txs`로 받아 "고른 트랜잭션" 표에 보인다(기존 `showPicked`). 비었으면 그 표에
  `최근 10분 안에 이 API 요청이 없습니다.` 한 줄.
- 고른 기간과 정렬은 이 브라우저에 기억한다(`apm.routeRange`, `apm.routeSort`). 저장소가 막혀도 기본값으로 동작.

## 테스트

- 수집 서버(`test/` Node 테스트):
  - 같은 `route`, 다른 `name` 두 건 → 한 줄, `count` 2. `route` 없는 건은 `name`으로. 앱이 다르면 다른 줄.
  - 최근 10분: `avg`·`p95`·`max`·`total`·`errors` 값.
  - 전체: 10분이 지나 `prune`된 뒤에도 남는다. `p95` 근사가 정확한 값의 10% 안. 2,001번째 키는 `(기타)`.
  - `/routes`, `/routes?range=all`, `/routes/txs`(느린 순, 다른 앱·키 제외, 빠진 인자 → 빈 목록).
- Java(`test/java-agent.test.js`, 테스트 앱에 Spring 없음 → 서블릿이 속성을 직접 넣는다):
  - `/items/7` + 패턴 `/items/{id}` → `route` `GET /items/{id}`.
  - `/other/1` + 패턴 `/error` → `route` null.
  - `/ctx/items/8`(컨텍스트 경로 `/ctx`) + 패턴 `/items/{id}` → `route` `GET /ctx/items/{id}`.
  - `/files/a` + 패턴 `/**` → `route` null(`.js` 같은 정적 파일은 에이전트가 아예 기록하지 않으므로 확장자 없는 주소로).
  - 패턴 없는 `/hello` → `route` null.
- 대시보드: 정렬 계산은 `calc.mjs` 함수로 Node 테스트. Playwright로 표·정렬·기간 전환·줄 클릭 → 고른 트랜잭션 확인.

## 범위 밖

- 통계를 파일·DB에 남기기, 시간대별 추이 그래프, 화면(Referer)별 묶기.
- Node 에이전트의 경로 패턴(Express `req.route` 등).
- Spring이 아닌 프레임워크의 패턴.
