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
