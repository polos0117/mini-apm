# 대시보드 개편 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 숫자 타일에 5분 추이선, 액티브 이퀄라이저, 관제판형 배치를 더한다.

**Architecture:** 수집 서버가 연결 첫 메시지에 지난 300초 초별 통계(`series`)를, 모든 메시지에 `sec`를 싣는다. 대시보드는 그 목록에 1초 통계를 이어 붙여 SVG 추이선을 그리고, 이미 오는 처리 중 목록으로 이퀄라이저를 그린다. 계산은 `calc.mjs` 순수 함수(테스트), 화면은 `index.html` CSS 그리드.

**Tech Stack:** Node 22 기본 기능(외부 라이브러리 없음), 브라우저 ES 모듈, `node --test`, Playwright(검증용, 프로젝트 의존성 아님).

**Spec:** `docs/superpowers/specs/2026-10-21-dashboard-revamp-design.md`

## Global Constraints

- 외부 라이브러리 없음. 대시보드는 DOM을 `createElement`/`textContent`/`setAttribute`로만 만든다(`innerHTML` 금지 — `test/dashboard.test.js`가 검사).
- Java·Node 에이전트, 대상 앱 코드, `D:\AnyBuilder` 아래는 건드리지 않는다.
- 수집 서버는 `127.0.0.1`에서만 받는다(그대로).
- 색 변수(`--ok`, `--err`, `--warn`, `--good`, `--method`, `--mapper`, `--sql`, `--http`)와 남색 배경은 바꾸지 않는다.
- 이퀄라이저 구간: `elapsed < 1000` 초록(`--good`), `< 3000` 파랑(`--ok`), `< 8000` 노랑(`--warn`), 나머지 빨강(`--err`).
- 추이 길이 300초. 막대 높이 최소 기준 5건.
- 소스 파일은 CRLF(core.autocrlf=true) — 편집 도구가 줄바꿈을 보존하게.
- 테스트(Git Bash): `fnm exec --using=22 npm.cmd test`. 한 파일: `fnm exec --using=22 node --test test/<file>`.
- Playwright 검증은 포트 7711만(사용자 수집 서버 7700은 건드리지 않는다). `CHROMIUM_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"`, Playwright는 `C:/Users/jjshs/atelier/node_modules/playwright`.

## Review Focus

1. 연결 뒤 처음 나타난 앱(`series.byAgent`에 없음): 그 앱 추이는 한 점부터 시작하고 오류가 없어야 한다 — Task 3 `pushSeries` 빈 목록 테스트.
2. 다시 연결/늦게 온 메시지: 같은 `sec`는 덮어쓰고, 지난 `sec`는 버려 추이선에 같은 초가 두 번 생기지 않아야 한다 — Task 3 `pushSeries` 테스트.
3. 첫 메시지가 커져(300×(1+앱 수) 항목) SSE가 여러 조각으로 와도 테스트·대시보드가 깨지지 않아야 한다 — Task 2에서 테스트 리더를 `\n\n`까지 모으게 바꾼다(브라우저 `EventSource`는 원래 조각을 모은다).
4. 고른 앱이 사라졌거나 앱이 하나도 없을 때: 추이선은 빈 선, 이퀄라이저는 `연결된 앱 없음`, 페이지 오류 없음 — Task 5 Playwright(없는 앱 고르기).
5. 1000px 폭에서 4줄(고른 트랜잭션 | 상세)이 세로로 바뀌고 페이지에 가로 스크롤이 생기지 않아야 한다(상세 막대 `min-width: 240px`) — Task 4 Playwright.

---

## File Structure

- `collector/store.js` — `series(lastSec, n)` 추가(초별 통계 목록).
- `collector/server.js` — 메시지에 `sec`, 첫 메시지에 `series`.
- `dashboard/calc.mjs` — `equalize`, `sparkPoints`, `pushSeries`, `SERIES_LEN`.
- `dashboard/index.html` — 배치(타일 SVG, `#side`, `#drill`), CSS 정리.
- `dashboard/app.mjs` — 추이 기록·추이선·이퀄라이저 그리기.
- `README.md` — JENNIFER 대응 표 한 줄.
- 테스트: `test/store.test.js`, `test/collector.test.js`, `test/calc.test.mjs`. 검증 스크립트(커밋 안 함): 스크래치패드 `revamp-check.cjs`.

---

### Task 1: 저장소의 초별 통계 목록 `store.series`

