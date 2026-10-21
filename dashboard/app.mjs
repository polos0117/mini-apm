import { createAlerts } from './alerts.mjs';
import {
  downSec, equalize, nextPickSort, nextSort, PICK_COLS, pickInRect, pickSort, pushSeries, ROUTE_COLS, routeSort, selfTime, slowLevel,
  sortPicked, sortRoutes, spanKinds, sparkPoints, yMax,
} from './calc.mjs';

const WINDOW_MS = 5 * 60 * 1000;            // X-View에 보이는 시간
const PAD = { l: 52, r: 24, t: 8, b: 22 };   // 축 글자 자리
const MAX_ROWS = 200;                        // ponytail: 목록은 200줄까지, 더 필요하면 페이지 나누기
const MAX_ERRORS = 50;                       // 최근 에러 패널 줄 수
const MAX_BANNER = 5;                        // 빨간 줄에 보이는 경보 수
const MAX_ROUTE_ROWS = 50;                   // API별 통계 줄 수
const COMPARE_HINT = 'X-View에서 영역을 끌어 고르면 나머지와 비교합니다.';
const ROUTE_EVERY_MS = 5000;                 // API별 통계 갱신 간격
const PICK_HEAD = { t: '끝난 시각', name: '이름', elapsed: '응답시간(ms)', error: '상태' };
const ROUTE_HEAD = { key: 'API', count: '횟수', errors: '에러', avg: '평균(ms)', p95: 'p95(ms)', max: '최대(ms)', total: '총 시간(s)' };
const SHAPES = ['●', '▲', '■', '◆'];         // 앱마다 점 모양(agents 순서로 반복)
const ZERO = { tps: 0, avg: 0, p95: 0, errors: 0 };
const KIND = { method: '메서드', mapper: '매퍼', sql: 'SQL', http: '외부', exception: '예외' }; // 상세의 구간 종류
const TITLE = document.title;
const COLOR = { ok: '#4ea1ff', err: '#ff5c5c', grid: '#2a3440', dim: '#8593a3', drag: '#ffcc4d' };

const points = new Map(); // id → 점 (재연결 때 겹쳐 와도 한 번만)
let drag = null;          // 끌고 있는 사각형(캔버스 좌표)
let scale = null;         // 마지막으로 그린 축: 좌표 ↔ 값 변환
let last = null;          // 마지막으로 받은 메시지(stats, agentStats, agents, active)
let errKey = '';          // 최근 에러 패널에 그린 점 id들. 같으면 다시 만들지 않는다(클릭이 사라지지 않게)
let recent = [];          // 빨간 줄에 보일 경보 문구(최근 MAX_BANNER개)
let compareSeq = 0;      // 무엇이 다른가: 마지막 요청 번호(늦게 온 이전 응답은 버린다)
let unacked = 0;          // 확인 안 한 경보 수
let series = { all: [], byAgent: {} }; // 추이선: 전체·앱별 { sec, tps, avg, p95, errors } 최근 300초

const $ = (id) => document.getElementById(id);
const canvas = $('xview');
const ctx = canvas.getContext('2d');

// 설정은 이 브라우저에만 기억한다. 저장소가 막혀 있으면 기본값으로 동작한다.
function load(key, def) {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 이번 화면에서만 유지
  }
}

let selected = load('apm.app', ''); // '' = 전체
const opts = {
  errors: load('apm.errors', '1') === '1',
  down: load('apm.down', '1') === '1',
  downMs: downSec(load('apm.downSec', '10')) * 1000,
};
const alerts = createAlerts();
let routeRange = load('apm.routeRange', '10m') === 'all' ? 'all' : '10m';
let routeOrder = routeSort(load('apm.routeSort', ''));
let pickOrder = pickSort(load('apm.pickSort', ''));
let pickedList = []; // 고른 트랜잭션 전체(정렬을 바꾸면 다시 그린다)
let routeData = null; // 마지막으로 받은 /routes. 받기에 실패하면 이전 것을 그대로 보인다

