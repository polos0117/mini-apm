import test from 'node:test';
import assert from 'node:assert/strict';
import { downSec, equalize, hoverIndex, nextSort, panelsOff, nextPickSort, pickSort, pickInRect, pushSeries, routeSort, selfTime, slowLevel, sortPicked, sortRoutes, spanKinds, sparkPoints, yMax } from '../dashboard/calc.mjs';

test('selfTime: 전체 − 맨 바깥(depth 0 또는 없음) 구간 합, 음수면 0', () => {
  const spans = [
    { elapsed: 80, depth: 0 }, // 메서드
    { elapsed: 70, depth: 1 }, // 그 안의 SQL: 두 번 빼면 안 된다
    { elapsed: 5 },            // Node 에이전트 구간(depth 없음)
  ];
  assert.equal(selfTime(100, spans), 15);
  assert.equal(selfTime(50, spans), 0);
  assert.equal(selfTime(10, []), 10);
});

test('downSec: 1~600 정수만, 그 밖이면 10', () => {
  assert.equal(downSec('30'), 30);
  assert.equal(downSec(1), 1);
  assert.equal(downSec('600'), 600);
  for (const v of ['', 'abc', '0', '601', '2.5', null, undefined]) assert.equal(downSec(v), 10);
});

test('pickInRect: 범위 안 점만, 응답시간 긴 순, 거꾸로 끈 사각형도 같다', () => {
  const pts = [
    { id: 'a', t: 10, elapsed: 100 },
    { id: 'b', t: 20, elapsed: 900 },
    { id: 'c', t: 30, elapsed: 500 },
    { id: 'd', t: 20, elapsed: 2000 },
  ];
  assert.deepEqual(pickInRect(pts, { t0: 15, t1: 30, e0: 0, e1: 1000 }).map((p) => p.id), ['b', 'c']);
  assert.deepEqual(pickInRect(pts, { t0: 30, t1: 15, e0: 1000, e1: 0 }).map((p) => p.id), ['b', 'c']);
  assert.deepEqual(pickInRect(pts, { t0: 0, t1: 5, e0: 0, e1: 1 }), []);
});

test('yMax: 1·3·5·10초 단계, 넘으면 1초 단위 올림', () => {
  assert.equal(yMax(0), 1000);
  assert.equal(yMax(1000), 1000);
  assert.equal(yMax(1001), 3000);
  assert.equal(yMax(4200), 5000);
  assert.equal(yMax(10000), 10000);
  assert.equal(yMax(12345), 13000);
});

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

test('slowLevel: 1초 미만 빈 값, 1초 이상 warn, 3초 이상 err', () => {
  assert.equal(slowLevel(0), '');
  assert.equal(slowLevel(999), '');
  assert.equal(slowLevel(1000), 'warn');
  assert.equal(slowLevel(2999), 'warn');
  assert.equal(slowLevel(3000), 'err');
});

test('sortPicked: 열마다 정렬, 같으면 응답시간 긴 순, 원본은 그대로', () => {
  const list = [
    { id: 'a', t: 1, name: '나', elapsed: 100, error: null },
    { id: 'b', t: 3, name: '가', elapsed: 300, error: 'x' },
    { id: 'c', t: 2, name: '나', elapsed: 200, error: null },
  ];
  const ids = (sort) => sortPicked(list, sort).map((p) => p.id).join('');
  assert.equal(ids({ col: 'elapsed', desc: true }), 'bca');
  assert.equal(ids({ col: 'elapsed', desc: false }), 'acb');
  assert.equal(ids({ col: 't', desc: true }), 'bca');
  assert.equal(ids({ col: 'name', desc: false }), 'bca'); // 가 < 나, 나끼리는 응답시간 긴 순
  assert.equal(ids({ col: 'error', desc: true }), 'bca'); // 에러 먼저
  assert.equal(list.map((p) => p.id).join(''), 'abc');
});

test('nextPickSort·pickSort: 이름만 처음 가나다순, 모르는 값이면 응답시간 긴 순', () => {
  assert.deepEqual(nextPickSort({ col: 'elapsed', desc: true }, 'elapsed'), { col: 'elapsed', desc: false });
  assert.deepEqual(nextPickSort({ col: 'elapsed', desc: true }, 'name'), { col: 'name', desc: false });
  assert.deepEqual(nextPickSort({ col: 'elapsed', desc: true }, 't'), { col: 't', desc: true });
  assert.deepEqual(nextPickSort({ col: 'elapsed', desc: true }, 'error'), { col: 'error', desc: true });
  assert.deepEqual(pickSort('t:asc'), { col: 't', desc: false });
  assert.deepEqual(pickSort('zzz'), { col: 'elapsed', desc: true });
  assert.deepEqual(pickSort(null), { col: 'elapsed', desc: true });
});

test('spanKinds: 종류별 건수, 시간 합은 매퍼·SQL·외부만(메서드는 겹쳐서 null)', () => {
  const spans = [
    { type: 'method', elapsed: 900 }, { type: 'method', elapsed: 800 },
    { type: 'mapper', elapsed: 500 }, { type: 'sql', elapsed: 400 }, { type: 'sql', elapsed: 100 },
    { type: 'http', elapsed: 300 }, { type: 'exception', elapsed: 0 },
  ];
  assert.deepEqual(spanKinds(spans), {
    method: { count: 2, ms: null }, mapper: { count: 1, ms: 500 }, sql: { count: 2, ms: 500 },
    http: { count: 1, ms: 300 }, exception: { count: 1, ms: null },
  });
  assert.deepEqual(spanKinds([]), {});
});

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

test('sparkPoints: slots를 주면 값을 오른쪽 끝 칸에 맞춘다(연결 뒤 나타난 앱의 짧은 추이가 5분처럼 늘어나지 않게)', () => {
  assert.equal(sparkPoints([1, 1], 100, 28, 5), '75,0 100,0');
  assert.equal(sparkPoints([0, 5, 10], 100, 28, 3), '0,28 50,14 100,0');
  assert.equal(sparkPoints([5], 100, 28, 300), '100,0');
});

test('hoverIndex: 가로 위치(0~1)를 추이 목록 번호로, 데이터 없는 왼쪽 칸은 -1', () => {
  assert.equal(hoverIndex(1, 300, 300), 299);
  assert.equal(hoverIndex(0, 300, 300), 0);
  assert.equal(hoverIndex(0.5, 300, 300), 150);  // 149.5 반올림
  assert.equal(hoverIndex(1, 3, 300), 2);        // 늦게 붙은 앱: 오른쪽 끝 3칸만 데이터
  assert.equal(hoverIndex(0.5, 3, 300), -1);
  assert.equal(hoverIndex(1.2, 3, 300), 2);      // 범위 밖은 끝으로
  assert.equal(hoverIndex(0.5, 0, 300), -1);
});

test('panelsOff: 저장된 끈 패널 목록에서 아는 이름만, 순서·중복 무시', () => {
  const names = ['tps', 'xview', 'eq'];
  assert.deepEqual([...panelsOff('eq,tps', names)].sort(), ['eq', 'tps']);
  assert.deepEqual([...panelsOff('eq,eq,nope,,constructor', names)], ['eq']);
  assert.deepEqual([...panelsOff('', names)], []);
  assert.deepEqual([...panelsOff(null, names)], []);
});
