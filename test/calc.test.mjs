import test from 'node:test';
import assert from 'node:assert/strict';
import { pickInRect, yMax } from '../dashboard/calc.mjs';

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
