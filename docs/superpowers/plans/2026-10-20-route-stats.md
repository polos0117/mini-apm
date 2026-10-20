# API(URL)별 통계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드에 API별(Spring 매핑 패턴으로 묶은) 횟수·에러·평균·p95·최대·총 시간 표를 최근 10분/서버 켠 뒤 전체로 보여 주고, 줄을 누르면 그 API의 트랜잭션 목록을 띄운다.

**Architecture:** Java 에이전트가 요청 끝에 Spring의 `bestMatchingPattern`을 실제 경로와 맞춰 본 뒤 트랜잭션에 `route`로 싣는다. 수집 서버의 store가 키(`route` 또는 `name`)·앱별로 최근 10분은 보관 중인 트랜잭션에서, 전체는 받을 때마다 쌓은 누계(로그 눈금 구간으로 p95 근사)에서 계산해 `/routes`, `/routes/txs`로 내준다. 대시보드는 5초마다 받아 정렬해 표로 그린다.

**Tech Stack:** Java 8 + Byte Buddy 에이전트(기존), Node 22 `node:http`·`node:test`(기존), 브라우저 ES 모듈(기존). 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-20-route-stats-design.md`

## Global Constraints

- `D:\AnyBuilder` 아래는 고치지 않는다(대상 앱 코드와 Eclipse 설정은 그대로).
- 수집 서버는 `127.0.0.1`에서만 받는다(바꾸지 않는다).
- 사용자의 수집 서버(포트 7700)는 건드리지 않는다. Playwright 확인은 7710~7713.
- 소스 파일은 CRLF다. 고칠 때는 Edit 도구를 쓴다(sed·node 문자열 치환 금지).
- 대시보드는 `innerHTML` 등을 쓰지 않는다(`textContent`만, `test/dashboard.test.js`가 검사).
- 에이전트 코드는 무엇이 실패해도 앱 응답에 영향이 없어야 한다(예외를 삼킨다).
- 키 = `route`(비어 있지 않은 문자열일 때) 또는 `name`. 앱마다 따로.
- 전체 기간 p95: 구간 `i = ms < 1 ? 0 : floor(log(ms) / log(1.1)) + 1`, 위 경계 `1.1^i`, `max`보다 크면 `max`.
- 앱마다 키 2,000개. 넘으면 `(기타)`.
- 표 50줄, 5초마다 갱신, localStorage 키 `apm.routeRange`, `apm.routeSort`.
- 테스트 명령: 전체 `fnm exec --using=22 npm.cmd test`(Git Bash), Java만 `fnm exec --using=22 node --test test/java-agent.test.js`.
- 커밋 끝줄: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. 수집 서버에 같은 트랜잭션 id가 두 번 오면(에이전트 재전송) 전체 누계가 두 번 세면 안 된다 → Task 2 테스트에 넣음.
2. `{`·`}`·`&`·`/`·한글이 든 키로 `/routes/txs`를 부르면 그 키의 트랜잭션이 정확히 나와야 한다(대시보드는 `encodeURIComponent`) → Task 2 테스트에 넣음.
3. 아주 긴 키(MyBatis가 아닌 긴 REST 경로)도 표가 가로로 넘치지 않고 줄바꿈되어야 한다 → Task 3 Playwright 확인에 넣음.
4. 패턴 읽기가 실패해도(이상한 속성 객체) 다른 요청 정보는 남아야 한다 → `route`를 따로 `try`로 감싸고 Task 1 코드에 반영(별도 테스트는 테스트 앱에서 재현이 어려워 코드 구조로 보장).
5. 대시보드가 `/routes`를 못 받으면(수집 서버 재시작 중) 표가 지워지거나 콘솔이 에러로 가득 차면 안 된다 → Task 3 코드의 `try`로 반영, Playwright에서 확인하지 않음.

---

### Task 1: Java 에이전트 `route`

**Files:**
- Modify: `agent-java/src/apm/RequestInfo.java` (`collect`, 새 `route`·`matches`)
- Modify: `agent-java/src/apm/Tracer.java` (`Tx.route` 필드, `request(...)` 인자, `json` 출력)
- Modify: `agent-java/test/TestApp.java` (패턴 속성 넣기, `/ctx` 컨텍스트)
- Test: `test/java-agent.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: 트랜잭션 JSON 최상위 `"route": string | null` (Task 2가 `tx.route`로 읽는다)

- [ ] **Step 1: 테스트 앱에 패턴 속성과 `/ctx` 컨텍스트를 넣는다**

`agent-java/test/TestApp.java`에서 서블릿을 변수로 빼서 두 컨텍스트에 붙인다.

