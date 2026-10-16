// 수집 서버의 메모리 저장소. HTTP와 무관한 순수 로직만 둔다.
const KEEP_MS = 10 * 60 * 1000; // 트랜잭션 보관 기간
const STALE_MS = 5000;           // 이 시간 동안 소식 없는 에이전트는 처리 중 목록에서 뺀다

const end = (tx) => tx.start + tx.elapsed;
const isTx = (t) =>
  t !== null && typeof t === 'object' && typeof t.id === 'string' &&
  Number.isFinite(t.start) && Number.isFinite(t.elapsed) && Array.isArray(t.spans);
const toPoint = (tx) => ({ id: tx.id, name: tx.name, t: end(tx), elapsed: tx.elapsed, error: Boolean(tx.error) });

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function createStore() {
  // ponytail: 매초 전체를 훑는 O(n) 정리·통계. 10분치 수만 건까지는 충분, 넘치면 초 단위 버킷으로.
  let txs = [];
  const byId = new Map();
  const agents = new Map(); // 에이전트 이름 → { at, active }

  return {
    // 올바른 트랜잭션만 저장하고, 저장한 것의 점 목록을 돌려준다.
    ingest(agent, list, active, now = Date.now()) {
      const added = [];
      for (const tx of Array.isArray(list) ? list : []) {
        if (!isTx(tx) || byId.has(tx.id)) continue;
        txs.push(tx);
        byId.set(tx.id, tx);
        added.push(toPoint(tx));
      }
      agents.set(String(agent), { at: now, active: Array.isArray(active) ? active : [] });
      return added;
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    points(since) {
      return txs.filter((tx) => end(tx) >= since).map(toPoint);
    },
    stats(secStart) {
      const inSec = txs.filter((tx) => end(tx) >= secStart && end(tx) < secStart + 1000);
      const elapsed = inSec.map((tx) => tx.elapsed);
      return {
        tps: inSec.length,
        avg: elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0,
        p95: Math.round(p95(elapsed)),
        errors: inSec.filter((tx) => tx.error).length,
      };
    },
    active(now = Date.now()) {
      const all = [];
      for (const a of agents.values()) if (now - a.at <= STALE_MS) all.push(...a.active);
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
