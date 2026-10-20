// 수집 서버의 메모리 저장소. HTTP와 무관한 순수 로직만 둔다.
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

function createStore() {
  // ponytail: 매초 전체를 훑는 O(n) 정리·통계. 10분치 수만 건까지는 충분, 넘치면 초 단위 버킷으로.
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
