// 가짜 결제 서비스: 50ms~2초 늦게, 5%는 실패로 응답한다.
const http = require('node:http');

const PORT = Number(process.env.PORT) || 7702;

http
  .createServer((req, res) => {
    const delay = 50 + Math.random() * 1950;
    setTimeout(() => res.writeHead(Math.random() < 0.05 ? 500 : 200).end(), delay);
  })
  .listen(PORT, () => console.log(`결제 서비스: http://localhost:${PORT}`));