**Files:**
- Modify: `collector/store.js` (상수 맨 위, `agentStats` 바로 아래에 메서드)
- Test: `test/store.test.js` (맨 끝에 추가)

**Interfaces:**
- Consumes: 기존 `summarize(list)`, `end(tx)`, `seen`(앱 Map), `txs`.
- Produces: `store.series(lastSec: number, n = 300) → { all: Array<{sec,tps,avg,p95,errors}>, byAgent: { [name]: Array<같은 모양> } }`. 각 배열 길이 n, `sec`는 `lastSec-(n-1)*1000`부터 `lastSec`까지 오름차순.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/store.test.js` 끝에 추가

```js
test('series: lastSec까지 n초를 오래된 것부터, 요청 없는 1초는 0, 범위 밖은 뺀다', () => {
  const s = createStore();
  s.ingest('x', [
    tx('a', 1000, 0),          // 끝 1000 → 1000초 칸(경계는 그 1초)
    tx('b', 1500, 499, 'e'),   // 끝 1999 → 1000초 칸
    tx('c', 1000, 1000),       // 끝 2000 → 2000초 칸
    tx('d', 0, 999),           // 끝 999 → 범위(1000~3999) 앞
    tx('e', 4000, 0),          // 끝 4000 → 범위 뒤
  ], [], 0);
  const { all } = s.series(3000, 3);
  assert.deepEqual(all, [
    { sec: 1000, tps: 2, avg: 250, p95: 499, errors: 1 },
    { sec: 2000, tps: 1, avg: 1000, p95: 1000, errors: 0 },
    { sec: 3000, tps: 0, avg: 0, p95: 0, errors: 0 },
  ]);
  const { sec, ...rest } = all[1];
  assert.deepEqual(rest, s.stats(2000)); // 타일과 같은 계산
});

test('series.byAgent: 앱마다 n개, 그 1초에 없는 앱은 0', () => {
  const s = createStore();
  s.ingest('x', [tx('a', 1000, 10)], [], 0);
  s.ingest('y', [], [], 0);
  const { byAgent } = s.series(2000, 2);
  assert.deepEqual(Object.keys(byAgent), ['x', 'y']);
  assert.deepEqual(byAgent.x.map((p) => [p.sec, p.tps]), [[1000, 1], [2000, 0]]);
  assert.deepEqual(byAgent.y.map((p) => p.tps), [0, 0]);
});

