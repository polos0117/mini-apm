// 미니 APM 에이전트. `node --require ./agent app.js`로 앱보다 먼저 로드된다.
// JENNIFER가 -javaagent로 바이트코드를 바꾸듯, 여기서는 Node 내장 함수를 감싸서 계측한다.
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const COLLECTOR = process.env.APM_COLLECTOR || 'http://localhost:7700';
const AGENT = process.env.APM_AGENT || 'sample';
const INTERVAL = Number(process.env.APM_INTERVAL) || 1000;
const MAX_BUFFER = 5000;

const als = new AsyncLocalStorage(); // 비동기 흐름을 따라 '지금 어느 트랜잭션인가'를 들고 다닌다
const open = new Map();              // 처리 중인 트랜잭션
let done = [];                       // 전송 대기
const rawFetch = globalThis.fetch;   // 전송용: 자기 자신은 계측하지 않는다
const round = (ms) => Math.round(ms * 10) / 10;

// 에이전트 자신의 오류가 앱으로 번지지 않게 한다.
function safe(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[apm]', err.message);
  }
}

// ---- 트랜잭션 ----

function begin(req) {
  const tx = {
    id: randomUUID(),
    name: `${req.method} ${req.url.split('?')[0]}`,
    start: Date.now(),
    t0: performance.now(),
    status: 0,
    error: null,
    spans: [],
  };
  open.set(tx.id, tx);
  return tx;
}

function finish(tx, status) {
  if (!open.delete(tx.id)) return; // finish와 close 중 먼저 온 쪽만
  const { t0, ...rec } = tx;
  rec.elapsed = round(performance.now() - t0);
  rec.status = status;
  if (status >= 500) rec.error = tx.spans.findLast((s) => s.error)?.error ?? `HTTP ${status}`;
  done.push(rec);
  if (done.length > MAX_BUFFER) done.splice(0, done.length - MAX_BUFFER);
}

const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res) {
  if (event !== 'request') return origEmit.apply(this, arguments);
  let tx = null;
  safe(() => {
    tx = begin(req);
    const end = () => safe(() => finish(tx, res.statusCode));
    res.once('finish', end);
    res.once('close', end);
  });
  return tx ? als.run(tx, () => origEmit.apply(this, arguments)) : origEmit.apply(this, arguments);
};

// ---- span: 트랜잭션 안에서 일어난 SQL·외부 호출 ----

// fn을 실행하며 시간을 잰다. 반환값·예외는 그대로 돌려준다.
// failOf(결과)는 정상 반환이지만 실패로 볼 결과의 메시지를 돌려준다(fetch의 500 응답).
function span(type, text, fn, failOf = () => null) {
  const tx = als.getStore();
  if (!tx || !open.has(tx.id)) return fn();
  const s = { type, text: String(text), offset: round(performance.now() - tx.t0), elapsed: 0, error: null };
  tx.spans.push(s);
  const t = performance.now();
  const stop = (err) => {
    s.elapsed = round(performance.now() - t);
    if (err) s.error = err;
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    stop(err.message);
    throw err;
  }
  if (out instanceof Promise) {
    return out.then(
      (v) => (stop(failOf(v)), v),
      (err) => {
        stop(err.message);
        throw err;
      },
    );
  }
  stop(failOf(out));
  return out;
}

// SQL: 문장 객체(StatementSync)의 프로토타입은 처음 prepare한 결과에서 얻는다.
const origPrepare = DatabaseSync.prototype.prepare;
let statementPatched = false;
DatabaseSync.prototype.prepare = function () {
  const stmt = origPrepare.apply(this, arguments);
  if (!statementPatched) {
    statementPatched = true;
    safe(() => patchStatement(Object.getPrototypeOf(stmt)));
  }
  return stmt;
};

function patchStatement(proto) {
  for (const name of ['run', 'get', 'all']) {
    const orig = proto[name];
    proto[name] = function () {
      return span('sql', this.sourceSQL, () => orig.apply(this, arguments));
    };
  }
}

const origExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  return span('sql', sql, () => origExec.apply(this, arguments));
};

// 나가는 호출
globalThis.fetch = function (input, init) {
  const method = (init?.method || input?.method || 'GET').toUpperCase();
  const url = input?.url ?? String(input);
  return span('http', `${method} ${url}`, () => rawFetch(input, init), (r) => (r.status >= 500 ? `HTTP ${r.status}` : null));
};

// ---- 전송 ----

function activeList() {
  const now = performance.now();
  return [...open.values()].map((tx) => ({
    id: tx.id,
    name: tx.name,
    elapsed: round(now - tx.t0),
    lastSpan: tx.spans.at(-1)?.text ?? null,
  }));
}

function flush() {
  safe(() => {
    const txs = done;
    done = [];
    rawFetch(`${COLLECTOR}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: AGENT, txs, active: activeList() }),
    }).catch(() => {}); // 수집 서버가 없으면 이 묶음은 버린다
  });
}

setInterval(flush, INTERVAL).unref();
