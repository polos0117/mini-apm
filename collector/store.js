// 수집 서버의 메모리 저장소. HTTP와 무관한 순수 로직만 둔다.
const KEEP_MS = 10 * 60 * 1000; // 트랜잭션 보관 기간
const STALE_MS = 5000;           // 이 시간 동안 소식 없는 에이전트는 처리 중 목록에서 뺀다
const MAX_NAME = 40;             // 에이전트 이름 길이
const MAX_MSG = 200;             // 점에 싣는 에러 메시지 길이
const MAX_ROUTES = 2000;         // 앱마다 API별 누계 키 수. 넘치면 (기타)
const OTHER = '(기타)';
const LOG_STEP = Math.log(1.1);  // 누계 p95용 응답시간 구간(약 10%씩)

const { compare, routeKey } = require('./compare');

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
const bucket = (ms) => (ms < 1 ? 0 : Math.floor(Math.log(ms) / LOG_STEP) + 1); // 구간 i = [1.1^(i-1), 1.1^i)
const sum = (list) => list.reduce((a, tx) => a + tx.elapsed, 0);

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function summarize(list) {
  const elapsed = list.map((tx) => tx.elapsed);
  return {
    tps: list.length,
    avg: elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0,
    p95: Math.round(p95(elapsed)),
    errors: list.filter((tx) => tx.error).length,
  };
}

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

function createStore() {
  // ponytail: 매초 전체를 훑는 O(n) 정리·통계. 10분치 수만 건까지는 충분, 넘치면 초 단위 버킷으로.
  let txs = [];
  const byId = new Map();
  const seen = new Map(); // 에이전트 이름 → { at, active }. 수집 서버가 켜져 있는 동안 빠지지 않는다(끊김 판단용)
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
        addTotal(name, tx);
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
    // 무엇이 다른가: 고른 id(보관 중·같은 앱)와 since 이후에 끝난 나머지(같은 앱)
    compare(ids, since, agent) {
      const mine = (tx) => !agent || tx.agent === agent;
      const want = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
      const picked = [...want].map((id) => byId.get(id)).filter((tx) => tx && mine(tx));
      const chosen = new Set(picked);
      return compare(picked, txs.filter((tx) => mine(tx) && end(tx) >= since && !chosen.has(tx)));
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
    prune(now = Date.now()) {
      const cutoff = now - KEEP_MS;
      const keep = [];
      for (const tx of txs) {
        if (end(tx) >= cutoff) keep.push(tx);
        else byId.delete(tx.id);
      }
      txs = keep;
    },
  };
}

module.exports = { createStore, p95 };