const visible = (p) => !selected || p.agent === selected;
const tag = (agent) => (selected ? '' : `[${agent}] `);
const shapeOf = (agent) => SHAPES[Math.max(0, (last?.agents ?? []).findIndex((a) => a.name === agent)) % SHAPES.length];

// ---- 실시간 수신 ----

const es = new EventSource('/stream');
es.onopen = () => {
  $('status').textContent = '';
  alerts.reset(); // 다시 연결되면 첫 메시지는 지난 5분치라 경보 기준선으로만 쓴다
};
es.onerror = () => ($('status').textContent = '(연결 끊김 — 다시 연결하는 중)');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  for (const p of msg.points) points.set(p.id, p);
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, p] of points) if (p.t < cutoff) points.delete(id);
  last = msg;
  track(msg);
  raise(alerts.check(msg, Date.now(), opts));
  render();
};
addEventListener('resize', draw);

function render() {
  if (!last) return;
  showApps();
  showStats(selected ? last.agentStats[selected] ?? ZERO : last.stats);
  showSparks();
  showEqualizer();
  showActive(last.active.filter(visible));
  showErrors();
  draw();
}

// ---- 추이선 ----

// 연결 첫 메시지의 series로 통째로 바꾸고, 매 메시지의 1초 통계를 이어 붙인다
function track(msg) {
  if (msg.series) series = { all: msg.series.all, byAgent: { ...msg.series.byAgent } };
  pushSeries(series.all, { sec: msg.sec, ...msg.stats });
  for (const [name, s] of Object.entries(msg.agentStats)) pushSeries((series.byAgent[name] ??= []), { sec: msg.sec, ...s });
}
function showSparks() {
  const list = selected ? series.byAgent[selected] ?? [] : series.all;
  for (const key of ['tps', 'avg', 'p95', 'errors']) {
    const pts = sparkPoints(list.map((s) => s[key]), 100, 28);
    const svg = $(`spark-${key}`);
    svg.querySelector('polyline').setAttribute('points', pts);
    svg.querySelector('polygon').setAttribute('points', pts && `0,28 ${pts} 100,28`);
  }
}

// ---- 액티브 이퀄라이저 ----

const EQ_MIN = 5; // 막대 전체 높이의 최소 건수(1~2건이 꽉 찬 막대로 보이지 않게)
const EQ_LABELS = ['1초 미만', '1~3초', '3~8초', '8초 이상'];
function showEqualizer() {
  const agents = last.agents.filter((a) => !selected || a.name === selected);
  if (agents.length === 0) return $('eq').replaceChildren('연결된 앱 없음');
  const rows = equalize(last.active, agents.map((a) => a.name));
  const top = Math.max(EQ_MIN, ...rows.map((r) => r.total));
  $('eq').replaceChildren(...rows.map((r, i) => {
    const down = agents[i].ago > opts.downMs; // 앱 버튼의 ●와 같은 기준
    const col = document.createElement('div');
    col.className = down ? 'col down' : 'col';
    const n = document.createElement('b');
    n.textContent = r.total;
    const stack = document.createElement('div');
    stack.className = 'stack';
    r.counts.forEach((c, k) => {
      if (!c) return;
      const seg = document.createElement('i');
      seg.className = `b${k}`;
      seg.style.height = `${(c / top) * 100}%`;
      seg.title = `${EQ_LABELS[k]} ${c}건`;
      stack.append(seg);
    });
    const name = document.createElement('small');
    name.textContent = down ? `${r.name} ●` : r.name;
    name.title = r.name;
    col.append(n, stack, name);
    return col;
  }));
}

