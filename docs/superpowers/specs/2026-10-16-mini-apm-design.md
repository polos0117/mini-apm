# 미니 APM 설계 (JENNIFER 학습용)

날짜: 2026-10-16

## 목적과 범위

JENNIFER 같은 APM(애플리케이션 성능 모니터링)이 어떻게 동작하는지 **직접 만들어 보며 배우는** 학습용 프로젝트다. 운영 서버 감시용이 아니다.

- 에이전트 → 수집 서버 → 대시보드의 전체 흐름을 모두 직접 만든다.
- Node 22(설치본 22.23) 기본 기능만 쓴다. **외부 라이브러리 0개.** (`package.json`은 scripts만)
- 감시 대상은 직접 만든 샘플 앱이다.
- 위치: `C:\Users\jjshs\mini-apm`, 로컬 git 저장소. GitHub에 올리지 않는다.

**성공 기준**: `npm run demo` 후 `http://localhost:7700`을 열면 X-View 산점도에 점이 1초마다 찍히고, 영역을 드래그해 고른 느린 트랜잭션을 누르면 시간이 SQL·외부 호출·앱 자체 처리 중 어디에 쓰였는지 보인다. `npm test`가 통과한다.

## 전체 구조

```
샘플 앱(7701) + 에이전트 ──1초마다 POST──▶ 수집 서버(7700) ──SSE 1초마다──▶ 대시보드(브라우저)
        │ fetch
        ▼
결제 서비스(7702, 에이전트 없음 = 외부 시스템)
부하 발생기 ──▶ 샘플 앱
```

| 포트 | 프로세스 |
|---|---|
| 7700 | 수집 서버 + 대시보드 파일 제공 |
| 7701 | 샘플 앱 (`node --require ./agent sample/app.js`) |
| 7702 | 결제 서비스 |

## 1. 에이전트 (`agent/index.js`)

`node --require ./agent app.js`로 앱보다 먼저 로드된다. 앱 코드는 고치지 않는다. (JENNIFER의 `-javaagent` 바이트코드 계측을 JS 함수 가로채기로 대신한다.)

### 트랜잭션 형태

```js
{ id, name: 'GET /orders', start, elapsed, status, error,
  spans: [{ type: 'sql' | 'http', text, offset, elapsed, error }] }
```

- `id`: 에이전트 안에서 고유한 문자열 (`crypto.randomUUID()`).
- `name`: `메서드 + 경로`(쿼리스트링 제외).
- `start`: 시작 시각(`Date.now()`, ms). `elapsed`: 걸린 시간(ms, `performance.now()` 차이).
- `error`: 상태 코드 500 이상이면 에러. 값은 마지막으로 실패한 span의 메시지, 없으면 `HTTP <상태>`. 아니면 `null`. (앱이 예외를 잡아 500으로 응답하므로 에이전트는 상태 코드로 에러를 안다. 처리기 밖으로 던져진 예외는 Node 기본 동작대로 둔다.) span의 `error`는 SQL·fetch가 던진 예외 메시지, 또는 fetch 응답이 500 이상이면 `HTTP <상태>`.
- span의 `offset`: 트랜잭션 시작부터 그 호출 시작까지의 ms.

### 가로채는 지점

| 대상 | 방법 | 기록 |
|---|---|---|
| 들어오는 HTTP | `http.Server.prototype.emit`을 감싸 `'request'` 이벤트일 때 `AsyncLocalStorage.run(tx, …)` 안에서 원래 `emit` 실행. 응답 `finish`/`close` 중 먼저 오는 쪽에서 종료(한 번만) | 시작·끝, 상태 코드, 예외 |
| SQL | `node:sqlite`의 `DatabaseSync.prototype.prepare`를 감싸, 처음 돌려받은 문장 객체의 프로토타입(`StatementSync.prototype`)의 `run`/`get`/`all`을 감싼다. `DatabaseSync.prototype.exec`도 감싼다 | `sourceSQL`(exec는 인자 SQL), 시간, 예외 |
| 나가는 호출 | `globalThis.fetch`를 감싼다 | `메서드 URL`, 시간, 실패(예외 또는 상태 500 이상) |

SQL·fetch 래퍼는 `als.getStore()`로 현재 트랜잭션을 찾아 `spans`에 붙인다. 트랜잭션 밖의 호출(앱 시작 시 데이터 적재 등)은 기록하지 않는다. 래퍼는 원래 함수의 반환값·예외를 그대로 돌려준다.

### 처리 중인 요청

끝나지 않은 트랜잭션을 `Map`에 둔다. 전송 시 `{ id, name, elapsed(현재까지), lastSpan(마지막 span의 text 또는 null) }` 목록으로 보낸다.

