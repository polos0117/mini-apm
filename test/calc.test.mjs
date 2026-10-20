import test from 'node:test';
import assert from 'node:assert/strict';
import { downSec, pickInRect, selfTime, yMax } from '../dashboard/calc.mjs';

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