// ---- X-View ----

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const now = Date.now();
  let max = 0;
  for (const p of points.values()) max = Math.max(max, p.elapsed);
  const top = yMax(max);
  const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
  scale = {
    x: (t) => PAD.l + ((t - (now - WINDOW_MS)) / WINDOW_MS) * pw,
    y: (ms) => PAD.t + ph - (ms / top) * ph,
    t: (x) => now - WINDOW_MS + ((x - PAD.l) / pw) * WINDOW_MS,
    ms: (y) => ((PAD.t + ph - y) / ph) * top,
  };

  ctx.font = '11px system-ui';
  ctx.strokeStyle = COLOR.grid;
  ctx.fillStyle = COLOR.dim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const ms = (top / 4) * i, y = scale.y(ms);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(w - PAD.r, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(ms)), PAD.l - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let m = 0; m <= 5; m++) ctx.fillText(m ? `-${m}분` : '지금', scale.x(now - m * 60000), h - PAD.b + 4);

  // 에러 점이 위에 오도록 정상 점을 먼저 그린다. 모양은 앱마다 다르다.
  for (const error of [false, true]) {
    ctx.fillStyle = error ? COLOR.err : COLOR.ok;
    for (const p of points.values()) {
      if (p.error === error && visible(p)) mark(shapeOf(p.agent), scale.x(p.t), scale.y(p.elapsed));
    }
  }

  if (drag) {
    ctx.strokeStyle = COLOR.drag;
    ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
  }
}

function mark(shape, x, y) {
  const r = 2.5;
  ctx.beginPath();
  if (shape === '●') ctx.arc(x, y, r, 0, 2 * Math.PI);
  else if (shape === '▲') {
    ctx.moveTo(x, y - r - 0.5);
    ctx.lineTo(x + r + 0.5, y + r);
    ctx.lineTo(x - r - 0.5, y + r);
  } else if (shape === '◆') {
    ctx.moveTo(x, y - r - 1);
    ctx.lineTo(x + r + 1, y);
    ctx.lineTo(x, y + r + 1);
    ctx.lineTo(x - r - 1, y);
  } else ctx.rect(x - r, y - r, 2 * r, 2 * r);
  ctx.fill();
}

const pos = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
// 클릭 한 번(거의 안 끈 경우)이면 주변 4px을 고른다
const widen = (a, b) => (Math.abs(b - a) < 4 ? [a - 4, b + 4] : [a, b]);

canvas.addEventListener('pointerdown', (e) => {
  const p = pos(e);
  drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = pos(e);
  drag.x1 = p.x;
  drag.y1 = p.y;
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (!drag || !scale) return (drag = null);
  const [x0, x1] = widen(drag.x0, drag.x1);
  const [y0, y1] = widen(drag.y0, drag.y1);
  drag = null;
  const list = pickInRect([...points.values()].filter(visible), { t0: scale.t(x0), t1: scale.t(x1), e0: scale.ms(y0), e1: scale.ms(y1) });
  showPicked(list);
  if (list.length) fetchCompare(list);
  else resetCompare();
  draw();
});

// ---- 앱 버튼 ----

// 버튼은 앱 목록이 바뀔 때만 새로 만든다(1초마다 새로 만들면 누르는 중에 사라진다).
function showApps() {
  const box = $('apps');
  const names = ['', ...last.agents.map((a) => a.name)];
  if (box.children.length !== names.length || names.some((n, i) => box.children[i].dataset.app !== n)) {
    box.replaceChildren(...names.map((n) => {
      const b = document.createElement('button');
      b.dataset.app = n;
      b.textContent = n || '전체';
      b.onclick = () => {
        selected = n;
        save('apm.app', n);
        $('picked').replaceChildren();
        resetCompare();
        render();
        fetchRoutes();
      };
      return b;
    }));
  }
  for (const b of box.children) {
    const a = last.agents.find((x) => x.name === b.dataset.app);
    b.classList.toggle('on', b.dataset.app === selected);
    b.classList.toggle('down', Boolean(a && a.ago > opts.downMs));
  }
  $('legend').textContent = selected ? '' : last.agents.map((a) => `${shapeOf(a.name)} ${a.name}`).join('   ');
}

