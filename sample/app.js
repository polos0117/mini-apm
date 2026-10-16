// 감시 대상 샘플 앱. 일부러 느린 SQL, 느린 외부 호출, 무거운 계산, 예외를 넣었다.
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 7701;
const PAY_URL = process.env.PAY_URL || 'http://localhost:7702/pay';
const USERS = 2000;   // 사용자 수. 줄이면 /orders가 느려지고, 늘리면 빨라진다
const ORDERS = 100000;

const rand = (n) => Math.floor(Math.random() * n) + 1;
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// user_id에는 일부러 인덱스를 만들지 않는다
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price INTEGER);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, item TEXT, amount INTEGER, created_at INTEGER);
`);
const addProduct = db.prepare('INSERT INTO products (name, price) VALUES (?, ?)');
for (let i = 1; i <= 50; i++) addProduct.run(`상품 ${i}`, i * 1000);
const addOrder = db.prepare('INSERT INTO orders (user_id, item, amount, created_at) VALUES (?, ?, ?, ?)');
db.exec('BEGIN');
for (let i = 0; i < ORDERS; i++) addOrder.run(rand(USERS), `상품 ${rand(50)}`, rand(100) * 1000, Date.now());
db.exec('COMMIT');

const routes = {
  'GET /products': (req, res) => json(res, 200, db.prepare('SELECT * FROM products').all()),

  // 비효율 쿼리: 행마다 그 사용자의 주문 수를 처음부터 다시 센다
  'GET /orders': (req, res, url) => {
    const user = Number(url.searchParams.get('user')) || rand(USERS);
    const sql = `SELECT o.*, (SELECT count(*) FROM orders x WHERE x.user_id = o.user_id) AS total
                 FROM orders o WHERE o.user_id = ?`;
    json(res, 200, db.prepare(sql).all(user));
  },

  'POST /checkout': async (req, res) => {
    db.prepare('INSERT INTO orders (user_id, item, amount, created_at) VALUES (?, ?, ?, ?)')
      .run(rand(USERS), `상품 ${rand(50)}`, rand(100) * 1000, Date.now());
    const pay = await fetch(PAY_URL, { method: 'POST' });
    json(res, pay.ok ? 200 : 502, { paid: pay.ok });
  },

  // 앱 자체 처리가 무거운 경우
  'GET /report': (req, res) => {
    const n = 1e8 * (0.5 + Math.random());
    let x = 0;
    for (let i = 0; i < n; i++) x += Math.sqrt(i);
    json(res, 200, { x });
  },

  'GET /boom': () => {
    throw new Error('일부러 낸 예외');
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (!route) return json(res, 404, { error: 'not found' });
      await route(req, res, url);
    } catch (err) {
      json(res, 500, { error: err.message }); // 에이전트는 이 500으로 에러를 안다
    }
  })
  .listen(PORT, () => console.log(`샘플 앱: http://localhost:${PORT}`));