바꿀 곳 1 — `Tomcat.addServlet(ctx, "app", new HttpServlet() {` 를:
```java
    HttpServlet app = new HttpServlet() {
```

바꿀 곳 2 — `doGet` 안 `switch (req.getServletPath()) {` 바로 앞에 넣는다:
```java
          // Spring이 넣는 매칭 패턴 흉내(테스트 앱에는 Spring이 없다)
          String path = req.getServletPath();
          if (path.startsWith("/items/")) req.setAttribute(PATTERN, "/items/{id}");
          else if (path.startsWith("/other/")) req.setAttribute(PATTERN, "/error");
          else if (path.startsWith("/files/")) req.setAttribute(PATTERN, "/**");
```

바꿀 곳 3 — 서블릿 끝과 매핑:
```java
    });
    ctx.addServletMappingDecoded("/", "app");
```
를:
```java
    };
    Tomcat.addServlet(ctx, "app", app);
    ctx.addServletMappingDecoded("/", "app");
    Context sub = tomcat.addContext("/ctx", null); // 컨텍스트 경로가 있는 앱(KIPA 앱처럼)
    Tomcat.addServlet(sub, "app", app);
    sub.addServletMappingDecoded("/", "app");
```

바꿀 곳 4 — `static final Logger log = ...` 아래에:
```java
  static final String PATTERN = "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`test/java-agent.test.js`의 `test('정적 파일 요청은 기록하지 않는다', ...)` 앞에 넣는다:
```js
  test('Spring 패턴이 실제 경로와 맞으면 route = 메서드 + 컨텍스트 경로 + 패턴', async () => {
    assert.equal(await get('/items/7'), 200);
    assert.equal((await waitTx('GET /items/7')).route, 'GET /items/{id}');
    assert.equal(await get('/ctx/items/8'), 200);
    assert.equal((await waitTx('GET /ctx/items/8')).route, 'GET /ctx/items/{id}');
  });

  test('패턴이 없거나, 와일드카드거나, 경로와 안 맞으면(/error) route는 null', async () => {
    for (const p of ['/other/1', '/files/a', '/nopattern']) {
      assert.equal(await get(p), 200);
      assert.equal((await waitTx(`GET ${p}`)).route, null, p);
    }
  });
```

- [ ] **Step 3: 실패를 확인한다**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: 새 테스트 2개 FAIL(`undefined` ≠ `'GET /items/{id}'`, `undefined` ≠ `null`). 나머지는 PASS.

- [ ] **Step 4: `RequestInfo`에 `route`를 만든다**

`agent-java/src/apm/RequestInfo.java`:

상수 추가(`MAX_PARAMS` 아래):
```java
  static final String PATTERN_ATTR = "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";
```

`collect`를 바꾼다:
```java
  // 무엇이 실패해도 앱 응답과 트랜잭션 종료에 영향이 없게 모두 삼킨다
  public static void collect(Tracer.Tx tx, HttpServletRequest r) {
    if (tx == null) return;
    String ip = null, user = null, referer = null, params = null, route = null;
    try {
      ip = ip(r);
      referer = r.getHeader("Referer");
      params = params(r);
      user = user(r);
    } catch (Throwable ignored) {
      // 세션 무효화 등
    }
    try {
      route = route(r);
    } catch (Throwable ignored) {
      // 패턴을 못 읽으면 주소 그대로 묶인다
    }
    Tracer.request(tx, ip, user, referer, params, route);
  }
```

`ip(...)` 메서드 위에 추가:
```java
  // API별 통계의 묶음 이름. Spring이 고른 패턴이 실제 경로와 맞을 때만 "GET /ctx/qna/{procsCode}/list", 아니면 null
  static String route(HttpServletRequest r) {
    Object p = r.getAttribute(PATTERN_ATTR); // String 또는 Spring 5.3 PathPattern(toString이 패턴)
    if (p == null) return null;
    String pattern = p.toString();
    String ctx = r.getContextPath() == null ? "" : r.getContextPath();
    String uri = r.getRequestURI();
    if (uri == null || !uri.startsWith(ctx)) return null;
    return matches(pattern, uri.substring(ctx.length())) ? r.getMethod() + " " + ctx + pattern : null;
  }

  // 와일드카드(/** 등)가 없고, 조각 수가 같고, 조각마다 글자가 같거나 {변수}. 에러로 /error에 넘어간 요청도 여기서 걸러진다
  static boolean matches(String pattern, String path) {
    if (pattern.indexOf('*') >= 0 || pattern.indexOf('?') >= 0) return false;
    String[] a = pattern.split("/"), b = path.split("/");
    if (a.length != b.length) return false;
    for (int i = 0; i < a.length; i++) {
      boolean var = a[i].startsWith("{") && a[i].endsWith("}");
      if (!var && !a[i].equals(b[i])) return false;
    }
    return true;
  }
