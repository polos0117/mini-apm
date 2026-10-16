// npm run demo [-- 동시사용자]: 수집 서버, 결제 서비스, 에이전트 붙인 샘플 앱, 부하 발생기를 함께 띄운다.
const { spawn } = require('node:child_process');

const PROCS = [
  ['수집', ['collector/server.js']],
  ['결제', ['sample/payment.js']],
  ['앱', ['--require', './agent', 'sample/app.js']],
  ['부하', ['sample/load.js', process.argv[2] || '10']],
];

const children = PROCS.map(([tag, args]) => {
  const child = spawn(process.execPath, args, { cwd: __dirname });
  for (const out of [child.stdout, child.stderr]) {
    out.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `[${tag}] `)));
  }
  return child;
});

process.on('SIGINT', () => {
  for (const child of children) child.kill();
  process.exit();
});
console.log('대시보드: http://localhost:7700   (끝내려면 Ctrl+C)');
