// "무엇이 다른가": 고른 트랜잭션과 나머지를 속성 값별 비율로 비교한다. HTTP와 무관한 순수 로직.
const MAX_ROWS = 15;
const MIN_DIFF = 0.1 - 1e-9; // 10%p 미만은 뺀다(정확히 10%p가 부동소수 오차로 빠지지 않게)
const MAX_VALUE = 200;
const MAX_EXCEPTION = 80;
const NONE = '(없음)';

const cut = (v) => String(v).slice(0, MAX_VALUE);
const or = (v) => (v === null || v === undefined || v === '' ? NONE : cut(v));

// API별 통계와 같은 묶음 키
const routeKey = (tx) => (typeof tx.route === 'string' && tx.route ? tx.route : String(tx.name));

function pathOf(referer) {
  try {
    return cut(new URL(referer).pathname); // 호스트·? 뒤는 뺀다
  } catch {
    return NONE;
  }
}

function hostOf(text) {
  try {
    return cut(new URL(String(text).split(' ')[1]).host); // "GET http://host:port/..."
  } catch {
    return '(알 수 없음)';
  }
}

// 트랜잭션 하나의 속성 값들. 키 "속성\t값"으로 같은 값은 한 번만
function attrs(tx) {
  const req = tx.req && typeof tx.req === 'object' ? tx.req : {};
  const list = [
    ['앱', or(tx.agent)], ['API', cut(routeKey(tx))], ['결과', tx.error ? '에러' : '정상'], ['상태', or(tx.status)],
    ['사용자', or(req.user)], ['IP', or(req.ip)], ['화면', req.referer ? pathOf(req.referer) : NONE],
  ];
  for (const s of Array.isArray(tx.spans) ? tx.spans : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'mapper') list.push(['매퍼', cut(s.text)]);
    else if (s.type === 'http') list.push(['외부 호출', hostOf(s.text)]);
    else if (s.type === 'exception' && s.error) list.push(['예외', String(s.error).split(': ')[0].slice(0, MAX_EXCEPTION)]);
  }
  return new Map(list.map(([a, v]) => [`${a}\t${v}`, [a, v]]));
}

// 값마다 고른 쪽·나머지에서 그 값을 가진 요청 비율. 고른 쪽에 많은 순
function compare(picked, rest) {
  const out = { picked: picked.length, rest: rest.length, rows: [] };
  if (picked.length === 0 || rest.length === 0) return out;
  const counts = new Map();
  for (const [side, list] of [['picked', picked], ['rest', rest]]) {
    for (const tx of list) {
      for (const [key, [attr, value]] of attrs(tx)) {
        let c = counts.get(key);
        if (!c) counts.set(key, (c = { attr, value, picked: 0, rest: 0 }));
        c[side]++;
      }
    }
  }
  const rows = [];
  for (const c of counts.values()) {
    const diff = c.picked / picked.length - c.rest / rest.length;
    if (diff >= MIN_DIFF) rows.push({ c, diff });
  }
  rows.sort((a, b) => b.diff - a.diff || b.c.picked - a.c.picked);
  out.rows = rows.slice(0, MAX_ROWS).map(({ c }) => ({
    ...c, pickedPct: Math.round((100 * c.picked) / picked.length), restPct: Math.round((100 * c.rest) / rest.length),
  }));
  return out;
}

module.exports = { attrs, compare, routeKey };