```

- [ ] **Step 5: `Tracer`가 `route`를 싣는다**

`agent-java/src/apm/Tracer.java`:

`Tx` 필드 — `String ip, user, referer, params; // 요청 정보(RequestInfo가 끝날 때 채운다)` 아래:
```java
    String route; // API별 통계의 묶음 이름(Spring 패턴). 없으면 수집 서버가 name으로 묶는다
```

`request`:
```java
  // 요청이 끝날 때 RequestInfo가 정리해 넘긴다
  public static void request(Tx tx, String ip, String user, String referer, String params, String route) {
    tx.ip = ip;
    tx.user = user;
    tx.referer = cut(referer);
    tx.params = params;
    tx.route = cut(route);
  }
```

`json` — `str(b, t.error);` 다음 줄 `b.append(",\"req\":{\"ip\":");` 앞에:
```java
    b.append(",\"route\":");
    str(b, t.route);
```

- [ ] **Step 6: 통과를 확인한다**

Run: `fnm exec --using=22 node --test test/java-agent.test.js`
Expected: 모두 PASS(기존 + 새 2개).

- [ ] **Step 7: 커밋**

```bash
git add agent-java/src/apm/RequestInfo.java agent-java/src/apm/Tracer.java agent-java/test/TestApp.java test/java-agent.test.js
git commit -m "feat(agent-java): route = Spring matching pattern when it fits the request path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 수집 서버 API별 집계와 주소

**Files:**
- Modify: `collector/store.js` (누계, `routes`, `routeTxs`)
- Modify: `collector/server.js` (`/routes`, `/routes/txs`)
- Test: `test/store.test.js`, `test/collector.test.js`

**Interfaces:**
- Consumes: 트랜잭션의 `route`(Task 1). 없거나 빈 문자열이면 `name`.
- Produces:
  - `store.routes(range: '10m' | 'all') → [{ agent, key, count, errors, avg, p95, max, total }]` (ms, 반올림)
  - `store.routeTxs(agent: string, key: string) → 점[]`(응답시간 긴 순)
  - `GET /routes?range=all|…` → `{ range: '10m' | 'all', rows }`
  - `GET /routes/txs?agent=&key=` → 점 배열(둘 중 하나라도 없으면 `[]`)

- [ ] **Step 1: store 실패 테스트를 쓴다**

`test/store.test.js` 끝에 덧붙인다:
```js
const rtx = (id, agent, elapsed, extra = {}) =>
  ({ id, name: `GET /items/${id}`, route: 'GET /items/{id}', start: 1000, elapsed, status: 200, error: null, spans: [], ...extra });
const byKey = (rows) => Object.fromEntries(rows.map((r) => [`${r.agent} ${r.key}`, r]));

test('API별: route로 묶고, 없으면 name, 앱이 다르면 다른 줄', () => {
  const s = createStore();
  s.ingest('a', [rtx('1', 'a', 10), rtx('2', 'a', 30, { error: 'x' }), rtx('3', 'a', 5, { route: null, name: 'GET /hello' })], [], 0);
  s.ingest('b', [rtx('4', 'b', 7)], [], 0);
  for (const range of ['10m', 'all']) {
    const rows = byKey(s.routes(range));
    assert.equal(Object.keys(rows).length, 3, range);
    assert.deepEqual(rows['a GET /items/{id}'], {
      agent: 'a', key: 'GET /items/{id}', count: 2, errors: 1, avg: 20, p95: 30, max: 30, total: 40,
    }, range);
    assert.equal(rows['a GET /hello'].count, 1, range);
    assert.equal(rows['b GET /items/{id}'].count, 1, range);
  }
});

test('API별 전체: prune 뒤에도 남고, 같은 id를 두 번 받아도 한 번만 센다', () => {
  const s = createStore();
  s.ingest('a', [rtx('1', 'a', 10)], [], 0);
  s.ingest('a', [rtx('1', 'a', 10)], [], 0);
  s.prune(1000 + 11 * 60 * 1000);
  assert.deepEqual(s.routes('10m'), []);
  assert.equal(s.routes('all')[0].count, 1);
});

