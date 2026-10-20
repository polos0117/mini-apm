import test from 'node:test';
import assert from 'node:assert/strict';
import { downSec, nextSort, pickInRect, routeSort, selfTime, sortRoutes, yMax } from '../dashboard/calc.mjs';

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