// ---- 최근 에러 ----

function showErrors() {
  const list = [...points.values()].filter((p) => p.error && visible(p)).sort((a, b) => b.t - a.t).slice(0, MAX_ERRORS);
  const key = list.map((p) => p.id).join(' ');
  if (key === errKey) return;
  errKey = key;
  if (list.length === 0) return $('errlist').replaceChildren('없음');
  const table = document.createElement('table');
  for (const p of list) {
    const tr = row('td', [new Date(p.t).toLocaleTimeString(), p.agent, p.name, p.msg ?? '']);
    tr.className = 'row err';
    for (const td of [tr.children[1], tr.children[2], tr.children[3]]) {
      td.className = 'ell';
      td.title = td.textContent;
    }
    tr.onclick = () => showDetail(p.id);
    table.append(tr);
  }
  $('errlist').replaceChildren(table);
}

// ---- API별 통계 ----

async function fetchRoutes() {
  if (document.body.dataset.tab !== 'stats') return; // 통계 탭을 볼 때만 받는다
  try {
    const res = await fetch(`/routes?range=${routeRange}`);
    if (res.ok) routeData = await res.json();
  } catch {
    // 수집 서버가 잠시 꺼져 있으면 표는 그대로
  }
  showRoutes();
}

function showRoutes() {
  for (const b of $('ranges').children) b.classList.toggle('on', b.dataset.range === routeRange);
  if (!routeData) return;
  const rows = sortRoutes(routeData.rows.filter(visible), routeOrder);
  if (rows.length === 0) return $('routes').replaceChildren('없음');
  const table = document.createElement('table');
  const head = row('th', ROUTE_COLS.map((c) => ROUTE_HEAD[c] + (c === routeOrder.col ? (routeOrder.desc ? ' ▼' : ' ▲') : '')));
  ROUTE_COLS.forEach((c, i) => {
    head.children[i].onclick = () => {
      routeOrder = nextSort(routeOrder, c);
      save('apm.routeSort', `${routeOrder.col}:${routeOrder.desc ? 'desc' : 'asc'}`);
      showRoutes();
    };
  });
  table.append(head);
  const approx = routeData.range === 'all' ? '≈' : '';
  for (const r of rows.slice(0, MAX_ROUTE_ROWS)) {
    const tr = row('td', [tag(r.agent) + r.key, r.count, r.errors, r.avg, approx + r.p95, r.max, (r.total / 1000).toFixed(1)]);
    tr.className = 'row';
    tr.children[0].className = 'text';
    for (const td of [...tr.children].slice(1)) td.className = 'num';
    if (r.errors > 0) tr.children[2].className = 'num err';
    for (const [i, ms] of [[3, r.avg], [4, r.p95], [5, r.max]]) tr.children[i].className = `num ${slowLevel(ms)}`;
    tr.onclick = () => pickRoute(r);
    table.append(tr);
  }
  if (rows.length > MAX_ROUTE_ROWS) table.append(row('td', [`… 외 ${rows.length - MAX_ROUTE_ROWS}개`]));
  $('routes').replaceChildren(table);
}

// 그 API의 최근 10분 트랜잭션을 "고른 트랜잭션"에
async function pickRoute(r) {
  resetCompare();
  let list;
  try {
    const res = await fetch(`/routes/txs?agent=${encodeURIComponent(r.agent)}&key=${encodeURIComponent(r.key)}`);
    list = await res.json();
  } catch {
    return;
  }
  if (list.length === 0) return $('picked').replaceChildren(row('td', ['최근 10분 안에 이 API 요청이 없습니다.']));
  showPicked(list);
}

for (const b of $('ranges').children) {
  b.onclick = () => {
    routeRange = b.dataset.range;
    save('apm.routeRange', routeRange);
    fetchRoutes();
  };
}
setInterval(fetchRoutes, ROUTE_EVERY_MS);