test('API별 전체: p95 근사는 정확한 값의 10% 안, max보다 크지 않다', () => {
  const s = createStore();
  const list = Array.from({ length: 1000 }, (_, i) => rtx(String(i), 'a', (i % 500) + 0.5));
  s.ingest('a', list, [], 0);
  const exact = p95(list.map((t) => t.elapsed));
  const [all] = s.routes('all');
  assert.ok(all.p95 >= exact && all.p95 <= exact * 1.1, `${all.p95} vs ${exact}`);
  assert.ok(all.p95 <= all.max);
  assert.equal(s.routes('10m')[0].p95, Math.round(exact));
});

test('API별 전체: 앱마다 키 2,000개, 넘으면 (기타)', () => {
  const s = createStore();
  const list = Array.from({ length: 2001 }, (_, i) => rtx(String(i), 'a', 1, { route: `GET /k${i}` }));
  s.ingest('a', list, [], 0);
  const rows = s.routes('all');
  assert.equal(rows.length, 2001);
  assert.equal(rows.find((r) => r.key === '(기타)').count, 1);
  assert.equal(rows.find((r) => r.key === 'GET /k2000'), undefined);
});

test('API별 트랜잭션: 그 앱·키만, 느린 순, 특수 문자 키도 그대로', () => {
  const s = createStore();
  const key = 'GET /한글/{id}&x';
  s.ingest('a', [rtx('1', 'a', 10, { route: key }), rtx('2', 'a', 50, { route: key }), rtx('3', 'a', 99)], [], 0);
  s.ingest('b', [rtx('4', 'b', 70, { route: key })], [], 0);
  assert.deepEqual(s.routeTxs('a', key).map((p) => p.id), ['2', '1']);
  assert.deepEqual(s.routeTxs('a', '(기타)'), []);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `fnm exec --using=22 node --test test/store.test.js`
Expected: 새 5개 FAIL(`s.routes is not a function`), 기존 PASS.

- [ ] **Step 3: store를 구현한다**

`collector/store.js`:

상수(`MAX_MSG` 아래):
```js
const MAX_ROUTES = 2000;         // 앱마다 API별 누계 키 수. 넘치면 (기타)
const OTHER = '(기타)';
const LOG_STEP = Math.log(1.1);  // 누계 p95용 응답시간 구간(약 10%씩)
```

`toPoint` 아래:
```js
const routeKey = (tx) => (typeof tx.route === 'string' && tx.route ? tx.route : String(tx.name));
const bucket = (ms) => (ms < 1 ? 0 : Math.floor(Math.log(ms) / LOG_STEP) + 1); // 구간 i = [1.1^(i-1), 1.1^i)
const sum = (list) => list.reduce((a, tx) => a + tx.elapsed, 0);
```

`summarize` 아래:
```js
// 누계의 p95: 작은 구간부터 더해 95%에 닿는 구간의 위 경계. 실제보다 최대 10% 크다
function histP95(r) {
  const need = Math.ceil(0.95 * r.count);
  let seen = 0;
  for (const b of [...r.hist.keys()].sort((x, y) => x - y)) {
    seen += r.hist.get(b);
    if (seen >= need) return Math.min(r.max, 1.1 ** b);
  }
  return r.max;
}
```

`createStore` 안, `const seen = ...` 아래:
```js
  const totals = new Map(); // 앱 → (키 → { count, errors, total, max, hist: 구간 → 개수 }). 수집 서버가 켜져 있는 동안 쌓는다

  function addTotal(agent, tx) {
    let routes = totals.get(agent);
    if (!routes) totals.set(agent, (routes = new Map()));
    let key = routeKey(tx);
    if (!routes.has(key) && routes.size >= MAX_ROUTES) key = OTHER;
    let r = routes.get(key);
    if (!r) routes.set(key, (r = { count: 0, errors: 0, total: 0, max: 0, hist: new Map() }));
    r.count++;
    if (tx.error) r.errors++;
    r.total += tx.elapsed;
    r.max = Math.max(r.max, tx.elapsed);
    const b = bucket(tx.elapsed);
    r.hist.set(b, (r.hist.get(b) ?? 0) + 1);
  }
```

`ingest`의 `added.push(toPoint(tx));` 다음 줄:
```js
        addTotal(name, tx);
```

반환 객체에 `points(since)` 다음으로 추가:
```js
    // API별 통계. 'all'은 서버 켠 뒤 누계, 그 밖은 보관 중인 최근 10분
    routes(range) {
      const rows = [];
      if (range === 'all') {
        for (const [agent, routes] of totals) {
          for (const [key, r] of routes) {
            rows.push({
              agent, key, count: r.count, errors: r.errors, avg: Math.round(r.total / r.count),
              p95: Math.round(histP95(r)), max: Math.round(r.max), total: Math.round(r.total),
            });
          }
        }
        return rows;
      }
      const groups = new Map(); // 앱 → (키 → 트랜잭션들)
      for (const tx of txs) {
        let g = groups.get(tx.agent);
        if (!g) groups.set(tx.agent, (g = new Map()));
        const key = routeKey(tx);
        if (!g.has(key)) g.set(key, []);
        g.get(key).push(tx);
      }
      for (const [agent, g] of groups) {
        for (const [key, list] of g) {
          const total = sum(list);
          rows.push({
            agent, key, count: list.length, errors: list.filter((tx) => tx.error).length,
            avg: Math.round(total / list.length), p95: Math.round(p95(list.map((tx) => tx.elapsed))),
            max: Math.round(list.reduce((m, tx) => Math.max(m, tx.elapsed), 0)), total: Math.round(total),
          });
        }
      }
      return rows;
    },
    routeTxs(agent, key) {
      return txs.filter((tx) => tx.agent === agent && routeKey(tx) === key).map(toPoint).sort((a, b) => b.elapsed - a.elapsed);
    },
```

- [ ] **Step 4: store 통과를 확인한다**

Run: `fnm exec --using=22 node --test test/store.test.js`
Expected: 모두 PASS.

- [ ] **Step 5: 수집 서버 주소 실패 테스트를 쓴다**

`test/collector.test.js` 끝에 덧붙인다:
```js
test('/routes는 최근 10분(기본)·전체를, /routes/txs는 그 API 트랜잭션을 느린 순으로', async (t) => {
  const base = await start(t);
  const key = 'GET /qna/{code}/list';
  const txs = [
    { ...sample(), id: 'r1', name: 'GET /qna/A/list', route: key, elapsed: 5 },
    { ...sample(), id: 'r2', name: 'GET /qna/B/list', route: key, elapsed: 9 },
  ];
  await post(base, JSON.stringify({ agent: 'x', txs, active: [] }));
  const ten = await (await fetch(`${base}/routes`)).json();
  assert.equal(ten.range, '10m');
  assert.deepEqual(ten.rows.map((r) => [r.agent, r.key, r.count]), [['x', key, 2]]);
  const all = await (await fetch(`${base}/routes?range=all`)).json();
  assert.equal(all.range, 'all');
  assert.equal(all.rows[0].count, 2);
  const q = `agent=x&key=${encodeURIComponent(key)}`;
  assert.deepEqual((await (await fetch(`${base}/routes/txs?${q}`)).json()).map((p) => p.id), ['r2', 'r1']);
  assert.deepEqual(await (await fetch(`${base}/routes/txs?agent=x`)).json(), []);
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `fnm exec --using=22 node --test test/collector.test.js`
Expected: 새 테스트 FAIL(`/routes`가 404 'not found'라 JSON 파싱 실패). 기존 PASS.

- [ ] **Step 7: 주소를 구현한다**

`collector/server.js`의 요청 처리:

```js
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://x'));
```
를:
```js
    let pathname, query;
    try {
      ({ pathname, searchParams: query } = new URL(req.url, 'http://x'));
```

`if (pathname.startsWith('/tx/')) {` 앞에:
```js
    if (pathname === '/routes') {
      const range = query.get('range') === 'all' ? 'all' : '10m';
      return json(res, 200, { range, rows: store.routes(range) });
    }
    if (pathname === '/routes/txs') {
      const agent = query.get('agent'), key = query.get('key');
      return json(res, 200, agent && key ? store.routeTxs(agent, key) : []);
    }
```

- [ ] **Step 8: 통과를 확인한다**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 모두 PASS.

- [ ] **Step 9: 커밋**

```bash
git add collector/store.js collector/server.js test/store.test.js test/collector.test.js
git commit -m "feat(collector): per-API stats for the last 10 minutes and since start, with /routes and /routes/txs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 대시보드 "API별 통계" 패널

**Files:**
- Modify: `dashboard/calc.mjs` (`sortRoutes`, `nextSort`, `routeSort`)
- Modify: `dashboard/index.html` (패널, CSS)
- Modify: `dashboard/app.mjs` (받기·그리기·정렬·줄 클릭)
- Modify: `README.md` (대응 표, 한계)
- Test: `test/calc.test.mjs`, Playwright 확인 스크립트(스크래치패드, 커밋하지 않음)

**Interfaces:**
- Consumes: `GET /routes?range=`, `GET /routes/txs?agent=&key=`(Task 2), 기존 `showPicked(list)`, `row(tag, cells)`, `visible(p)`, `tag(agent)`, `load`, `save`, `$`.
- Produces:
  - `sortRoutes(rows, { col, desc }) → rows`(새 배열)
  - `nextSort(sort, col) → { col, desc }`
  - `routeSort(saved: string) → { col, desc }`

- [ ] **Step 1: 정렬 함수 실패 테스트를 쓴다**

`test/calc.test.mjs`의 import를 바꾼다:
```js
import { downSec, nextSort, pickInRect, routeSort, selfTime, sortRoutes, yMax } from '../dashboard/calc.mjs';
```
끝에 덧붙인다:
```js
test('sortRoutes: 숫자 열은 값으로, API 열은 가나다로, 같으면 API 순', () => {
  const rows = [
    { key: 'GET /b', total: 10 },
    { key: 'GET /a', total: 10 },
    { key: 'GET /c', total: 30 },
  ];
  assert.deepEqual(sortRoutes(rows, { col: 'total', desc: true }).map((r) => r.key), ['GET /c', 'GET /a', 'GET /b']);
  assert.deepEqual(sortRoutes(rows, { col: 'key', desc: false }).map((r) => r.key), ['GET /a', 'GET /b', 'GET /c']);
  assert.equal(rows[0].key, 'GET /b'); // 원본은 그대로
});

test('nextSort: 같은 열은 방향을 뒤집고, 새 열은 숫자면 큰 순·API면 가나다순', () => {
  assert.deepEqual(nextSort({ col: 'total', desc: true }, 'total'), { col: 'total', desc: false });
  assert.deepEqual(nextSort({ col: 'total', desc: true }, 'count'), { col: 'count', desc: true });
  assert.deepEqual(nextSort({ col: 'total', desc: true }, 'key'), { col: 'key', desc: false });
});

test('routeSort: 기억해 둔 "열:방향"을 읽고, 모르는 값이면 총 시간 큰 순', () => {
  assert.deepEqual(routeSort('p95:asc'), { col: 'p95', desc: false });
  assert.deepEqual(routeSort('count:desc'), { col: 'count', desc: true });
  assert.deepEqual(routeSort('nope:asc'), { col: 'total', desc: true });
  assert.deepEqual(routeSort(''), { col: 'total', desc: true });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `fnm exec --using=22 node --test test/calc.test.mjs`
Expected: FAIL(`does not provide an export named 'nextSort'`).

- [ ] **Step 3: 정렬 함수를 구현한다**

`dashboard/calc.mjs` 끝에 덧붙인다:
```js
// API별 통계의 열(표 왼쪽부터). key = API 이름, 나머지는 숫자
export const ROUTE_COLS = ['key', 'count', 'errors', 'avg', 'p95', 'max', 'total'];
const byKey = (a, b) => a.key.localeCompare(b.key, 'ko');

// sort = { col, desc }. 같은 값이면 API 이름 순
export function sortRoutes(rows, sort) {
  const dir = sort.desc ? -1 : 1;
  const cmp = sort.col === 'key' ? byKey : (a, b) => a[sort.col] - b[sort.col];
  return [...rows].sort((a, b) => dir * cmp(a, b) || byKey(a, b));
}

// 머리글을 눌렀을 때: 같은 열이면 방향을 뒤집고, 새 열은 숫자면 큰 순·API면 가나다순
export function nextSort(sort, col) {
  return sort.col === col ? { col, desc: !sort.desc } : { col, desc: col !== 'key' };
}

// localStorage의 "열:방향". 모르는 열이면 총 시간 큰 순
export function routeSort(saved) {
  const [col, dir] = String(saved).split(':');
  return ROUTE_COLS.includes(col) ? { col, desc: dir !== 'asc' } : { col: 'total', desc: true };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `fnm exec --using=22 node --test test/calc.test.mjs`
Expected: 모두 PASS.

- [ ] **Step 5: 패널 HTML·CSS를 넣는다**

`dashboard/index.html`:

CSS — `#apps button.on { border-color: var(--ok); color: var(--ok); }` 를:
```css
  #apps button.on, #ranges button.on { border-color: var(--ok); color: var(--ok); }
  #ranges { font-weight: 400; margin-left: 8px; }
  #routes { max-height: 360px; overflow: auto; }
  #routes table { table-layout: fixed; }
  #routes th { cursor: pointer; user-select: none; }
  #routes th:not(:first-child), #routes td:not(:first-child) { width: 92px; }
```

본문 — `<section class="panel"><h2>최근 에러</h2><div id="errlist">없음</div></section>` 다음 줄:
```html
  <section class="panel"><h2>API별 통계 <span id="ranges"><button data-range="10m">최근 10분</button> <button data-range="all">서버 켠 뒤 전체</button></span></h2><div id="routes">없음</div></section>
```

- [ ] **Step 6: 받기·그리기를 넣는다**

`dashboard/app.mjs`:

import:
```js
import { downSec, nextSort, pickInRect, ROUTE_COLS, routeSort, selfTime, sortRoutes, yMax } from './calc.mjs';
```

상수(`MAX_BANNER` 아래):
```js
const MAX_ROUTE_ROWS = 50;                   // API별 통계 줄 수
const ROUTE_EVERY_MS = 5000;                 // API별 통계 갱신 간격
const ROUTE_HEAD = { key: 'API', count: '횟수', errors: '에러', avg: '평균(ms)', p95: 'p95(ms)', max: '최대(ms)', total: '총 시간(s)' };
```

상태(`const alerts = createAlerts();` 아래):
```js
let routeRange = load('apm.routeRange', '10m') === 'all' ? 'all' : '10m';
let routeOrder = routeSort(load('apm.routeSort', ''));
let routeData = null; // 마지막으로 받은 /routes. 받기에 실패하면 이전 것을 그대로 보인다
```

앱 버튼 `b.onclick` 안 `render();` 다음 줄:
```js
        fetchRoutes();
```

`// ---- 경보 ----` 앞에 새 구역:
```js
// ---- API별 통계 ----

async function fetchRoutes() {
  try {
    const res = await fetch(`/routes?range=${routeRange}`);
    if (res.ok) routeData = await res.json();
  } catch {
    // 수집 서버가 잠시 꺼져 있으면 표는 그대로
  }
  showRoutes();
}

function showRoutes() {
  for (const b of $('ranges').children) b.classList.toggle('on', b.dataset.range === routeRange);
  if (!routeData) return;
  const rows = sortRoutes(routeData.rows.filter(visible), routeOrder);
  if (rows.length === 0) return $('routes').replaceChildren('없음');
  const table = document.createElement('table');
  const head = row('th', ROUTE_COLS.map((c) => ROUTE_HEAD[c] + (c === routeOrder.col ? (routeOrder.desc ? ' ▼' : ' ▲') : '')));
  ROUTE_COLS.forEach((c, i) => {
    head.children[i].onclick = () => {
      routeOrder = nextSort(routeOrder, c);
      save('apm.routeSort', `${routeOrder.col}:${routeOrder.desc ? 'desc' : 'asc'}`);
      showRoutes();
    };
  });
  table.append(head);
  const approx = routeData.range === 'all' ? '≈' : '';
  for (const r of rows.slice(0, MAX_ROUTE_ROWS)) {
    const tr = row('td', [tag(r.agent) + r.key, r.count, r.errors, r.avg, approx + r.p95, r.max, (r.total / 1000).toFixed(1)]);
    tr.className = 'row';
    tr.children[0].className = 'text';
    for (const td of [...tr.children].slice(1)) td.className = 'num';
    if (r.errors > 0) tr.children[2].className = 'num err';
    tr.onclick = () => pickRoute(r);
    table.append(tr);
  }
  if (rows.length > MAX_ROUTE_ROWS) table.append(row('td', [`… 외 ${rows.length - MAX_ROUTE_ROWS}개`]));
  $('routes').replaceChildren(table);
}

// 그 API의 최근 10분 트랜잭션을 "고른 트랜잭션"에
async function pickRoute(r) {
  let list;
  try {
    const res = await fetch(`/routes/txs?agent=${encodeURIComponent(r.agent)}&key=${encodeURIComponent(r.key)}`);
    list = await res.json();
  } catch {
    return;
  }
  if (list.length === 0) return $('picked').replaceChildren(row('td', ['최근 10분 안에 이 API 요청이 없습니다.']));
  showPicked(list);
}

for (const b of $('ranges').children) {
  b.onclick = () => {
    routeRange = b.dataset.range;
    save('apm.routeRange', routeRange);
    fetchRoutes();
  };
}
fetchRoutes();
setInterval(fetchRoutes, ROUTE_EVERY_MS);
```

- [ ] **Step 7: 단위 테스트 전체를 돌린다**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 모두 PASS(`dashboard.test.js`의 innerHTML 검사 포함).

- [ ] **Step 8: Playwright로 화면을 확인한다**

스크래치패드에 `route-check.cjs`를 만들어 실행한다(커밋하지 않음). 7711 포트에 수집 서버를 띄우고, 두 앱의 트랜잭션을 넣고, 긴 키 하나를 섞는다:
```js
const { chromium } = require('C:/Users/jjshs/atelier/node_modules/playwright');
const { createCollector } = require('C:/Users/jjshs/mini-apm/collector/server');
(async () => {
  const c = createCollector();
  await new Promise((r) => c.server.listen(7711, '127.0.0.1', r));
  const now = Date.now();
  const tx = (id, agent, route, elapsed, error = null) =>
    ({ id, name: route.replace('{id}', id), route, start: now - 3000, elapsed, status: error ? 500 : 200, error, spans: [] });
  const long = 'GET /very/' + 'long-segment/'.repeat(20) + '{id}';
  const post = (agent, txs) => fetch('http://127.0.0.1:7711/ingest', { method: 'POST', body: JSON.stringify({ agent, txs, active: [] }) });
  await post('ipfinance', [tx('1', 'ipfinance', 'GET /qna/{id}/list', 900), tx('2', 'ipfinance', 'GET /qna/{id}/list', 100, 'boom'),
    tx('3', 'ipfinance', 'GET /main', 50), tx('4', 'ipfinance', long, 20)]);
  await post('evl', [tx('5', 'evl', 'GET /evl/{id}', 300)]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto('http://127.0.0.1:7711/');
  await page.waitForSelector('#routes tr.row');
  const keys = () => page.$$eval('#routes tr.row td:first-child', (tds) => tds.map((t) => t.textContent));
  console.log('기본(총 시간 큰 순):', await keys());
  await page.click('#routes th:nth-child(2)'); // 횟수
  console.log('횟수 큰 순:', await keys());
  console.log('에러 칸 빨강:', await page.$$eval('#routes td.err', (t) => t.map((x) => x.textContent)));
  console.log('가로 넘침 없음:', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.click('#ranges button[data-range=all]');
  await page.waitForFunction(() => document.querySelector('#routes td:nth-child(5)')?.textContent.startsWith('≈'));
  console.log('전체 기간 p95 ≈:', await page.$eval('#routes td:nth-child(5)', (t) => t.textContent));
  await page.click('#routes tr.row:has-text("/qna/")');
  await page.waitForSelector('#picked tr.row');
  console.log('고른 트랜잭션:', await page.$$eval('#picked tr.row td:nth-child(3)', (t) => t.map((x) => x.textContent)));
  await page.click('#apps button[data-app=evl]');
  await page.waitForFunction(() => document.querySelectorAll('#routes tr.row').length === 1);
  console.log('evl만:', await keys());
  await page.screenshot({ path: process.argv[2] });
  await browser.close();
  c.close();
})();
```
Run: `CHROMIUM_PATH=... fnm exec --using=22 node <스크래치패드>/route-check.cjs <스크래치패드>/routes.png`
Expected:
- 기본: `[ipfinance] GET /qna/{id}/list`가 맨 위(총 1000ms), 그다음 `[evl] GET /evl/{id}`.
- 횟수 큰 순: `/qna/` 줄이 맨 위(2회).
- 에러 칸 빨강: `['1']`.
- 가로 넘침 없음: `true`(긴 키가 줄바꿈된다).
- 전체 기간 p95가 `≈`로 시작.
- 고른 트랜잭션: `['900', '100']`.
- evl만: `['GET /evl/{id}']`(앱을 고르면 `[앱]` 접두어 없음).
스크린샷을 열어 표 모양을 눈으로 확인한다.

- [ ] **Step 9: README를 고친다**

`README.md`의 대응 표에서 `| 앱 버튼 + 최근 에러 + 경보(...) | ... |` 줄 다음에:
```markdown
| API별 통계(`/routes`, Spring 패턴으로 묶기) | 서비스 통계(URL별 호출 수·응답시간) | 총 시간(느림 × 많이 불림) 순으로 보면 서버 시간을 가장 많이 쓰는 곳이 맨 위에 온다 |
```

`### Java 에이전트의 한계`의 `- **요청 정보**: ...` 줄 다음에:
```markdown
- **API별 묶기**: Spring MVC가 고른 매핑 패턴이 실제 경로와 맞을 때만 패턴으로 묶는다. 패턴이 없는 요청(필터가 직접 응답, 정적 파일, 404)과 에러로 `/error`에 넘어간 요청은 주소 그대로 묶인다. "서버 켠 뒤 전체"는 수집 서버 메모리에만 있어 다시 띄우면 0부터이고, p95는 약 10% 오차의 근사다.
```

- [ ] **Step 10: 전체 테스트와 커밋**

Run: `fnm exec --using=22 npm.cmd test`
Expected: 모두 PASS.

```bash
git add dashboard/calc.mjs dashboard/index.html dashboard/app.mjs test/calc.test.mjs README.md
git commit -m "feat(dashboard): per-API stats panel with range toggle, sortable columns and drill-down to transactions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
