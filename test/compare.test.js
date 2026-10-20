const test = require('node:test');
const assert = require('node:assert/strict');
const { attrs, compare } = require('../collector/compare');
const { createStore } = require('../collector/store');

const tx = (id, extra = {}) => ({
  id, name: 'GET /a', start: 1000, elapsed: 10, status: 200, error: null, spans: [], agent: 'ip', ...extra,
});
const vals = (t) => [...attrs(t).values()].map(([a, v]) => `${a}=${v}`);

test('attrs: 요청 기본·누가·어디서, 없으면 (없음), 화면은 경로만', () => {
  assert.deepEqual(vals(tx('1', { route: 'GET /qna/{id}', req: { user: 'kim', ip: '10.0.0.1', referer: 'http://h:8080/qna/list?x=1' } })), [
    '앱=ip', 'API=GET /qna/{id}', '결과=정상', '상태=200', '사용자=kim', 'IP=10.0.0.1', '화면=/qna/list',
  ]);
  // Node 에이전트(req 없음), route 없음, 에러
  assert.deepEqual(vals(tx('2', { error: 'boom', status: 500 })), [
    '앱=ip', 'API=GET /a', '결과=에러', '상태=500', '사용자=(없음)', 'IP=(없음)', '화면=(없음)',
  ]);
  assert.ok(vals(tx('3', { req: { referer: '/relative' } })).includes('화면=(없음)'));
});

test('attrs: 매퍼·외부 호출 호스트·예외 종류는 포함 여부, 같은 값은 한 번', () => {
  const spans = [
    { type: 'mapper', text: 'qna.select' }, { type: 'mapper', text: 'qna.select' },
    { type: 'http', text: 'GET http://pay.local:9000/check?a=1' }, { type: 'http', text: 'GET nope' },
    { type: 'exception', text: 'log', error: 'IllegalStateException: 없음' }, { type: 'sql', text: 'select 1' },
  ];
  const v = vals(tx('1', { spans })).slice(7);
  assert.deepEqual(v, ['매퍼=qna.select', '외부 호출=pay.local:9000', '외부 호출=(알 수 없음)', '예외=IllegalStateException']);
});

test('attrs: 값은 200자, 예외는 80자에서 자른다', () => {
  const v = vals(tx('1', { req: { user: 'u'.repeat(300) }, spans: [{ type: 'exception', text: 't', error: 'E'.repeat(100) }] }));
  assert.ok(v.includes(`사용자=${'u'.repeat(200)}`));
  assert.ok(v.includes(`예외=${'E'.repeat(80)}`));
});

test('compare: 비율·건수, 차이 큰 순, 10%p 미만 제외(경계 10%p는 포함)', () => {
  // 고른 10건: 모두 API /slow, 사용자 kim 3건. 나머지 10건: /slow 1건, kim 2건(차이 정확히 10%p)
  const picked = Array.from({ length: 10 }, (_, i) => tx(`p${i}`, { route: 'GET /slow', req: { user: i < 3 ? 'kim' : 'lee' } }));
  const rest = Array.from({ length: 10 }, (_, i) => tx(`r${i}`, { route: i < 1 ? 'GET /slow' : 'GET /fast', req: { user: i < 2 ? 'kim' : 'lee' } }));
  const res = compare(picked, rest);
  assert.equal(res.picked, 10);
  assert.equal(res.rest, 10);
  assert.deepEqual(res.rows, [
    { attr: 'API', value: 'GET /slow', picked: 10, rest: 1, pickedPct: 100, restPct: 10 },
    { attr: '사용자', value: 'kim', picked: 3, rest: 2, pickedPct: 30, restPct: 20 },
  ]);
});

test('compare: 15줄까지, 한쪽이 0건이면 빈 rows', () => {
  const picked = [tx('p', { spans: Array.from({ length: 20 }, (_, i) => ({ type: 'mapper', text: `m${i}` })) })];
  assert.equal(compare(picked, [tx('r')]).rows.length, 15);
  assert.deepEqual(compare([], [tx('r')]), { picked: 0, rest: 1, rows: [] });
  assert.deepEqual(compare(picked, []), { picked: 1, rest: 0, rows: [] });
});

test('store.compare: 앱 조건, since 이전 제외, 없는·잘못된 id 무시', () => {
  const s = createStore();
  s.ingest('ip', [tx('a', { start: 1000 }), tx('b', { start: 5000 }), tx('old', { start: 0, elapsed: 1 })], [], 6000);
  s.ingest('evl', [tx('e', { start: 5000 })], [], 6000);
  const r = s.compare(['a', 'e', 'nope', 7, null], 100, 'ip');
  assert.equal(r.picked, 1); // a만(e는 다른 앱)
  assert.equal(r.rest, 1);   // b만(old는 since 이전, e는 다른 앱)
  const all = s.compare(['a'], 100, '');
  assert.equal(all.rest, 2); // b, e
  assert.deepEqual(s.compare('not-array', 0, '').picked, 0);
});
