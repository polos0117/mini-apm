const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, p95 } = require('../collector/store');

const tx = (id, start, elapsed, error = null) =>
  ({ id, name: 'GET /a', start, elapsed, status: error ? 500 : 200, error, spans: [] });

test('p95: 정렬 후 ceil(0.95n)-1번째, 비면 0', () => {
  assert.equal(p95([]), 0);
  assert.equal(p95([7]), 7);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => 20 - i)), 19);
});

test('받은 트랜잭션을 id로 찾고 점으로 돌려준다', () => {
  const s = createStore();
  const added = s.ingest('a', [tx('1', 1000, 50), tx('2', 1000, 70, 'boom')], [], 2000);
  assert.deepEqual(added, [
    { id: '1', name: 'GET /a', t: 1050, elapsed: 50, error: false, agent: 'a', msg: null },
    { id: '2', name: 'GET /a', t: 1070, elapsed: 70, error: true, agent: 'a', msg: 'boom' },
  ]);
  assert.equal(s.get('2').error, 'boom');
  assert.equal(s.get('x'), null);
});

test('잘못된 트랜잭션과 중복 id는 버린다', () => {
  const s = createStore();
  const added = s.ingest('a', [tx('1', 0, 5), { id: 2 }, null, tx('1', 0, 9)], [], 0);
  assert.equal(added.length, 1);
  assert.equal(s.get('1').elapsed, 5);
  assert.deepEqual(s.ingest('a', 'not-array', null, 0), []);
});

test('초당 통계는 끝난 시각이 그 1초 안인 것만 센다', () => {
  const s = createStore();
  // 끝난 시각: 1100, 1800, 2100
  s.ingest('a', [tx('1', 1000, 100), tx('2', 1500, 300, 'e'), tx('3', 1900, 200)], [], 0);
  assert.deepEqual(s.stats(1000), { tps: 2, avg: 200, p95: 300, errors: 1 });
  assert.deepEqual(s.stats(3000), { tps: 0, avg: 0, p95: 0, errors: 0 });
});

test('10분 지난 트랜잭션은 정리된다', () => {
  const s = createStore();
  s.ingest('a', [tx('old', 0, 10), tx('new', 500000, 10)], [], 0);
  s.prune(10 * 60 * 1000 + 11); // old 끝 = 10 < 기준 11
  assert.equal(s.get('old'), null);
  assert.ok(s.get('new'));
  assert.deepEqual(s.points(0).map((p) => p.id), ['new']);
});

test('5초간 소식 없는 에이전트의 처리 중 목록은 빠진다', () => {
  const s = createStore();
  s.ingest('a', [], [{ id: 'x', name: 'GET /a', elapsed: 100, lastSpan: null }], 0);
  s.ingest('b', [], [{ id: 'y', name: 'GET /b', elapsed: 900, lastSpan: null }], 4000);
  assert.deepEqual(s.active(5000).map((t) => t.id), ['y', 'x']);
  assert.deepEqual(s.active(6000).map((t) => t.id), ['y']);
});

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