### 전송

- 끝난 트랜잭션을 버퍼에 모아 1초마다 `POST http://localhost:7700/ingest`로 `{ agent: 'sample', txs, active }`를 보낸다.
- 수집 서버 주소는 환경변수 `APM_COLLECTOR`, 전송 주기는 `APM_INTERVAL`(ms, 기본 1000)로 바꿀 수 있다(테스트용).
- 트랜잭션당 span은 1,000개까지 기록하고, 넘는 호출은 `droppedSpans`에 개수만 센다(대시보드 상세에 "호출 N개 생략").
- 버퍼 최대 5,000건, 넘으면 오래된 것부터 버린다. 전송 실패 시 그 묶음은 버린다.
- 전송용 fetch는 원래 fetch를 써서 자기 자신을 계측하지 않는다.

### 앱을 다치게 하지 않는다

- 에이전트 자체 로직(트랜잭션 기록·전송)은 `try/catch`로 감싸 앱으로 오류가 번지지 않게 한다.
- 타이머는 `unref()`.

## 2. 수집 서버 (`collector/server.js`, `collector/store.js`)

`node:http`, 포트 7700. `store.js`는 HTTP와 무관한 순수 저장·통계 로직(테스트 대상).

| 경로 | 용도 |
|---|---|
| `POST /ingest` | 에이전트 데이터 수신. 본문 1MB 초과·JSON 오류는 400 |
| `GET /stream` | SSE. 연결 즉시 최근 5분 점과 통계 한 번, 이후 1초마다 새 데이터 |
| `GET /tx/:id` | 트랜잭션 상세(spans 포함). 없으면 404 |
| `GET /`, `GET /<파일>` | `dashboard/` 폴더 파일 제공(`.mjs`는 `text/javascript`). 폴더 밖 경로는 404 |

### 저장 (메모리)

- 트랜잭션: 끝난 시각 순 배열 + `id → tx` 맵. 1초마다 끝난 시각이 10분 지난 것을 지운다.
- 처리 중인 요청: 에이전트별 최신 목록 하나(받을 때마다 덮어씀). 5초간 수신이 없는 에이전트는 제외.
- 재시작하면 데이터는 사라진다.

### 초당 통계

받은 트랜잭션을 **끝난 시각의 초** 단위로 묶어 `{ t, tps, avg, p95, errors }`를 계산한다. p95는 그 초의 응답시간을 정렬해 `ceil(0.95 × n) − 1`번째 값(n=0이면 0). 별도 보관 없이 저장된 트랜잭션에서 그때그때 계산한다.

### SSE 메시지

```js
{ points: [{ id, name, t, elapsed, error }],   // t = 끝난 시각(ms), error = true/false
  stats: { tps, avg, p95, errors },       // 2초 전의 1초 (에이전트가 1초마다 묶어 보내므로 늦게 도착하는 몫을 기다린다)
  active: [{ id, name, elapsed, lastSpan }] }
```

상세(spans)는 SSE로 보내지 않고 `/tx/:id`로 따로 가져온다.

## 3. 대시보드 (`dashboard/index.html`, `dashboard/app.mjs`, `dashboard/calc.mjs`)

PC 브라우저 기준. 차트 라이브러리 없이 `<canvas>`. 화면 문구는 한국어, 업계 표준 용어는 괄호 병기(예: "초당 처리량(TPS)").

```
┌ 초당 처리량(TPS) │ 평균 응답 │ 응답 95%(p95) │ 에러 ┐
├──────────────────────────────┬────────────┤
│ X-View 산점도                     │ 처리 중인 요청 │
├──────────────────────────────┴────────────┤
│ 고른 트랜잭션 목록                                    │
├───────────────────────────────────────────┤
│ 트랜잭션 상세                                        │
└───────────────────────────────────────────┘
```

### X-View

- 가로 = 끝난 시각(최근 5분, 1초마다 왼쪽으로 흐름), 세로 = 응답시간(ms).
- 세로 최댓값: 보이는 점의 최댓값 이상인 첫 단계(1초·3초·5초·10초, 넘으면 최댓값을 1초 단위로 올림).
- 정상 점은 파랑, 에러 점은 빨강.
- 마우스 드래그로 사각형을 그리면 그 안의 점(시각·응답시간 범위)을 목록에 표시. 목록은 응답시간 긴 순.

### 트랜잭션 상세

목록 한 줄을 누르면 `/tx/:id`를 가져와 표시한다.

