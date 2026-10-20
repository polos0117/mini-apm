import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from '../dashboard/alerts.mjs';

const ON = { errors: true, down: true, downMs: 10000 };
const msg = (points = [], agents = []) => ({ points, agents });
const err = (agent, name = 'GET /a', m = 'HTTP 500') => ({ id: Math.random().toString(36), agent, name, error: true, msg: m });
const app = (name, ago) => [{ name, ago }];
const texts = (list) => list.map((a) => a.text);

test('연결 직후 첫 메시지(지난 점)의 에러는 경보하지 않는다', () => {
  const al = createAlerts();
  assert.deepEqual(al.check(msg([err('evl')]), 0, ON), []);
  assert.deepEqual(al.check(msg([err('evl')]), 1000, ON), [
    { kind: 'error', agent: 'evl', text: '[evl] GET /a — HTTP 500' },
  ]);
});

test('같은 앱·같은 이름 에러는 60초에 한 번, 다른 앱·다른 이름·60초 뒤는 다시', () => {
  const al = createAlerts();
  al.check(msg(), 0, ON);
  assert.equal(al.check(msg([err('evl'), err('evl')]), 1000, ON).length, 1);
  assert.equal(al.check(msg([err('evl')]), 30000, ON).length, 0);
  assert.equal(al.check(msg([err('ipfinance')]), 30000, ON).length, 1);
  assert.equal(al.check(msg([err('evl', 'GET /b')]), 30000, ON).length, 1);
  assert.equal(al.check(msg([err('evl')]), 61000, ON).length, 1);
  assert.deepEqual(texts(al.check(msg([{ ...err('evl', 'GET /c'), msg: null }]), 61000, ON)), ['[evl] GET /c']);
  assert.deepEqual(al.check(msg([{ ...err('evl', 'GET /d'), error: false }]), 61000, ON), []);
});

test('기준을 넘으면 끊김 한 번, 돌아오면 다시 연결됨 한 번', () => {
  const al = createAlerts();
  al.check(msg([], app('evl', 500)), 0, ON);
  assert.deepEqual(al.check(msg([], app('evl', 10001)), 1000, ON), [
    { kind: 'down', agent: 'evl', text: '[evl] 끊김 — 10초째 소식 없음' },
  ]);
  assert.deepEqual(al.check(msg([], app('evl', 11001)), 2000, ON), []);
  assert.deepEqual(al.check(msg([], app('evl', 300)), 3000, ON), [
    { kind: 'up', agent: 'evl', text: '[evl] 다시 연결됨' },
  ]);
  assert.deepEqual(al.check(msg([], app('evl', 300)), 4000, ON), []);
});

test('기준선에서 이미 끊긴 앱은 조용하고, 돌아오면 다시 연결됨', () => {
  const al = createAlerts();
  assert.deepEqual(al.check(msg([], app('evl', 60000)), 0, ON), []);
  assert.deepEqual(al.check(msg([], app('evl', 61000)), 1000, ON), []);
  assert.deepEqual(texts(al.check(msg([], app('evl', 100)), 2000, ON)), ['[evl] 다시 연결됨']);
});

test('기준선 뒤 처음 보이는 앱은 끊김 아님으로 시작하고, 이미 오래됐으면 바로 끊김', () => {
  const al = createAlerts();
  al.check(msg(), 0, ON);
  assert.deepEqual(al.check(msg([], app('new', 100)), 1000, ON), []);
  assert.deepEqual(texts(al.check(msg([], app('old', 20000)), 2000, ON)), ['[old] 끊김 — 10초째 소식 없음']);
});

test('꺼 둔 조건은 경보하지 않고, 끊김 상태는 계속 따라간다', () => {
  const al = createAlerts();
  const off = { errors: false, down: false, downMs: 10000 };
  al.check(msg([], app('evl', 0)), 0, off);
  assert.deepEqual(al.check(msg([err('evl')], app('evl', 20000)), 1000, off), []);
  // 끊긴 채로 다시 켜도 '끊김'을 뒤늦게 내지 않는다
  assert.deepEqual(al.check(msg([], app('evl', 21000)), 2000, ON), []);
  assert.deepEqual(texts(al.check(msg([], app('evl', 0)), 3000, ON)), ['[evl] 다시 연결됨']);
});

test('끊김 문구의 초는 기준(downMs)을 반올림한 값', () => {
  const al = createAlerts();
  const opts = { ...ON, downMs: 30000 };
  al.check(msg([], app('evl', 0)), 0, opts);
  assert.deepEqual(texts(al.check(msg([], app('evl', 30001)), 1000, opts)), ['[evl] 끊김 — 30초째 소식 없음']);
});

test('reset() 뒤 첫 메시지는 다시 기준선', () => {
  const al = createAlerts();
  al.check(msg([], app('evl', 0)), 0, ON);
  al.reset();
  assert.deepEqual(al.check(msg([err('evl')], app('evl', 20000)), 1000, ON), []);
  assert.deepEqual(al.check(msg([], app('evl', 21000)), 2000, ON), []);
});
