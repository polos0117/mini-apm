# 앱별로 나눠 보기 + 에러 모아 보기·경보 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드에서 앱(에이전트)을 골라 보고, 최근 에러를 모아 보며, 에러 요청·앱 끊김을 화면과 Windows 알림으로 알린다. Java 에이전트가 긴 SQL을 1,000자에서 자르지 않게 한다.

**Architecture:** 수집 서버(`collector/store.js`, `server.js`)는 트랜잭션·점·처리 중 항목에 `agent`를 붙이고 앱별 통계와 앱 목록(`agents`)을 스트림에 더한다.
대시보드는 받은 것을 화면에서 거르고, 경보 판단은 브라우저 API 없는 `dashboard/alerts.mjs`가 한다.

**Tech Stack:** Node 22 기본 기능만(`node:test`), 브라우저 기본 API(EventSource, Canvas, Notification, localStorage). 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-20-apps-alerts-design.md`

## Global Constraints

- 외부 라이브러리 없음. Node 22(`fnm exec --using=22 npm.cmd test`, Git Bash).
- 대시보드는 HTML 문자열을 끼워 넣지 않는다(`textContent`만). `test/dashboard.test.js`가 검사한다.
- 수집 서버는 `127.0.0.1`에서만 받는다(바꾸지 않음).
- 에이전트(Node `agent/`, Java `agent-java/`)는 바꾸지 않는다.
- 에이전트 이름: 문자열이 아니거나 trim 후 비면 `unknown`, 40자에서 자름. 점의 `msg`는 200자에서 자름.
- 에러 경보 반복 간격 60초(같은 `agent`+`name`). 끊김 기준 기본 10초, 1~600 정수, 그 밖이면 10.
- 경보 문구: `[앱] 이름 — 메시지`(메시지 없으면 ` — ` 이하 생략), `[앱] 끊김 — N초째 소식 없음`, `[앱] 다시 연결됨`.
- 탭 제목 `(⚠N) 미니 APM`. 빨간 줄은 최근 5개. 최근 에러 패널은 최신순 50줄.
- 모양 순서 ●, ▲, ■, ◆ (`agents` 순서로 반복). 색은 정상 파랑, 에러 빨강.
- 모든 파일은 LF 줄 끝. 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. 1초마다 화면을 다시 그릴 때 앱 버튼·최근 에러 줄 클릭이 사라지지 않아야 한다 — 버튼은 이름이 바뀔 때만 새로 만들고, 에러 목록은 내용이 바뀔 때만 다시 만든다(Task 3 Step 6에서 Playwright로 클릭 확인).
2. `localStorage`가 막힌 브라우저(사생활 모드 등)에서도 기본값으로 동작해야 한다 — `load`/`save`가 try/catch(Task 3 코드).
3. 기억한 앱이 수집 서버 재시작으로 목록에 없을 때 화면이 비어도 [전체]로 돌아갈 수 있어야 한다(Task 3 Step 6 확인).
4. 수집 서버가 재시작되거나 연결이 다시 붙을 때 지난 5분치 에러로 경보가 쏟아지면 안 된다 — `reset()` 테스트(Task 2).
5. 앱 이름에 `<b>` 같은 글자가 와도 화면에 글자로만 보여야 한다 — `textContent` 검사를 `alerts.mjs`까지 넓힌다(Task 3 Step 1).

---

### Task 1: 수집 서버 — 앱 이름, 앱별 통계, 앱 목록

**Files:**
- Modify: `collector/store.js`
- Modify: `collector/server.js`
- Test: `test/store.test.js`, `test/collector.test.js`

**Interfaces:**
- Produces:
  - 점: `{ id, name, t, elapsed, error: boolean, agent: string, msg: string|null }`
  - 처리 중 항목: 받은 객체 + `agent: string`
  - `store.agentStats(secStart) → { [agent]: { tps, avg, p95, errors } }`
  - `store.agents(now) → [{ name, ago }]` (처음 보낸 순서)
  - 스트림 메시지: `{ points, stats, agentStats, agents, active }`

- [ ] **Step 1: 실패하는 테스트 쓰기**

`test/store.test.js`의 '받은 트랜잭션을 id로 찾고 점으로 돌려준다' 기대값을 바꾼다:

```js
  assert.deepEqual(added, [
    { id: '1', name: 'GET /a', t: 1050, elapsed: 50, error: false, agent: 'a', msg: null },
    { id: '2', name: 'GET /a', t: 1070, elapsed: 70, error: true, agent: 'a', msg: 'boom' },
  ]);