test('series: n을 안 주면 300개', () => {
  assert.equal(createStore().series(300000).all.length, 300);
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/store.test.js`
Expected: FAIL — `s.series is not a function`

- [ ] **Step 3: 구현** — `collector/store.js`

맨 위 상수들(`LOG_STEP` 줄 아래)에 추가:

```js
const SERIES_N = 300;            // 추이선 길이(초)
```

`agentStats(secStart) { ... },` 바로 아래에 추가:

```js
    // 추이선: lastSec까지 n초(오래된 것부터). 보관 중인 트랜잭션을 한 번만 훑어 초별로 나눈다
    series(lastSec, n = SERIES_N) {
      const first = lastSec - (n - 1) * 1000;
      const bySec = new Map();
      for (const tx of txs) {
        const e = end(tx);
        if (e < first || e >= lastSec + 1000) continue;
        const sec = first + Math.floor((e - first) / 1000) * 1000;
        if (!bySec.has(sec)) bySec.set(sec, []);
        bySec.get(sec).push(tx);
      }
      const names = [...seen.keys()];
      const all = [];
      const byAgent = Object.fromEntries(names.map((name) => [name, []]));
      for (let sec = first; sec <= lastSec; sec += 1000) {
        const list = bySec.get(sec) ?? [];
        all.push({ sec, ...summarize(list) });
        for (const name of names) byAgent[name].push({ sec, ...summarize(list.filter((tx) => tx.agent === name)) });
      }
      return { all, byAgent };
    },
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/store.test.js`
Expected: PASS (기존 + 새 3개)

- [ ] **Step 5: 커밋**

```bash
git add collector/store.js test/store.test.js
git commit -m "feat(collector): 추이선용 초별 통계 목록(store.series)"
```

---

### Task 2: 스트림 메시지에 `sec`, 첫 메시지에 `series`

**Files:**
- Modify: `collector/server.js:30-34` (`snapshot`), `:78` (`stream`의 첫 write)
- Test: `test/collector.test.js` (공용 SSE 리더 추가, 기존 stream 테스트의 `next` 교체, 새 테스트)

**Interfaces:**
- Consumes: `store.series(lastSec)` (Task 1).
- Produces: 스트림 메시지 `{ sec, points, stats, agentStats, agents, active }`, 연결 첫 메시지에만 `series: { all, byAgent }`. `sec` = `statSec(now)` = 1000의 배수.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/collector.test.js`

`const post = ...` 줄 아래에 공용 리더 추가(첫 메시지가 커져 여러 조각으로 올 수 있으므로 `\n\n`까지 모은다):

```js
// SSE 메시지 하나씩. 큰 메시지는 여러 조각으로 오므로 빈 줄(\n\n)까지 모은다
function sseReader(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return async () => {
    while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value, { stream: true });
    const i = buf.indexOf('\n\n');
    const msg = buf.slice(0, i);
    buf = buf.slice(i + 2);
    return JSON.parse(msg.replace(/^data: /, ''));
  };
}
```

기존 테스트 `'stream은 연결 즉시 최근 점을, 이후 1초마다 새 점을 보낸다'`의 두 줄

```js
  const reader = res.body.getReader();
  const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ''));
```

을 다음 한 줄로 바꾼다:

```js
  const next = sseReader(res);
```

그 테스트 바로 아래에 새 테스트 추가:

```js
test('stream 첫 메시지에만 지난 300초 series, 모든 메시지에 sec', async (t) => {
  const base = await start(t);
  await post(base, JSON.stringify({ agent: 'x', txs: [{ ...sample(), start: Date.now() - 5000 }], active: [] }));
  const ac = new AbortController();
  const res = await fetch(`${base}/stream`, { signal: ac.signal });
  const next = sseReader(res);
  const first = await next();
  assert.equal(first.sec % 1000, 0);
  assert.equal(first.series.all.length, 300);
  assert.equal(first.series.all.at(-1).sec, first.sec);
  assert.equal(first.series.all.reduce((n, p) => n + p.tps, 0), 1);
  assert.deepEqual(Object.keys(first.series.byAgent), ['x']);
  assert.equal(first.series.byAgent.x.length, 300);
  const tick = await next();
  ac.abort();
  assert.equal(tick.series, undefined);
  assert.ok(tick.sec >= first.sec);
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/collector.test.js`
Expected: 새 테스트 FAIL — `first.sec % 1000` 가 `NaN`(undefined) 라서 assert 실패. 기존 stream 테스트는 PASS.

- [ ] **Step 3: 구현** — `collector/server.js`

`snapshot`을 바꾼다(주석 포함):

```js
  // 스트림 한 번에 보내는 것: 그 1초(sec) + 새 점 + 마감된 1초 통계(전체·앱별) + 앱 목록 + 처리 중.
  // 연결 첫 메시지(withSeries)에만 지난 300초 추이를 더 싣는다
  const snapshot = (points, now, withSeries = false) => {
    const sec = statSec(now);
    const msg = { sec, points, stats: store.stats(sec), agentStats: store.agentStats(sec), agents: store.agents(now), active: store.active(now) };
    if (withSeries) msg.series = store.series(sec);
    return sse(msg);
  };
```

`stream`의 `res.write(snapshot(backlog, now));` 를 다음으로:

```js
    res.write(snapshot(backlog, now, true));
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/collector.test.js`
Expected: PASS (전부)

- [ ] **Step 5: 커밋**

```bash
git add collector/server.js test/collector.test.js
git commit -m "feat(collector): 스트림에 sec, 연결 첫 메시지에 지난 300초 추이"
```

---

### Task 3: 계산 함수 `equalize` · `sparkPoints` · `pushSeries`

**Files:**
- Modify: `dashboard/calc.mjs` (맨 끝에 추가)
- Test: `test/calc.test.mjs` (import 줄 수정, 맨 끝에 추가)

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `equalize(active: Array<{agent, elapsed}>, names: string[]) → Array<{ name, counts: [n0,n1,n2,n3], total }>` (names 순서)
  - `sparkPoints(values: number[], w: number, h: number) → string` (`"x,y x,y"`, 소수 1자리, 빈 배열은 `""`)
  - `pushSeries(list: Array<{sec,...}>, entry: {sec,...}, max = SERIES_LEN) → list` (제자리 수정)
  - `SERIES_LEN = 300`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/calc.test.mjs` import 줄을 다음으로 바꾼다:

```js
import { downSec, equalize, nextSort, nextPickSort, pickSort, pickInRect, pushSeries, routeSort, selfTime, slowLevel, sortPicked, sortRoutes, spanKinds, sparkPoints, yMax } from '../dashboard/calc.mjs';
```

맨 끝에 추가:

```js
test('equalize: 구간 경계 1·3·8초, 요청 없는 앱은 0, 목록에 없는 앱은 무시', () => {
  const active = [999, 1000, 2999, 3000, 7999, 8000].map((elapsed) => ({ agent: 'a', elapsed }));
  active.push({ agent: 'ghost', elapsed: 10 });
  assert.deepEqual(equalize(active, ['a', 'b']), [
    { name: 'a', counts: [1, 2, 2, 1], total: 6 },
    { name: 'b', counts: [0, 0, 0, 0], total: 0 },
  ]);
  assert.deepEqual(equalize([], []), []);
});

test('sparkPoints: 0은 바닥, 최대값은 천장, 모두 0이면 평평, 값 1개는 오른쪽 끝', () => {
  assert.equal(sparkPoints([], 100, 28), '');
  assert.equal(sparkPoints([5], 100, 28), '100,0');
  assert.equal(sparkPoints([0, 0, 0], 100, 28), '0,28 50,28 100,28');
  assert.equal(sparkPoints([0, 5, 10], 100, 28), '0,28 50,14 100,0');
  assert.equal(sparkPoints([1, 2, 3], 100, 28), '0,18.7 50,9.3 100,0');
});

test('pushSeries: 새 초는 붙이고, 같은 초는 덮어쓰고, 지난 초는 버리고, max를 넘으면 앞에서 버린다', () => {
  const list = [];
  pushSeries(list, { sec: 1000, tps: 1 }, 2); // 빈 목록(연결 뒤 처음 나타난 앱)
  pushSeries(list, { sec: 1000, tps: 5 }, 2);
  assert.deepEqual(list, [{ sec: 1000, tps: 5 }]);
  pushSeries(list, { sec: 2000, tps: 2 }, 2);
  pushSeries(list, { sec: 1000, tps: 9 }, 2); // 늦게 온 지난 초
  assert.deepEqual(list.map((p) => p.tps), [5, 2]);
  assert.equal(pushSeries(list, { sec: 3000, tps: 3 }, 2), list);
  assert.deepEqual(list.map((p) => p.sec), [2000, 3000]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/calc.test.mjs`
Expected: FAIL — `does not provide an export named 'equalize'`

- [ ] **Step 3: 구현** — `dashboard/calc.mjs` 끝에 추가

```js
// 액티브 이퀄라이저: 앱마다 처리 중 요청을 경과 시간 구간(1·3·8초)별로 센다. names 순서, 요청 없는 앱도 0
const EQ_EDGES = [1000, 3000, 8000];
export function equalize(active, names) {
  const rows = new Map(names.map((name) => [name, { name, counts: [0, 0, 0, 0], total: 0 }]));
  for (const a of active) {
    const r = rows.get(a.agent);
    if (!r) continue;
    const i = EQ_EDGES.findIndex((edge) => a.elapsed < edge);
    r.counts[i === -1 ? 3 : i]++;
    r.total++;
  }
  return [...rows.values()];
}

// 추이선 SVG points. 0은 바닥(h), 그 목록의 최대값은 천장(0). 값 1개면 오른쪽 끝 한 점
const r1 = (v) => Math.round(v * 10) / 10;
export function sparkPoints(values, w, h) {
  const max = Math.max(0, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${r1(values.length > 1 ? i * step : w)},${r1(max ? h - (v / max) * h : h)}`).join(' ');
}

// 추이 목록에 1초 통계 붙이기: 같은 초는 덮어쓰고, 지난 초는 버리고, max를 넘으면 앞에서 버린다
export const SERIES_LEN = 300;
export function pushSeries(list, entry, max = SERIES_LEN) {
  const lastSec = list.at(-1)?.sec;
  if (entry.sec === lastSec) list[list.length - 1] = entry;
  else if (lastSec === undefined || entry.sec > lastSec) list.push(entry);
  while (list.length > max) list.shift();
  return list;
}
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/calc.test.mjs`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add dashboard/calc.mjs test/calc.test.mjs
git commit -m "feat(dashboard): 이퀄라이저·추이선 계산 함수"
```

---

### Task 4: 관제판형 배치 + 디자인 정리 (HTML/CSS)

**Files:**
- Modify: `dashboard/index.html` (`<style>`과 `<body>`)
- Create(커밋 안 함): `C:\Users\jjshs\AppData\Local\Temp\claude\C--\a9d50998-9a54-4325-9272-01fb9ae5fce8\scratchpad\revamp-check.cjs`

**Interfaces:**
- Consumes: 없음.
- Produces(Task 5가 쓰는 id·class): `#spark-tps`·`#spark-avg`·`#spark-p95`·`#spark-errors`(각 `<svg>` 안에 `<polygon>`·`<polyline>` 하나씩, viewBox `0 0 100 28`), `#eq`(이퀄라이저 막대 자리), `.col`/`.col.down`/`.stack`/`.b0~.b3`(막대 CSS), `#side`, `#drill`.

- [ ] **Step 1: 검증 스크립트 작성(실패할 것)** — `revamp-check.cjs`

```js
// 대시보드 개편 확인: 1920×950 첫 화면, 1000px 세로 배치, 가로 넘침, (Task 5) 추이선·이퀄라이저
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/jjshs/atelier/node_modules/playwright');
const { createCollector } = require('C:/Users/jjshs/mini-apm/collector/server');
const WIDGETS = process.argv.includes('--widgets');
(async () => {
  const c = createCollector();
  await new Promise((r) => c.server.listen(7711, '127.0.0.1', r));
  const now = Date.now();
  const txs = (agent) => Array.from({ length: 80 }, (_, i) => ({ id: `${agent}${i}`, name: 'GET /a', start: now - 60000 + i * 500,
    elapsed: 50 + i * 40, status: 200, error: i % 17 === 0 ? 'boom' : null, spans: [] }));
  const post = (agent, active) => fetch('http://127.0.0.1:7711/ingest', { method: 'POST', body: JSON.stringify({ agent, txs: txs(agent), active }) });
  const feed = () => Promise.all([
    post('ipfinance', [{ name: 'GET /x', elapsed: 500 }, { name: 'GET /y', elapsed: 1500 }, { name: 'GET /z', elapsed: 9000 }]),
    post('evl', [{ name: 'GET /q', elapsed: 4000 }]),
  ]);
  await feed();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1920, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:7711/#live');
  await page.waitForTimeout(1500);

  const rect = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, bottom: r.bottom }; });
  const main = await rect('#main');
  console.log('#main 아래 끝:', main.bottom);
  assert.ok(main.bottom <= 950, '2줄이 첫 화면 안');
  const [picked, detail] = [await rect('#picked'), await rect('#detail')];
  assert.ok(detail.x > picked.x + picked.w - 1, '1920: 상세는 고른 트랜잭션 오른쪽');

  if (WIDGETS) {
    await feed(); // 처리 중 목록은 5초 지나면 빠지므로 다시 보낸다
    await page.waitForTimeout(1200);
    for (const k of ['tps', 'avg', 'p95', 'errors']) {
      const pts = await page.$eval(`#spark-${k} polyline`, (el) => el.getAttribute('points') ?? '');
      assert.ok(pts.split(' ').length >= 2, `추이선 ${k}: ${pts.slice(0, 40)}`);
    }
    const cols = await page.$$eval('#eq .col', (els) => els.map((el) => ({
      n: el.querySelector('b').textContent, name: el.querySelector('small').textContent,
      segs: [...el.querySelectorAll('.stack i')].map((i) => i.className),
    })));
    console.log('이퀄라이저:', JSON.stringify(cols));
    assert.deepEqual(cols.map((x) => [x.name, x.n]), [['ipfinance', '3'], ['evl', '1']]);
    assert.deepEqual(cols[0].segs, ['b0', 'b1', 'b3']);
    assert.deepEqual(cols[1].segs, ['b2']);
    assert.match(await page.$eval('#eqlegend', (el) => el.textContent), /1초 미만.*8초 이상/);
    await page.click('#apps button[data-app="evl"]');
    assert.equal(await page.$$eval('#eq .col', (els) => els.length), 1);
    await page.evaluate(() => localStorage.setItem('apm.app', 'nope')); // 없는 앱(Review Focus 4)
    await page.reload();
    await page.waitForTimeout(1500);
    assert.equal(await page.$eval('#eq', (el) => el.textContent), '연결된 앱 없음');
    assert.equal(await page.$eval('#spark-tps polyline', (el) => el.getAttribute('points') ?? ''), '');
    await page.click('#apps button[data-app=""]');
  }

  await page.setViewportSize({ width: 1000, height: 950 });
  await page.waitForTimeout(300);
  const [p2, d2] = [await rect('#picked'), await rect('#detail')];
  assert.ok(d2.y > p2.bottom, '1000px: 상세는 고른 트랜잭션 아래');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(over <= 0, `1000px 가로 넘침 ${over}px`);
  await page.screenshot({ path: __dirname + '/revamp-1000.png', fullPage: true });
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: __dirname + '/revamp-1920.png' });
  assert.deepEqual(errors, []);
  console.log('OK');
  await browser.close();
  c.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
```

- [ ] **Step 2: 실패 확인**

Run(Git Bash): `cd /c/Users/jjshs/mini-apm && CHROMIUM_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" fnm exec --using=22 node "C:/Users/jjshs/AppData/Local/Temp/claude/C--/a9d50998-9a54-4325-9272-01fb9ae5fce8/scratchpad/revamp-check.cjs"`
Expected: `FAIL 1920: 상세는 고른 트랜잭션 오른쪽` (지금은 세로로 쌓여 있다)

- [ ] **Step 3: 구현 — `<body>` 배치** — `dashboard/index.html`

`<div id="tiles" data-tab="live">` 부터 `<section class="panel" style="--c: var(--good)"><h2>트랜잭션 상세</h2>...</section>` 까지를 다음으로 바꾼다:

```html
  <div id="tiles" data-tab="live">
    <div class="panel tile" style="--c: var(--ok)"><h2>초당 처리량(TPS)</h2><b id="tps">-</b><svg class="spark" id="spark-tps" viewBox="0 0 100 28" preserveAspectRatio="none"><polygon/><polyline/></svg></div>
    <div class="panel tile" style="--c: var(--mapper)"><h2>평균 응답(ms)</h2><b id="avg">-</b><svg class="spark" id="spark-avg" viewBox="0 0 100 28" preserveAspectRatio="none"><polygon/><polyline/></svg></div>
    <div class="panel tile" style="--c: var(--method)"><h2>응답 95%(p95, ms)</h2><b id="p95">-</b><svg class="spark" id="spark-p95" viewBox="0 0 100 28" preserveAspectRatio="none"><polygon/><polyline/></svg></div>
    <div class="panel tile" style="--c: var(--err)"><h2>에러</h2><b id="errors">-</b><svg class="spark" id="spark-errors" viewBox="0 0 100 28" preserveAspectRatio="none"><polygon/><polyline/></svg></div>
  </div>
  <div id="main" data-tab="live">
    <div class="panel"><h2>X-View — 영역을 끌어서 고르세요 <span id="legend"></span> <span id="status"></span></h2><canvas id="xview"></canvas></div>
    <div id="side">
      <div class="panel" style="--c: var(--good)"><h2>액티브 이퀄라이저</h2>
        <div id="eqlegend"><i class="b0"></i>1초 미만 <i class="b1"></i>1~3초 <i class="b2"></i>3~8초 <i class="b3"></i>8초 이상</div>
        <div id="eq">연결된 앱 없음</div></div>
      <div class="panel" style="--c: var(--warn)"><h2>처리 중인 요청</h2><div id="active">없음</div></div>
    </div>
  </div>
  <section class="panel" data-tab="live" style="--c: var(--err)"><h2>최근 에러</h2><div id="errlist">없음</div></section>
  <section class="panel" data-tab="stats" style="--c: var(--method)"><h2>API별 통계 <span id="ranges"><button data-range="10m">최근 10분</button> <button data-range="all">서버 켠 뒤 전체</button></span></h2><div id="routes">없음</div></section>
  <div id="drill">
    <div>
      <section class="panel" style="--c: var(--mapper)"><h2>고른 트랜잭션</h2><table id="picked"></table></section>
      <section class="panel" data-tab="live" style="--c: var(--warn)"><h2>무엇이 다른가 <span id="cmpinfo"></span></h2><div id="compare">X-View에서 영역을 끌어 고르면 나머지와 비교합니다.</div></section>
    </div>
    <div>
      <section class="panel" style="--c: var(--good)"><h2>트랜잭션 상세</h2><div id="detail">목록에서 한 줄을 누르세요.</div></section>
    </div>
  </div>
```

- [ ] **Step 4: 구현 — `<style>`** — `dashboard/index.html`

바꾸는 줄(왼쪽 → 오른쪽):

| 지금 | 바꾼 뒤 |
|---|---|
| `h2 { margin: 0 0 8px; font-size: 13px; color: var(--dim); font-weight: 600; }` | `h2 { margin: 0 0 8px; font-size: 12px; color: var(--dim); font-weight: 600; letter-spacing: 0.02em; }` |
| `.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }` | `.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25); }` |
| `.tile b { display: block; font-size: 32px; color: #f1f5f9; font-variant-numeric: tabular-nums; }` | `.tile b { display: block; font-size: 30px; font-weight: 700; line-height: 1.2; color: #f1f5f9; font-variant-numeric: tabular-nums; }` |
| `#xview { width: 100%; height: 360px; display: block; cursor: crosshair; touch-action: none; }` | `#xview { width: 100%; height: 320px; display: block; cursor: crosshair; touch-action: none; }` |
| `#active { max-height: 360px; overflow: auto; }` | `#active { max-height: 200px; overflow: auto; }` |
| `th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }` | 그대로 두고 바로 아래에 `th { color: var(--dim); font-size: 12px; font-weight: 600; background: #141b22; }` 추가 |
| `#errlist { max-height: 240px; overflow: auto; }` | `#errlist { max-height: 160px; overflow: auto; }` |

`</style>` 바로 위에 추가:

```css
  .spark { display: block; width: 100%; height: 28px; margin-top: 4px; }
  .spark polyline { fill: none; stroke: var(--c); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .spark polygon { fill: var(--c); opacity: 0.12; }
  #side { display: grid; gap: 12px; align-content: start; min-width: 0; }
  #eqlegend { color: var(--dim); font-size: 12px; margin: -4px 0 8px; }
  #eqlegend i { display: inline-block; width: 8px; height: 8px; margin: 0 2px 0 6px; }
  #eqlegend i:first-child { margin-left: 0; }
  #eq { display: flex; gap: 12px; align-items: flex-end; overflow-x: auto; color: var(--dim); }
  #eq .col { flex: 1 0 48px; max-width: 80px; text-align: center; color: var(--text); }
  #eq .col b { font-variant-numeric: tabular-nums; }
  #eq .stack { height: 90px; display: flex; flex-direction: column-reverse; background: #0b0f13; border-radius: 3px; overflow: hidden; }
  #eq .stack i { display: block; flex: none; }
  #eq .col.down { opacity: 0.45; }
  #eq small { display: block; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .b0 { background: var(--good); }
  .b1 { background: var(--ok); }
  .b2 { background: var(--warn); }
  .b3 { background: var(--err); }
  #drill { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
  #drill > div { min-width: 0; }
  #detail, #compare { overflow-x: auto; }
  @media (max-width: 1199px) { #drill { grid-template-columns: minmax(0, 1fr); } }
```

- [ ] **Step 5: 통과 확인**

Run: Step 2와 같은 명령
Expected: `#main 아래 끝: <950 이하 숫자>` 그리고 `OK`. 스크린샷 `revamp-1920.png`·`revamp-1000.png`를 Read로 열어 배치가 A안(위: 타일·X-View|이퀄라이저·처리 중, 아래: 최근 에러, 고른|상세)인지 눈으로 확인.

Run: `fnm exec --using=22 npm.cmd test`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add dashboard/index.html
git commit -m "feat(dashboard): 관제판형 배치(이퀄라이저 칸, 고른|상세 좌우)와 간격·글자 정리"
```

---

### Task 5: 추이선·이퀄라이저 그리기 + README

**Files:**
- Modify: `dashboard/app.mjs` (import, 상태, `onmessage`, `render`, 새 함수 두 묶음)
- Modify: `README.md` (JENNIFER 대응 표)
- Verify: `revamp-check.cjs --widgets`

**Interfaces:**
- Consumes: Task 2 메시지(`sec`, `series`), Task 3 `equalize`/`sparkPoints`/`pushSeries`, Task 4 id·class.
- Produces: 없음(화면).

- [ ] **Step 1: 실패 확인(위젯 검증)**

Run: `cd /c/Users/jjshs/mini-apm && CHROMIUM_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" fnm exec --using=22 node "C:/Users/jjshs/AppData/Local/Temp/claude/C--/a9d50998-9a54-4325-9272-01fb9ae5fce8/scratchpad/revamp-check.cjs" --widgets`
Expected: `FAIL 추이선 tps: ` (points가 비어 있다)

- [ ] **Step 2: 구현** — `dashboard/app.mjs`

import 묶음을 다음으로:

```js
import {
  downSec, equalize, nextPickSort, nextSort, PICK_COLS, pickInRect, pickSort, pushSeries, ROUTE_COLS, routeSort, selfTime, slowLevel,
  sortPicked, sortRoutes, spanKinds, sparkPoints, yMax,
} from './calc.mjs';
```

`let unacked = 0;` 줄 아래에 추가:

```js
let series = { all: [], byAgent: {} }; // 추이선: 전체·앱별 { sec, tps, avg, p95, errors } 최근 300초
```

`es.onmessage` 안의 `last = msg;` 바로 아래에 추가:

```js
  track(msg);
```

`render()`의 `showStats(...)` 줄 바로 아래에 추가:

```js
  showSparks();
  showEqualizer();
```

`// ---- X-View ----` 줄 바로 위에 추가:

```js
// ---- 추이선 ----

// 연결 첫 메시지의 series로 통째로 바꾸고, 매 메시지의 1초 통계를 이어 붙인다
function track(msg) {
  if (msg.series) series = { all: msg.series.all, byAgent: { ...msg.series.byAgent } };
  pushSeries(series.all, { sec: msg.sec, ...msg.stats });
  for (const [name, s] of Object.entries(msg.agentStats)) pushSeries((series.byAgent[name] ??= []), { sec: msg.sec, ...s });
}
function showSparks() {
  const list = selected ? series.byAgent[selected] ?? [] : series.all;
  for (const key of ['tps', 'avg', 'p95', 'errors']) {
    const pts = sparkPoints(list.map((s) => s[key]), 100, 28);
    const svg = $(`spark-${key}`);
    svg.querySelector('polyline').setAttribute('points', pts);
    svg.querySelector('polygon').setAttribute('points', pts && `0,28 ${pts} 100,28`);
  }
}

// ---- 액티브 이퀄라이저 ----

const EQ_MIN = 5; // 막대 전체 높이의 최소 건수(1~2건이 꽉 찬 막대로 보이지 않게)
const EQ_LABELS = ['1초 미만', '1~3초', '3~8초', '8초 이상'];
function showEqualizer() {
  const agents = last.agents.filter((a) => !selected || a.name === selected);
  if (agents.length === 0) return $('eq').replaceChildren('연결된 앱 없음');
  const rows = equalize(last.active, agents.map((a) => a.name));
  const top = Math.max(EQ_MIN, ...rows.map((r) => r.total));
  $('eq').replaceChildren(...rows.map((r, i) => {
    const down = agents[i].ago > opts.downMs; // 앱 버튼의 ●와 같은 기준
    const col = document.createElement('div');
    col.className = down ? 'col down' : 'col';
    const n = document.createElement('b');
    n.textContent = r.total;
    const stack = document.createElement('div');
    stack.className = 'stack';
    r.counts.forEach((c, k) => {
      if (!c) return;
      const seg = document.createElement('i');
      seg.className = `b${k}`;
      seg.style.height = `${(c / top) * 100}%`;
      seg.title = `${EQ_LABELS[k]} ${c}건`;
      stack.append(seg);
    });
    const name = document.createElement('small');
    name.textContent = down ? `${r.name} ●` : r.name;
    name.title = r.name;
    col.append(n, stack, name);
    return col;
  }));
}

```

- [ ] **Step 3: 통과 확인**

Run: Step 1과 같은 명령
Expected: `이퀄라이저: [{"n":"3","name":"ipfinance","segs":["b0","b1","b3"]},{"n":"1","name":"evl","segs":["b2"]}]` 그리고 `OK`. `revamp-1920.png`를 Read로 열어 추이선(타일 색 선 + 옅은 채움)과 이퀄라이저 막대를 눈으로 확인.

Run: `fnm exec --using=22 npm.cmd test`
Expected: 전부 PASS (`dashboard.test.js`의 innerHTML 검사 포함)

- [ ] **Step 4: README** — `README.md` JENNIFER 대응 표의 `| X-View 끌기 → 무엇이 다른가...` 줄 바로 아래에 추가:

```markdown
| 타일 추이선(연결 첫 메시지의 `series`) + 액티브 이퀄라이저 | 대시보드 TPS·응답시간 차트, 액티브 서비스 이퀄라이저 | 숫자 하나보다 5분 흐름을, 처리 중 목록보다 구간별 막대(1·3·8초)를 보면 '어느 앱이 언제부터 막히나'가 먼저 보인다 |
```

- [ ] **Step 5: 커밋**

```bash
git add dashboard/app.mjs README.md
git commit -m "feat(dashboard): 타일 5분 추이선과 액티브 이퀄라이저"
```
