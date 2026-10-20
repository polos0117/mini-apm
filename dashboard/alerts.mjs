// 경보 판단. 브라우저 API를 쓰지 않는 순수 로직이라 테스트가 그대로 부른다.
const REPEAT_MS = 60 * 1000; // 같은 앱·같은 이름의 에러 경보는 1분에 한 번

export function createAlerts() {
  let baseline = true;         // 연결 직후 첫 메시지: 상태만 기억하고 경보하지 않는다
  const lastError = new Map(); // `${agent} ${name}` → 마지막 에러 경보 시각
  const down = new Set();      // 끊김으로 기억한 앱

  return {
    reset() {
      baseline = true;
    },
    // opts = { errors, down, downMs }. 꺼 둔 조건도 끊김 상태는 계속 따라간다(다시 켰을 때 엉뚱한 경보가 없게).
    check(msg, now, opts) {
      const out = [];
      for (const a of msg.agents) {
        const isDown = a.ago > opts.downMs;
        if (isDown === down.has(a.name)) continue;
        if (isDown) down.add(a.name);
        else down.delete(a.name);
        if (baseline || !opts.down) continue;
        out.push(isDown
          ? { kind: 'down', agent: a.name, text: `[${a.name}] 끊김 — ${Math.round(opts.downMs / 1000)}초째 소식 없음` }
          : { kind: 'up', agent: a.name, text: `[${a.name}] 다시 연결됨` });
      }
      if (!baseline && opts.errors) {
        for (const p of msg.points) {
          if (!p.error) continue;
          const key = `${p.agent} ${p.name}`;
          if (now - (lastError.get(key) ?? -Infinity) < REPEAT_MS) continue;
          lastError.set(key, now);
          out.push({ kind: 'error', agent: p.agent, text: `[${p.agent}] ${p.name}${p.msg ? ` — ${p.msg}` : ''}` });
        }
      }
      baseline = false;
      return out;
    },
  };
}