```

파일 끝에 추가:

```js
test('에이전트 이름을 정리해 트랜잭션·점·처리 중 항목에 붙인다', () => {
  const s = createStore();
  s.ingest('  evl ', [tx('1', 0, 5)], [{ id: 'x', name: 'GET /a', elapsed: 1, lastSpan: null }], 0);
  s.ingest(42, [tx('2', 0, 5)], [], 0);
  s.ingest('   ', [tx('3', 0, 5)], [], 0);
  s.ingest('a'.repeat(41), [tx('4', 0, 5)], [], 0);
  assert.equal(s.get('1').agent, 'evl');
  assert.equal(s.get('2').agent, 'unknown');
  assert.equal(s.get('3').agent, 'unknown');
  assert.equal(s.get('4').agent, 'a'.repeat(40));
  assert.deepEqual(s.points(0).map((p) => p.agent), ['evl', 'unknown', 'unknown', 'a'.repeat(40)]);
  assert.deepEqual(s.active(0).map((a) => [a.id, a.agent]), [['x', 'evl']]);
});

test('점의 msg는 에러 문자열 200자까지, 에러 없으면 null', () => {
  const s = createStore();
  s.ingest('a', [tx('1', 0, 5), tx('2', 0, 5, 'x'.repeat(250))], [], 0);
  const [ok, bad] = s.points(0);
  assert.equal(ok.msg, null);
  assert.equal(bad.msg, 'x'.repeat(200));
});

test('agentStats는 앱별로 나누고, 그 1초에 없는 앱은 0들', () => {
  const s = createStore();
  s.ingest('a', [tx('1', 1000, 100)], [], 0);
  s.ingest('b', [tx('2', 1500, 300, 'e')], [], 0);
  s.ingest('c', [], [], 0);
  assert.deepEqual(s.agentStats(1000), {
    a: { tps: 1, avg: 100, p95: 100, errors: 0 },
    b: { tps: 1, avg: 300, p95: 300, errors: 1 },
    c: { tps: 0, avg: 0, p95: 0, errors: 0 },
  });
});

test('agents는 처음 보낸 순서와 마지막 소식 뒤 지난 시간, 오래된 앱도 남는다', () => {
  const s = createStore();
  s.ingest('b', [], [], 1000);
  s.ingest('a', [], [], 2000);
  s.ingest('b', [], [], 3000);
  assert.deepEqual(s.agents(60000), [{ name: 'b', ago: 57000 }, { name: 'a', ago: 58000 }]);
});
```

`test/collector.test.js`:
- 'ingest 후 /tx/:id로 상세를 얻는다'의 `assert.deepEqual(await (await fetch(`${base}/tx/abc`)).json(), tx);`를
  `assert.deepEqual(await (await fetch(`${base}/tx/abc`)).json(), { ...tx, agent: 'x' });`로.
- 'stream은 …' 테스트에서 `assert.deepEqual(Object.keys(first.stats).sort(), …);` 바로 아래에 추가:

```js
  assert.equal(first.points[0].agent, 'x');
  assert.deepEqual(first.agents.map((a) => a.name), ['x']);
  assert.deepEqual(Object.keys(first.agentStats), ['x']);
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/store.test.js test/collector.test.js`
Expected: FAIL — 점에 `agent`/`msg` 없음, `s.agentStats is not a function`, `first.agents` undefined 등.

- [ ] **Step 3: 구현 — `collector/store.js`**

상수와 `toPoint`를 바꾼다:

```js
const KEEP_MS = 10 * 60 * 1000; // 트랜잭션 보관 기간
const STALE_MS = 5000;           // 이 시간 동안 소식 없는 에이전트는 처리 중 목록에서 뺀다
const MAX_NAME = 40;             // 에이전트 이름 길이
const MAX_MSG = 200;             // 점에 싣는 에러 메시지 길이

const end = (tx) => tx.start + tx.elapsed;
const isTx = (t) =>
  t !== null && typeof t === 'object' && typeof t.id === 'string' &&
  Number.isFinite(t.start) && Number.isFinite(t.elapsed) && Array.isArray(t.spans);
const isActive = (a) => a !== null && typeof a === 'object' && Number.isFinite(a.elapsed);
const agentName = (a) => (typeof a === 'string' && a.trim() ? a.trim().slice(0, MAX_NAME) : 'unknown');
const toPoint = (tx) => ({
  id: tx.id, name: tx.name, t: end(tx), elapsed: tx.elapsed, error: Boolean(tx.error),
  agent: tx.agent, msg: typeof tx.error === 'string' ? tx.error.slice(0, MAX_MSG) : null,
});

