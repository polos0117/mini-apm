// 대시보드 계산 함수. 브라우저(app.mjs)와 테스트가 함께 쓴다.

// rect = { t0, t1: 끝난 시각 범위, e0, e1: 응답시간 범위 }. 끄는 방향은 상관없다.
export function pickInRect(points, rect) {
  const t0 = Math.min(rect.t0, rect.t1), t1 = Math.max(rect.t0, rect.t1);
  const e0 = Math.min(rect.e0, rect.e1), e1 = Math.max(rect.e0, rect.e1);
  return points
    .filter((p) => p.t >= t0 && p.t <= t1 && p.elapsed >= e0 && p.elapsed <= e1)
    .sort((a, b) => b.elapsed - a.elapsed);
}

const STEPS = [1000, 3000, 5000, 10000];

// 세로축 최댓값(ms)
export function yMax(maxElapsed) {
  return STEPS.find((s) => s >= maxElapsed) ?? Math.ceil(maxElapsed / 1000) * 1000;
}

// 앱 자체 처리 시간: 전체 − 맨 바깥 구간들(depth 0 또는 없음). 안쪽 구간은 바깥 구간 시간에 이미 들어 있다.
export function selfTime(elapsed, spans) {
  return Math.max(0, elapsed - spans.filter((s) => !s.depth).reduce((sum, s) => sum + s.elapsed, 0));
}

// 끊김 기준(초): 1~600 정수만, 그 밖이면 10
export function downSec(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 600 ? n : 10;
}

// API별 통계의 열(표 왼쪽부터). key = API 이름, 나머지는 숫자
export const ROUTE_COLS = ['key', 'count', 'errors', 'avg', 'p95', 'max', 'total'];
const byKey = (a, b) => a.key.localeCompare(b.key, 'ko');

// sort = { col, desc }. 같은 값이면 API 이름 순
export function sortRoutes(rows, sort) {
  const dir = sort.desc ? -1 : 1;
  const cmp = sort.col === 'key' ? byKey : (a, b) => a[sort.col] - b[sort.col];
  return [...rows].sort((a, b) => dir * cmp(a, b) || byKey(a, b));
}

// 머리글을 눌렀을 때: 같은 열이면 방향을 뒤집고, 새 열은 숫자면 큰 순·API면 가나다순
export function nextSort(sort, col) {
  return sort.col === col ? { col, desc: !sort.desc } : { col, desc: col !== 'key' };
}

// localStorage의 "열:방향". 모르는 열이면 총 시간 큰 순
export function routeSort(saved) {
  const [col, dir] = String(saved).split(':');
  return ROUTE_COLS.includes(col) ? { col, desc: dir !== 'asc' } : { col: 'total', desc: true };
}

// 느린 정도: 처리 중 목록·타일·표가 같은 기준(1초 노랑, 3초 빨강)을 쓴다
export const slowLevel = (ms) => (ms >= 3000 ? 'err' : ms >= 1000 ? 'warn' : '');

// 고른 트랜잭션의 열(표 왼쪽부터): 끝난 시각, 이름, 응답시간, 상태(에러 여부)
export const PICK_COLS = ['t', 'name', 'elapsed', 'error'];
const PICK_CMP = {
  t: (a, b) => a.t - b.t,
  name: (a, b) => a.name.localeCompare(b.name, 'ko'),
  elapsed: (a, b) => a.elapsed - b.elapsed,
  error: (a, b) => Boolean(a.error) - Boolean(b.error),
};

// sort = { col, desc }. 같은 값이면 응답시간 긴 순
export function sortPicked(list, sort) {
  const dir = sort.desc ? -1 : 1;
  return [...list].sort((a, b) => dir * PICK_CMP[sort.col](a, b) || b.elapsed - a.elapsed);
}

// 같은 열이면 방향을 뒤집고, 새 열은 이름만 가나다순·나머지는 큰 순(최근·긴·에러 먼저)
export function nextPickSort(sort, col) {
  return sort.col === col ? { col, desc: !sort.desc } : { col, desc: col !== 'name' };
}

// localStorage의 "열:방향". 모르는 열이면 응답시간 긴 순
export function pickSort(saved) {
  const [col, dir] = String(saved).split(':');
  return PICK_COLS.includes(col) ? { col, desc: dir !== 'asc' } : { col: 'elapsed', desc: true };
}