// ---- 메뉴 탭 ----

// 주소 끝(#stats)으로 고르므로 새로고침·즐겨찾기에도 같은 탭이 열린다. 고른 트랜잭션·상세는 두 탭이 함께 쓴다.
function showTab() {
  const tab = location.hash === '#stats' ? 'stats' : 'live';
  if (document.body.dataset.tab !== tab) {
    $('picked').replaceChildren(); // 다른 탭에서 고른 목록이 남지 않게
    resetCompare();
  }
  document.body.dataset.tab = tab;
  for (const a of $('tabs').children) a.classList.toggle('on', a.hash === `#${tab}`);
  if (tab === 'stats') fetchRoutes();
  else draw(); // 숨어 있던 X-View는 크기가 0이었다
}
addEventListener('hashchange', showTab);
showTab();

// ---- 경보 ----

function raise(list) {
  if (list.length === 0) return;
  const at = new Date().toLocaleTimeString();
  for (const a of list) {
    recent.push(`${at} ${a.text}`);
    unacked++;
    // 대시보드를 보고 있으면 빨간 줄로 충분하다
    if (window.Notification?.permission === 'granted' && !document.hasFocus()) new Notification('미니 APM', { body: a.text });
  }
  recent = recent.slice(-MAX_BANNER);
  showAlerts();
}

function showAlerts() {
  $('alertbar').hidden = unacked === 0;
  $('alerts').replaceChildren(...[...recent].reverse().map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    li.title = t;
    return li;
  }));
  document.title = unacked ? `(⚠${unacked}) ${TITLE}` : TITLE;
}

$('ack').onclick = () => {
  recent = [];
  unacked = 0;
  showAlerts();
};

// ---- 설정 ----

$('optErrors').checked = opts.errors;
$('optDown').checked = opts.down;
$('optDownSec').value = opts.downMs / 1000;
$('optErrors').onchange = (e) => {
  opts.errors = e.target.checked;
  save('apm.errors', opts.errors ? '1' : '0');
};
$('optDown').onchange = (e) => {
  opts.down = e.target.checked;
  save('apm.down', opts.down ? '1' : '0');
};
$('optDownSec').onchange = (e) => {
  const sec = downSec(e.target.value);
  e.target.value = sec;
  opts.downMs = sec * 1000;
  save('apm.downSec', String(sec));
  render();
};

function showNotify() {
  const b = $('notify');
  if (!('Notification' in window)) return (b.hidden = true);
  const p = Notification.permission;
  b.hidden = false;
  b.disabled = p !== 'default';
  b.textContent = p === 'granted' ? '알림 켜짐' : p === 'denied' ? '알림 차단됨(브라우저 설정)' : '알림 켜기';
}
$('notify').onclick = async () => {
  await Notification.requestPermission();
  showNotify();
};
showNotify();

// ---- 표 ----

function row(tag, cells) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const el = document.createElement(tag);
    el.textContent = c;
    tr.append(el);
  }
  return tr;
}

function showStats(s) {
  for (const key of ['tps', 'avg', 'p95', 'errors']) $(key).textContent = s[key];
  for (const key of ['avg', 'p95']) $(key).className = slowLevel(s[key]) || 'good';
  $('errors').className = s.errors > 0 ? 'err' : 'good';
}

function showActive(list) {
  if (list.length === 0) return $('active').replaceChildren('없음');
  const table = document.createElement('table');
  // 좁은 패널이라 ① 이름·시간 ② 현재 위치 ③ 마지막 호출을 각각 한 줄로. 넘치면 …로 자르고 전체는 툴팁으로.
  for (const a of list) {
    const level = slowLevel(a.elapsed);
    const tr = row('td', [tag(a.agent) + a.name, `${(a.elapsed / 1000).toFixed(1)}초`]);
    tr.className = level;
    tr.children[0].className = 'ell';
    tr.children[0].title = tag(a.agent) + a.name;
    tr.children[1].className = 'num';
    table.append(tr);
    for (const text of [a.where, a.lastSpan]) {
      if (!text) continue;
      const sub = row('td', [text]);
      sub.className = `sub ${level}`;
      sub.firstChild.colSpan = 2;
      sub.firstChild.className = 'ell';
      sub.firstChild.title = text;
      table.append(sub);
    }
  }
  $('active').replaceChildren(table);
}