- 머리줄: 이름, 응답시간, 상태 코드, 에러 메시지.
- span마다 한 줄: 종류(SQL/외부), 텍스트, `offset`·`elapsed` 비율대로 그린 시간 막대, ms.
- 마지막 줄 "앱 자체 처리" = 전체 `elapsed` − span `elapsed` 합(0 미만이면 0).

### 처리 중인 요청

진행 시간 긴 순. 1초 미만 기본색, 1~3초 노랑, 3초 이상 빨강. 이름, 진행 시간, `lastSpan` 표시.

### 순수 함수 (`dashboard/calc.mjs`)

`app.mjs`(`<script type="module">`)와 테스트가 함께 import한다. 저장소의 나머지 코드는 CommonJS(`.js`), 이 두 파일만 ES 모듈이라 확장자로 구분한다.

- `pickInRect(points, rect)`: 사각형(시각·응답시간 범위) 안의 점, 응답시간 긴 순.
- `yMax(maxElapsed)`: 세로축 최댓값 단계.

## 4. 샘플 앱·결제 서비스·부하 발생기

### 샘플 앱 (`sample/app.js`, 7701)

시작 시 메모리 SQLite에 `orders(id, user_id, item, amount, created_at)` 10만 건과 `products` 50건을 넣는다. `user_id`에는 인덱스를 만들지 않는다.

| 경로 | 동작 |
|---|---|
| `GET /products` | `products` 전체 조회 — 빠른 정상 요청 |
| `GET /orders?user=` | 행마다 그 사용자의 주문 수를 다시 세는 비효율 쿼리(상관 하위 쿼리 + `user_id` 인덱스 없음) — 느린 SQL. 사용자 2,000명 |
| `POST /checkout` | `orders` INSERT 후 `fetch('http://localhost:7702/pay')` — 결제 실패면 502 |
| `GET /report` | 무거운 계산 반복문 — 앱 자체 처리가 느림 |
| `GET /boom` | 예외를 던짐 → 500 |
| 그 외 | 404 |

`node:sqlite`는 동기식이라 느린 SQL 동안 다른 요청도 멈춘다. X-View에서 점이 한꺼번에 쌓이는 모습으로 보이며, 의도된 학습 포인트다.

### 결제 서비스 (`sample/payment.js`, 7702)

에이전트 없음. 50ms~2초 무작위 지연, 5% 확률로 500.

### 부하 발생기 (`sample/load.js`)

`node sample/load.js [동시사용자=10]`. 사용자마다 무한 반복: 경로 비중(products 50%, orders 20%, checkout 20%, report 7%, boom 3%)으로 하나 골라 요청, 0~300ms 쉼. 요청 실패는 무시.

### 데모 (`demo.js`)

`npm run demo`: 수집 서버 → 결제 서비스 → 샘플 앱(에이전트 포함) → 부하 발생기 순으로 `child_process.spawn`, 출력은 접두어 붙여 한 터미널에. Ctrl+C 시 전부 종료. 시작 후 `http://localhost:7700` 안내.

## 5. 테스트 (`node:test`, `npm test`)

- **에이전트** (`test/agent.test.js`): 테스트 안에서 에이전트를 로드하고 작은 서버를 띄워 가짜 수집 서버로 받은 데이터를 검사.
  - 요청 하나에 SQL span과 http span이 순서·`offset`과 함께 붙는다.
  - 동시에 들어온 두 요청의 spans가 섞이지 않는다.
  - 수집 서버가 없어도 앱은 정상 응답한다.
  - 예외를 던지는 처리기는 에러 트랜잭션으로 기록된다.
- **수집 서버** (`test/collector.test.js`): 수신 후 `/tx/:id`, 잘못된 JSON·1MB 초과는 400, 대시보드 폴더 밖 경로는 404, SSE 첫 메시지에 최근 점.
- **수집 저장소** (`test/store.test.js`): p95 계산, 수신 후 id 조회, 10분 지난 데이터 정리, 오래된 에이전트의 처리 중 목록 제외.
- **대시보드 계산** (`test/calc.test.mjs`): `pickInRect`, `yMax`.
- 화면 자체는 `npm run demo`로 눈으로 확인한다.

## 6. README

실행 방법과 함께, 각 부분이 JENNIFER의 어떤 기능에 해당하는지 학습 노트(에이전트 ↔ `-javaagent`, X-View, 액티브 서비스, 프로파일 상세 등).

## 범위에서 뺀 것 (다음 학습 후보)

분산 추적(서비스 간 ID 전달), CPU·메모리 수집, 디스크 저장(`node:sqlite`로 시계열 저장), 여러 서버 묶기, 경보, 시간대별 추이 그래프, 필터·검색, 테마 전환, 폴드 커버 화면 대응.