function summarize(list) {
  const elapsed = list.map((tx) => tx.elapsed);
  return {
    tps: list.length,
    avg: elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0,
    p95: Math.round(p95(elapsed)),
    errors: list.filter((tx) => tx.error).length,
  };
}
```

`createStore` 안: `agents` Map 이름을 `seen`으로 바꾸고(메서드 이름 `agents`와 겹치지 않게), `ingest`·`stats`·`active`를 바꾸고 `agentStats`·`agents`를 더한다:

```js
  let txs = [];
  const byId = new Map();
  const seen = new Map(); // 에이전트 이름 → { at, active }. 수집 서버가 켜져 있는 동안 빠지지 않는다(끊김 판단용)
  const inSecond = (secStart) => txs.filter((tx) => end(tx) >= secStart && end(tx) < secStart + 1000);

  return {
    // 올바른 트랜잭션만 저장하고, 저장한 것의 점 목록을 돌려준다.
    ingest(agent, list, active, now = Date.now()) {
      const name = agentName(agent);
      const added = [];
      for (const tx of Array.isArray(list) ? list : []) {
        if (!isTx(tx) || byId.has(tx.id)) continue;
        tx.agent = name;
        txs.push(tx);
        byId.set(tx.id, tx);
        added.push(toPoint(tx));
      }
      seen.set(name, {
        at: now,
        active: Array.isArray(active) ? active.filter(isActive).map((a) => ({ ...a, agent: name })) : [],
      });
      return added;
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    points(since) {
      return txs.filter((tx) => end(tx) >= since).map(toPoint);
    },
    stats(secStart) {
      return summarize(inSecond(secStart));
    },
    agentStats(secStart) {
      const inSec = inSecond(secStart);
      const out = {};
      for (const name of seen.keys()) out[name] = summarize(inSec.filter((tx) => tx.agent === name));
      return out;
    },
    agents(now = Date.now()) {
      return [...seen].map(([name, a]) => ({ name, ago: now - a.at }));
    },
    active(now = Date.now()) {
      const all = [];
      for (const a of seen.values()) if (now - a.at <= STALE_MS) all.push(...a.active);
      return all.sort((x, y) => y.elapsed - x.elapsed);
    },
```

(`prune`는 그대로.)

- [ ] **Step 4: 구현 — `collector/server.js`**

`createCollector` 안 `clients`/`pending` 선언 아래에 메시지 함수를 두고, `stream`과 타이머가 함께 쓴다:

```js
  // 스트림 한 번에 보내는 것: 새 점 + 마감된 1초 통계(전체·앱별) + 앱 목록 + 처리 중
  const snapshot = (points, now) => {
    const sec = statSec(now);
    return sse({ points, stats: store.stats(sec), agentStats: store.agentStats(sec), agents: store.agents(now), active: store.active(now) });
  };
```

`stream`의 `res.write(sse({ points: backlog, stats: …, active: … }));` → `res.write(snapshot(backlog, now));`
타이머의 `const msg = sse({ points: pending, … });` → `const msg = snapshot(pending, now);`

- [ ] **Step 5: 통과 확인**

Run: `fnm exec --using=22 node --test test/store.test.js test/collector.test.js`
Expected: PASS, 실패 0.

- [ ] **Step 6: 커밋**

```bash
git add collector/store.js collector/server.js test/store.test.js test/collector.test.js
git commit -m "feat(collector): tag agent on points and active, per-agent stats and agent list"
```

---

### Task 2: 경보 판단 `dashboard/alerts.mjs`

**Files:**
- Create: `dashboard/alerts.mjs`
- Test: `test/alerts.test.mjs`

**Interfaces:**
- Consumes: 스트림 메시지의 `points`(`agent`, `name`, `error`, `msg`), `agents`(`name`, `ago`) — Task 1.
- Produces: `createAlerts() → { check(msg, now, opts) → [{ kind: 'error'|'down'|'up', agent, text }], reset() }`,
  `opts = { errors: boolean, down: boolean, downMs: number }`.

- [ ] **Step 1: 실패하는 테스트 쓰기** — `test/alerts.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from '../dashboard/alerts.mjs';

const ON = { errors: true, down: true, downMs: 10000 };
const msg = (points = [], agents = []) => ({ points, agents });
const err = (agent, name = 'GET /a', m = 'HTTP 500') => ({ id: Math.random().toString(36), agent, name, error: true, msg: m });
const app = (name, ago) => [{ name, ago }];
const texts = (list) => list.map((a) => a.text);

test('연결 직후 첫 메시지(지난 점)의 에러는 경보하지 않는다', () => {
  const al = createAlerts();
  assert.deepEqual(al.check(msg([err('evl')]), 0, ON), []);
  assert.deepEqual(al.check(msg([err('evl')]), 1000, ON), [
    { kind: 'error', agent: 'evl', text: '[evl] GET /a — HTTP 500' },
  ]);
});

test('같은 앱·같은 이름 에러는 60초에 한 번, 다른 앱·다른 이름·60초 뒤는 다시', () => {
  const al = createAlerts();
  al.check(msg(), 0, ON);
  assert.equal(al.check(msg([err('evl'), err('evl')]), 1000, ON).length, 1);
  assert.equal(al.check(msg([err('evl')]), 30000, ON).length, 0);
  assert.equal(al.check(msg([err('ipfinance')]), 30000, ON).length, 1);
  assert.equal(al.check(msg([err('evl', 'GET /b')]), 30000, ON).length, 1);
  assert.equal(al.check(msg([err('evl')]), 61000, ON).length, 1);
  assert.deepEqual(texts(al.check(msg([{ ...err('evl', 'GET /c'), msg: null }]), 61000, ON)), ['[evl] GET /c']);
  assert.deepEqual(al.check(msg([{ ...err('evl', 'GET /d'), error: false }]), 61000, ON), []);
});

test('기준을 넘으면 끊김 한 번, 돌아오면 다시 연결됨 한 번', () => {
  const al = createAlerts();
  al.check(msg([], app('evl', 500)), 0, ON);
  assert.deepEqual(al.check(msg([], app('evl', 10001)), 1000, ON), [
    { kind: 'down', agent: 'evl', text: '[evl] 끊김 — 10초째 소식 없음' },
  ]);
  assert.deepEqual(al.check(msg([], app('evl', 11001)), 2000, ON), []);
  assert.deepEqual(al.check(msg([], app('evl', 300)), 3000, ON), [
    { kind: 'up', agent: 'evl', text: '[evl] 다시 연결됨' },
  ]);
  assert.deepEqual(al.check(msg([], app('evl', 300)), 4000, ON), []);
});

test('기준선에서 이미 끊긴 앱은 조용하고, 돌아오면 다시 연결됨', () => {
  const al = createAlerts();
  assert.deepEqual(al.check(msg([], app('evl', 60000)), 0, ON), []);
  assert.deepEqual(al.check(msg([], app('evl', 61000)), 1000, ON), []);
  assert.deepEqual(texts(al.check(msg([], app('evl', 100)), 2000, ON)), ['[evl] 다시 연결됨']);
});

test('기준선 뒤 처음 보이는 앱은 끊김 아님으로 시작하고, 이미 오래됐으면 바로 끊김', () => {
  const al = createAlerts();
  al.check(msg(), 0, ON);
  assert.deepEqual(al.check(msg([], app('new', 100)), 1000, ON), []);
  assert.deepEqual(texts(al.check(msg([], app('old', 20000)), 2000, ON)), ['[old] 끊김 — 10초째 소식 없음']);
});

test('꺼 둔 조건은 경보하지 않고, 끊김 상태는 계속 따라간다', () => {
  const al = createAlerts();
  const off = { errors: false, down: false, downMs: 10000 };
  al.check(msg([], app('evl', 0)), 0, off);
  assert.deepEqual(al.check(msg([err('evl')], app('evl', 20000)), 1000, off), []);
  // 끊긴 채로 다시 켜도 '끊김'을 뒤늦게 내지 않는다
  assert.deepEqual(al.check(msg([], app('evl', 21000)), 2000, ON), []);
  assert.deepEqual(texts(al.check(msg([], app('evl', 0)), 3000, ON)), ['[evl] 다시 연결됨']);
});

test('끊김 문구의 초는 기준(downMs)을 반올림한 값', () => {
  const al = createAlerts();
  const opts = { ...ON, downMs: 30000 };
  al.check(msg([], app('evl', 0)), 0, opts);
  assert.deepEqual(texts(al.check(msg([], app('evl', 30001)), 1000, opts)), ['[evl] 끊김 — 30초째 소식 없음']);
});

test('reset() 뒤 첫 메시지는 다시 기준선', () => {
  const al = createAlerts();
  al.check(msg([], app('evl', 0)), 0, ON);
  al.reset();
  assert.deepEqual(al.check(msg([err('evl')], app('evl', 20000)), 1000, ON), []);
  assert.deepEqual(al.check(msg([], app('evl', 21000)), 2000, ON), []);
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/alerts.test.mjs`
Expected: FAIL — `Cannot find module …/dashboard/alerts.mjs`.

- [ ] **Step 3: 구현** — `dashboard/alerts.mjs`

```js
// 경보 판단. 브라우저 API를 쓰지 않는 순수 로직이라 테스트가 그대로 부른다.
const REPEAT_MS = 60 * 1000; // 같은 앱·같은 이름의 에러 경보는 1분에 한 번

export function createAlerts() {
  let baseline = true;         // 연결 직후 첫 메시지: 상태만 기억하고 경보하지 않는다
  const lastError = new Map(); // `${agent} ${name}` → 마지막 에러 경보 시각
  const down = new Set();      // 끊김으로 기억한 앱

  return {
    reset() {
      baseline = true;
    },
    // opts = { errors, down, downMs }. 꺼 둔 조건도 끊김 상태는 계속 따라간다(다시 켰을 때 엉뚱한 경보가 없게).
    check(msg, now, opts) {
      const out = [];
      for (const a of msg.agents) {
        const isDown = a.ago > opts.downMs;
        if (isDown === down.has(a.name)) continue;
        if (isDown) down.add(a.name);
        else down.delete(a.name);
        if (baseline || !opts.down) continue;
        out.push(isDown
          ? { kind: 'down', agent: a.name, text: `[${a.name}] 끊김 — ${Math.round(opts.downMs / 1000)}초째 소식 없음` }
          : { kind: 'up', agent: a.name, text: `[${a.name}] 다시 연결됨` });
      }
      if (!baseline && opts.errors) {
        for (const p of msg.points) {
          if (!p.error) continue;
          const key = `${p.agent} ${p.name}`;
          if (now - (lastError.get(key) ?? -Infinity) < REPEAT_MS) continue;
          lastError.set(key, now);
          out.push({ kind: 'error', agent: p.agent, text: `[${p.agent}] ${p.name}${p.msg ? ` — ${p.msg}` : ''}` });
        }
      }
      baseline = false;
      return out;
    },
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/alerts.test.mjs`
Expected: PASS 8/8.

- [ ] **Step 5: 커밋**

```bash
git add dashboard/alerts.mjs test/alerts.test.mjs
git commit -m "feat(dashboard): alert rules for error requests and agent disconnects"
```

---

### Task 3: 대시보드 화면 — 앱 버튼, 거르기, 모양, 최근 에러, 경보 표시, 설정

**Files:**
- Modify: `dashboard/calc.mjs` (`downSec` 추가)
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.mjs`
- Modify: `README.md`
- Test: `test/calc.test.mjs`, `test/dashboard.test.js`

**Interfaces:**
- Consumes: Task 1의 스트림 메시지, Task 2의 `createAlerts`.
- Produces: `downSec(v) → number` (calc.mjs).

- [ ] **Step 1: 실패하는 테스트 쓰기**

`test/calc.test.mjs`: import를 `import { downSec, pickInRect, yMax } from '../dashboard/calc.mjs';`로 바꾸고 끝에 추가:

```js
test('downSec: 1~600 정수만, 그 밖이면 10', () => {
  assert.equal(downSec('30'), 30);
  assert.equal(downSec(1), 1);
  assert.equal(downSec('600'), 600);
  for (const v of ['', 'abc', '0', '601', '2.5', null, undefined]) assert.equal(downSec(v), 10);
});
```

`test/dashboard.test.js`를 대시보드의 모든 스크립트 검사로 바꾼다:

```js
test('대시보드는 HTML 문자열을 끼워 넣지 않는다(textContent만)', () => {
  for (const file of ['app.mjs', 'alerts.mjs', 'calc.mjs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', file), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/calc.test.mjs test/dashboard.test.js`
Expected: FAIL — `downSec`가 export되지 않음(SyntaxError: does not provide an export named 'downSec'). dashboard 테스트는 통과(검사 범위만 넓힘).

- [ ] **Step 3: `downSec` 구현** — `dashboard/calc.mjs` 끝에

```js
// 끊김 기준(초): 1~600 정수만, 그 밖이면 10
export function downSec(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 600 ? n : 10;
}
```

Run: `fnm exec --using=22 node --test test/calc.test.mjs test/dashboard.test.js` → Expected: PASS.

- [ ] **Step 4: `dashboard/index.html`**

`<style>` 끝(`#status { … }` 다음)에 추가:

```css
  #alertbar { display: flex; gap: 12px; align-items: flex-start; background: #3a1418; border: 1px solid var(--err); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
  #alertbar[hidden] { display: none; }
  #alerts { margin: 0; padding: 0; list-style: none; flex: 1; min-width: 0; }
  #alerts li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #bar { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  #apps { display: flex; flex-wrap: wrap; gap: 6px; }
  button { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; font: inherit; cursor: pointer; }
  button:disabled { cursor: default; color: var(--dim); }
  #apps button.on { border-color: var(--ok); color: var(--ok); }
  #apps button.down::after { content: ' ●'; color: var(--err); }
  #settings { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--dim); font-size: 13px; }
  #settings input[type=number] { width: 56px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; }
  #legend { font-weight: 400; margin-left: 8px; }
  #errlist { max-height: 240px; overflow: auto; }
  #errlist table { table-layout: fixed; }
  #errlist td:nth-child(1) { width: 90px; }
  #errlist td:nth-child(2) { width: 110px; }
  #errlist td:nth-child(3) { width: 40%; }
```

`<body>` 바로 아래, `<div id="tiles">` 앞에:

```html
  <div id="alertbar" hidden><ul id="alerts"></ul><button id="ack">확인</button></div>
  <div id="bar">
    <div id="apps"></div>
    <div id="settings">
      <label><input type="checkbox" id="optErrors"> 에러 경보</label>
      <label><input type="checkbox" id="optDown"> 끊김 경보</label>
      <label>끊김 기준 <input type="number" id="optDownSec" min="1" max="600"> 초</label>
      <button id="notify" hidden>알림 켜기</button>
    </div>
  </div>
```

X-View 제목을 `<h2>X-View — 영역을 끌어서 고르세요 <span id="legend"></span> <span id="status"></span></h2>`로.
`<div id="main">…</div>` 닫는 줄과 `<section class="panel"><h2>고른 트랜잭션</h2>` 사이에:

```html
  <section class="panel"><h2>최근 에러</h2><div id="errlist">없음</div></section>
```

- [ ] **Step 5: `dashboard/app.mjs`**

import와 상수·상태:

```js
import { createAlerts } from './alerts.mjs';
import { downSec, pickInRect, yMax } from './calc.mjs';

const WINDOW_MS = 5 * 60 * 1000;            // X-View에 보이는 시간
const PAD = { l: 52, r: 24, t: 8, b: 22 };   // 축 글자 자리
const MAX_ROWS = 200;                        // ponytail: 목록은 200줄까지, 더 필요하면 페이지 나누기
const MAX_ERRORS = 50;                       // 최근 에러 패널 줄 수
const MAX_BANNER = 5;                        // 빨간 줄에 보이는 경보 수
const SHAPES = ['●', '▲', '■', '◆'];         // 앱마다 점 모양(agents 순서로 반복)
const ZERO = { tps: 0, avg: 0, p95: 0, errors: 0 };
const TITLE = document.title;
const COLOR = { ok: '#4ea1ff', err: '#ff5c5c', grid: '#2a3440', dim: '#8593a3', drag: '#ffcc4d' };

const points = new Map(); // id → 점 (재연결 때 겹쳐 와도 한 번만)
let drag = null;          // 끌고 있는 사각형(캔버스 좌표)
let scale = null;         // 마지막으로 그린 축: 좌표 ↔ 값 변환
let last = null;          // 마지막으로 받은 메시지(stats, agentStats, agents, active)
let errKey = '';          // 최근 에러 패널에 그린 점 id들. 같으면 다시 만들지 않는다(클릭이 사라지지 않게)
let recent = [];          // 빨간 줄에 보일 경보 문구(최근 MAX_BANNER개)
let unacked = 0;          // 확인 안 한 경보 수

const $ = (id) => document.getElementById(id);
const canvas = $('xview');
const ctx = canvas.getContext('2d');

// 설정은 이 브라우저에만 기억한다. 저장소가 막혀 있으면 기본값으로 동작한다.
function load(key, def) {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 이번 화면에서만 유지
  }
}

let selected = load('apm.app', ''); // '' = 전체
const opts = {
  errors: load('apm.errors', '1') === '1',
  down: load('apm.down', '1') === '1',
  downMs: downSec(load('apm.downSec', '10')) * 1000,
};
const alerts = createAlerts();

const visible = (p) => !selected || p.agent === selected;
const tag = (agent) => (selected ? '' : `[${agent}] `);
const shapeOf = (agent) => SHAPES[Math.max(0, (last?.agents ?? []).findIndex((a) => a.name === agent)) % SHAPES.length];
```

실시간 수신을 바꾼다:

```js
const es = new EventSource('/stream');
es.onopen = () => {
  $('status').textContent = '';
  alerts.reset(); // 다시 연결되면 첫 메시지는 지난 5분치라 경보 기준선으로만 쓴다
};
es.onerror = () => ($('status').textContent = '(연결 끊김 — 다시 연결하는 중)');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  for (const p of msg.points) points.set(p.id, p);
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, p] of points) if (p.t < cutoff) points.delete(id);
  last = msg;
  raise(alerts.check(msg, Date.now(), opts));
  render();
};
addEventListener('resize', draw);

function render() {
  if (!last) return;
  showApps();
  showStats(selected ? last.agentStats[selected] ?? ZERO : last.stats);
  showActive(last.active.filter(visible));
  showErrors();
  draw();
}
```

`draw()` 안: 점 그리는 반복을 바꾸고, 범례를 채운다:

```js
  // 에러 점이 위에 오도록 정상 점을 먼저 그린다. 모양은 앱마다 다르다.
  for (const error of [false, true]) {
    ctx.fillStyle = error ? COLOR.err : COLOR.ok;
    for (const p of points.values()) {
      if (p.error === error && visible(p)) mark(shapeOf(p.agent), scale.x(p.t), scale.y(p.elapsed));
    }
  }
```

`draw()` 아래에 추가:

```js
function mark(shape, x, y) {
  const r = 2.5;
  ctx.beginPath();
  if (shape === '●') ctx.arc(x, y, r, 0, 2 * Math.PI);
  else if (shape === '▲') {
    ctx.moveTo(x, y - r - 0.5);
    ctx.lineTo(x + r + 0.5, y + r);
    ctx.lineTo(x - r - 0.5, y + r);
  } else if (shape === '◆') {
    ctx.moveTo(x, y - r - 1);
    ctx.lineTo(x + r + 1, y);
    ctx.lineTo(x, y + r + 1);
    ctx.lineTo(x - r - 1, y);
  } else ctx.rect(x - r, y - r, 2 * r, 2 * r);
  ctx.fill();
}
```

`pointerup`의 `pickInRect([...points.values()], …)` → `pickInRect([...points.values()].filter(visible), …)`.

`showActive`의 `row('td', [a.name, …])` → `row('td', [tag(a.agent) + a.name, …])`, `tr.children[0].title = a.name` → `tr.children[0].title = tag(a.agent) + a.name`.
`showPicked`의 `p.name` → `tag(p.agent) + p.name`.

`// ---- 표 ----` 위에 앱·에러·경보 부분을 추가:

```js
// ---- 앱 버튼 ----

// 버튼은 앱 목록이 바뀔 때만 새로 만든다(1초마다 새로 만들면 누르는 중에 사라진다).
function showApps() {
  const box = $('apps');
  const names = ['', ...last.agents.map((a) => a.name)];
  if (box.children.length !== names.length || names.some((n, i) => box.children[i].dataset.app !== n)) {
    box.replaceChildren(...names.map((n) => {
      const b = document.createElement('button');
      b.dataset.app = n;
      b.textContent = n || '전체';
      b.onclick = () => {
        selected = n;
        save('apm.app', n);
        $('picked').replaceChildren();
        render();
      };
      return b;
    }));
  }
  for (const b of box.children) {
    const a = last.agents.find((x) => x.name === b.dataset.app);
    b.classList.toggle('on', b.dataset.app === selected);
    b.classList.toggle('down', Boolean(a && a.ago > opts.downMs));
  }
  $('legend').textContent = selected ? '' : last.agents.map((a) => `${shapeOf(a.name)} ${a.name}`).join('   ');
}

// ---- 최근 에러 ----

function showErrors() {
  const list = [...points.values()].filter((p) => p.error && visible(p)).sort((a, b) => b.t - a.t).slice(0, MAX_ERRORS);
  const key = list.map((p) => p.id).join(' ');
  if (key === errKey) return;
  errKey = key;
  if (list.length === 0) return $('errlist').replaceChildren('없음');
  const table = document.createElement('table');
  for (const p of list) {
    const tr = row('td', [new Date(p.t).toLocaleTimeString(), p.agent, p.name, p.msg ?? '']);
    tr.className = 'row err';
    for (const td of [tr.children[1], tr.children[2], tr.children[3]]) {
      td.className = 'ell';
      td.title = td.textContent;
    }
    tr.onclick = () => showDetail(p.id);
    table.append(tr);
  }
  $('errlist').replaceChildren(table);
}

// ---- 경보 ----

function raise(list) {
  if (list.length === 0) return;
  const at = new Date().toLocaleTimeString();
  for (const a of list) {
    recent.push(`${at} ${a.text}`);
    unacked++;
    // 대시보드를 보고 있으면 빨간 줄로 충분하다
    if (window.Notification?.permission === 'granted' && !document.hasFocus()) new Notification('미니 APM', { body: a.text });
  }
  recent = recent.slice(-MAX_BANNER);
  showAlerts();
}

function showAlerts() {
  $('alertbar').hidden = unacked === 0;
  $('alerts').replaceChildren(...[...recent].reverse().map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    li.title = t;
    return li;
  }));
  document.title = unacked ? `(⚠${unacked}) ${TITLE}` : TITLE;
}

$('ack').onclick = () => {
  recent = [];
  unacked = 0;
  showAlerts();
};

// ---- 설정 ----

$('optErrors').checked = opts.errors;
$('optDown').checked = opts.down;
$('optDownSec').value = opts.downMs / 1000;
$('optErrors').onchange = (e) => {
  opts.errors = e.target.checked;
  save('apm.errors', opts.errors ? '1' : '0');
};
$('optDown').onchange = (e) => {
  opts.down = e.target.checked;
  save('apm.down', opts.down ? '1' : '0');
};
$('optDownSec').onchange = (e) => {
  const sec = downSec(e.target.value);
  e.target.value = sec;
  opts.downMs = sec * 1000;
  save('apm.downSec', String(sec));
  render();
};

function showNotify() {
  const b = $('notify');
  if (!('Notification' in window)) return (b.hidden = true);
  const p = Notification.permission;
  b.hidden = false;
  b.disabled = p !== 'default';
  b.textContent = p === 'granted' ? '알림 켜짐' : p === 'denied' ? '알림 차단됨(브라우저 설정)' : '알림 켜기';
}
$('notify').onclick = async () => {
  await Notification.requestPermission();
  showNotify();
};
showNotify();
```

`showStats`는 그대로(받은 객체의 4개 값을 쓴다).

- [ ] **Step 6: 화면 확인(Playwright)**

PowerShell 창 하나에서(또는 Git Bash 백그라운드로) 띄운다:
- `node collector/server.js`, `node sample/payment.js`
- `node --require ./agent sample/app.js` (`APM_AGENT=sample`, 7701) + `node sample/load.js 5`
- `PORT=7703 APM_AGENT=sample2 node --require ./agent sample/app.js` + `APP_URL=http://localhost:7703 node sample/load.js 5`

스크래치 폴더에 스크립트를 두고 `C:/Users/jjshs/atelier/node_modules/playwright`, `executablePath: process.env.CHROMIUM_PATH`로 1400×1000 화면을 연다. 확인할 것:
1. 20초 뒤: 버튼 [전체][sample][sample2], X-View 범례 `● sample   ▲ sample2`, 최근 에러에 `/boom` 줄, 빨간 줄과 탭 제목 `(⚠N) 미니 APM` → 스크린샷.
2. [sample2] 클릭: 버튼 강조, 처리 중·최근 에러가 sample2만, 앱 이름 `[ ]` 없음 → 스크린샷. 최근 에러 첫 줄 클릭 → 상세가 열린다.
3. sample2 앱 프로세스를 끝내고 12초 뒤: 빨간 줄에 `[sample2] 끊김 — 10초째 소식 없음`, sample2 버튼에 빨간 점 → 스크린샷.
4. `localStorage.setItem('apm.app','gone')` 후 새로고침: 화면이 비어도 [전체] 클릭으로 돌아온다.
5. [확인] 클릭 → 빨간 줄 사라지고 제목이 `미니 APM`.

Expected: 모두 위와 같다. 스크린샷을 읽어 눈으로 확인한다. 끝나면 띄운 프로세스를 모두 끝낸다.

- [ ] **Step 7: README**

`README.md`:
- Java 절의 `- **Environment**: \`APM_AGENT=ipfinance\` (보내는 쪽 이름. 대시보드에는 아직 표시하지 않는다)` →
  `- **Environment**: \`APM_AGENT=ipfinance\` (보내는 쪽 이름. 대시보드 맨 위 앱 버튼에 이 이름이 나온다. EVL은 \`evl\`)`
- 'JENNIFER와 대응' 표 끝에 줄 추가:
  `| 앱 버튼 + 최근 에러 + 경보(\`dashboard/alerts.mjs\`) | 도메인/인스턴스 선택, 이벤트·경보 | 경보는 '처음 본 순간'만 알리고 반복은 묶어야 쓸 만하다 |`
- `## 실행` 절의 "브라우저에서 http://localhost:7700 을 연다." 문단 뒤에 추가:
  `경보(에러 난 요청, 앱 끊김)는 대시보드 탭이 열려 있을 때만 울린다. 다른 창을 보고 있을 때 Windows 알림을 받으려면 맨 위 [알림 켜기]를 한 번 누른다.`

- [ ] **Step 8: 전체 테스트**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 실패 0 (기존 37 + 새 store 4 + alerts 8 + calc 1 = 50).

- [ ] **Step 9: 커밋**

```bash
git add dashboard/calc.mjs dashboard/index.html dashboard/app.mjs README.md test/calc.test.mjs test/dashboard.test.js
git commit -m "feat(dashboard): per-app buttons, recent errors panel, alert bar and notifications"
```

---

### Task 4: 긴 SQL을 자르지 않기(Java 에이전트)

**Files:**
- Modify: `agent-java/src/apm/Tracer.java:27` (`MAX_SQL`)
- Modify: `agent-java/test/TestApp.java` (`/long` 추가)
- Modify: `README.md`
- Test: `test/java-agent.test.js`

**Interfaces:** 없음(구간 `text` 모양은 그대로, 길이 한도만 바뀐다).

- [ ] **Step 1: 실패하는 테스트 쓰기**

`agent-java/test/TestApp.java`의 `case "/many":` 앞에 추가:

```java
            case "/long": // MyBatis 동적 SQL처럼 긴 문장(5,000자 넘음)도 잘리지 않아야 한다
              StringBuilder in = new StringBuilder("select name from item where id in (0");
              for (int i = 1; i <= 1200; i++) in.append(", ").append(i);
              try (Statement s = db.createStatement()) {
                s.executeQuery(in.append(") and name <> 'end'").toString()).close();
              }
              break;
```

`test/java-agent.test.js`의 '바인드 값이 SQL에 끼워 넣어지고…' 테스트 바로 뒤에 추가:

```js
  test('긴 SQL도 자르지 않고 보낸다', async () => {
    assert.equal(await get('/long'), 200);
    const tx = await waitTx('GET /long');
    const sql = tx.spans[0].text;
    assert.ok(sql.length > 5000, String(sql.length));
    assert.match(sql, /, 1200\) and name <> 'end'$/);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: '긴 SQL도 자르지 않고 보낸다'만 FAIL — 길이 `1000`. (테스트가 jar를 다시 빌드한다.)

- [ ] **Step 3: 구현** — `agent-java/src/apm/Tracer.java`

```java
  static final int MAX_SQL = 100_000; // SQL 문장·URL 길이(문자). 한글이라도 약 300KB라 MAX_BODY 안에 든다
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: PASS, 실패 0.

- [ ] **Step 5: README**

Java 절의 "SQL 구간에는 바인드 값이 끼워 넣어진 문장이 보인다(…)." 문장 뒤에 이어서:
` 문장은 10만 자까지 그대로 보이고, 바인드 값 하나는 200자에서 잘라 \`...\`을 붙인다.`

- [ ] **Step 6: 전체 테스트**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 실패 0 (Task 3까지 50 + 1 = 51).

- [ ] **Step 7: 커밋**

```bash
git add agent-java/src/apm/Tracer.java agent-java/test/TestApp.java test/java-agent.test.js README.md
git commit -m "feat(agent-java): keep long SQL up to 100k chars instead of cutting at 1000"
```