function showPicked(list) {
  pickedList = list;
  const table = $('picked');
  const head = row('th', PICK_COLS.map((c) => PICK_HEAD[c] + (c === pickOrder.col ? (pickOrder.desc ? ' ▼' : ' ▲') : '')));
  PICK_COLS.forEach((c, i) => {
    head.children[i].onclick = () => {
      pickOrder = nextPickSort(pickOrder, c);
      save('apm.pickSort', `${pickOrder.col}:${pickOrder.desc ? 'desc' : 'asc'}`);
      showPicked(pickedList);
    };
  });
  table.replaceChildren(head);
  for (const p of sortPicked(list, pickOrder).slice(0, MAX_ROWS)) {
    const tr = row('td', [new Date(p.t).toLocaleTimeString(), tag(p.agent) + p.name, Math.round(p.elapsed), p.error ? '에러' : '정상']);
    tr.className = p.error ? 'row err' : 'row';
    tr.children[2].className = `num ${slowLevel(p.elapsed)}`;
    tr.onclick = () => showDetail(p.id);
    table.append(tr);
  }
  if (list.length > MAX_ROWS) table.append(row('td', [`… 외 ${list.length - MAX_ROWS}건`]));
}

// ---- 무엇이 다른가 ----

function resetCompare() {
  compareSeq++;
  $('cmpinfo').textContent = '';
  $('compare').replaceChildren(COMPARE_HINT);
}

// 고른 점과 X-View에 보이는 나머지(같은 앱)를 수집 서버가 비교한다
async function fetchCompare(list) {
  const seq = ++compareSeq;
  $('cmpinfo').textContent = ''; // 이전 선택의 건수가 남지 않게
  $('compare').replaceChildren('비교하는 중…');
  let res;
  try {
    const r = await fetch('/compare', {
      method: 'POST', body: JSON.stringify({ ids: list.map((p) => p.id), since: Date.now() - WINDOW_MS, agent: selected }),
    });
    if (!r.ok) throw new Error(String(r.status));
    res = await r.json();
  } catch {
    if (seq === compareSeq) $('compare').replaceChildren('비교하지 못했습니다(수집 서버 연결 확인).');
    return;
  }
  if (seq === compareSeq) showCompare(res);
}

function showCompare(res) {
  $('cmpinfo').textContent = `고른 ${res.picked}건 vs 나머지 ${res.rest}건`;
  if (res.picked === 0 || res.rest === 0) return $('compare').replaceChildren('비교할 나머지 요청이 없습니다.');
  if (res.rows.length === 0) return $('compare').replaceChildren('뚜렷한 차이가 없습니다.');
  const table = document.createElement('table');
  table.append(row('th', ['속성', '값', '고른 쪽', '나머지']));
  for (const r of res.rows) {
    const tr = row('td', [r.attr, r.value]);
    tr.children[1].className = 'text';
    tr.append(pctCell(r.pickedPct, r.picked, ''), pctCell(r.restPct, r.rest, 'rest'));
    table.append(tr);
  }
  $('compare').replaceChildren(table);
}

// 0~100% 막대 + "85% (17건)"
function pctCell(pct, n, cls) {
  const td = document.createElement('td');
  const box = document.createElement('div');
  box.className = `pct ${cls}`;
  const track = document.createElement('span');
  track.className = 'track';
  const fill = document.createElement('i');
  fill.style.width = `${pct}%`;
  track.append(fill);
  box.append(track, `${pct}% (${n}건)`);
  td.append(box);
  return td;
}

