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
