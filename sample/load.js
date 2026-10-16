// 부하 발생기: node sample/load.js [동시사용자=10]
const BASE = process.env.APP_URL || 'http://localhost:7701';
const USERS = Number(process.argv[2]) || 10;
const MIX = [ // [메서드, 경로, 비중]
  ['GET', '/products', 50],
  ['GET', '/orders', 20],
  ['POST', '/checkout', 20],
  ['GET', '/report', 7],
  ['GET', '/boom', 3],
];
const TOTAL = MIX.reduce((sum, m) => sum + m[2], 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick() {
  let r = Math.random() * TOTAL;
  for (const m of MIX) if ((r -= m[2]) < 0) return m;
  return MIX[0];
}

async function user() {
  for (;;) {
    const [method, path] = pick();
    try {
      await (await fetch(BASE + path, { method })).arrayBuffer();
    } catch {
      await sleep(1000); // 앱이 아직 안 떴거나 꺼짐: 실패는 무시하고 잠시 쉰다
    }
    await sleep(Math.random() * 300);
  }
}

for (let i = 0; i < USERS; i++) user();
console.log(`부하 발생기: 동시 사용자 ${USERS}명 → ${BASE}`);