// ---- 상세 ----

async function showDetail(id) {
  const box = $('detail');
  const res = await fetch(`/tx/${encodeURIComponent(id)}`);
  if (!res.ok) return (box.textContent = '이미 정리된 트랜잭션입니다(10분 경과).');
  const tx = await res.json();
  const total = tx.elapsed || 1;
  const self = selfTime(tx.elapsed, tx.spans);

  const head = document.createElement('p');
  head.textContent = `${tx.name}   ${Math.round(tx.elapsed)}ms   상태 ${tx.status}${tx.error ? `   — ${tx.error}` : ''}`;
  if (tx.error) head.className = 'err';
  // 누가 어느 화면에서 무엇을 보냈나(Java 에이전트만). 값이 있는 것만
  const r = tx.req ?? {};
  const info = [['사용자', r.user], ['IP', r.ip], ['화면', r.referer], ['파라미터', r.params]]
    .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('  ·  ');
  const req = document.createElement('p');
  req.className = 'req';
  req.textContent = info;

  // 범례를 누르면 그 종류 구간만(들여쓰기 없이). 같은 것을 다시 누르면 전체. 다른 트랜잭션을 열면 전체부터
  const table = document.createElement('table');
  const legend = document.createElement('p');
  legend.id = 'kinds';
  const kinds = spanKinds(tx.spans);
  let only = null;
  const drawSpans = () => {
    table.replaceChildren();
    for (const s of tx.spans) {
      if (only && s.type !== only) continue;
      const label = s.error ? `${s.text}  (${s.error})` : s.text;
      table.append(spanRow(KIND[s.type] ?? s.type, label, s.offset / total, s.elapsed, s.elapsed / total, s.error,
        only ? 0 : s.depth ?? 0, s.type));
    }
    if (only) return;
    if (tx.droppedSpans) table.append(row('td', ['…', `호출 ${tx.droppedSpans}개 생략(트랜잭션당 1000개까지 기록, 생략분 시간은 아래에 포함)`]));
    table.append(spanRow('앱', '앱 자체 처리', null, self, 0, null, 0, 'self'));
  };
  legend.append(...Object.entries(KIND).map(([t, name]) => {
    const k = kinds[t];
    const b = document.createElement('button');
    b.className = `k-${t}`;
    b.textContent = `■ ${name} ${k?.count ?? 0}건${k?.ms != null ? ` · ${duration(k.ms)}` : ''}`;
    b.disabled = !k;
    b.onclick = () => {
      only = only === t ? null : t;
      for (const x of legend.children) x.classList.toggle('on', x === b && only !== null);
      legend.classList.toggle('filtered', only !== null);
      drawSpans();
    };
    return b;
  }));
  drawSpans();
  box.replaceChildren(...(info ? [head, req, legend, table] : [head, legend, table]));
}

const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}초`);

// left·width는 전체 대비 비율(0~1). left가 null이면 막대 없이 시간만. depth만큼 들여쓰고, 종류(type)마다 색이 다르다.
function spanRow(kind, text, left, elapsed, width, error, depth, type) {
  const tr = row('td', [kind, text]);
  tr.children[0].className = `k-${type}`;
  tr.children[1].className = 'text';
  tr.children[1].style.paddingLeft = `${8 + depth * 16}px`;
  if (error) tr.className = 'err';
  const barCell = document.createElement('td');
  const bar = document.createElement('div');
  bar.className = 'bar';
  if (left !== null) {
    const fill = document.createElement('i');
    fill.style.left = `${left * 100}%`;
    fill.style.width = `${Math.max(0.5, width * 100)}%`;
    fill.className = error ? 'err' : `k-${type}`;
    bar.append(fill);
  }
  barCell.append(bar);
  const ms = document.createElement('td');
  ms.className = 'num';
  ms.textContent = `${Math.round(elapsed)}ms`;
  tr.append(barCell, ms);
  return tr;
}
