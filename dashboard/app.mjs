import { pickInRect, yMax } from './calc.mjs';

const WINDOW_MS = 5 * 60 * 1000;            // X-View에 보이는 시간
const PAD = { l: 52, r: 24, t: 8, b: 22 };   // 축 글자 자리
const MAX_ROWS = 200;                        // ponytail: 목록은 200줄까지, 더 필요하면 페이지 나누기
const COLOR = { ok: '#4ea1ff', err: '#ff5c5c', grid: '#2a3440', dim: '#8593a3', drag: '#ffcc4d' };

const points = new Map(); // id → 점 (재연결 때 겹쳐 와도 한 번만)
let drag = null;          // 끌고 있는 사각형(캔버스 좌표)
let scale = null;         // 마지막으로 그린 축: 좌표 ↔ 값 변환

const $ = (id) => document.getElementById(id);
const canvas = $('xview');
const ctx = canvas.getContext('2d');

// ---- 실시간 수신 ----

const es = new EventSource('/stream');
es.onopen = () => ($('status').textContent = '');
es.onerror = () => ($('status').textContent = '(연결 끊김 — 다시 연결하는 중)');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  for (const p of msg.points) points.set(p.id, p);
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, p] of points) if (p.t < cutoff) points.delete(id);
  showStats(msg.stats);
  showActive(msg.active);
  draw();
};
addEventListener('resize', draw);

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

  // 에러 점이 위에 오도록 정상 점을 먼저 그린다
  for (const error of [false, true]) {
    ctx.fillStyle = error ? COLOR.err : COLOR.ok;
    for (const p of points.values()) {
      if (p.error === error) ctx.fillRect(scale.x(p.t) - 1.5, scale.y(p.elapsed) - 1.5, 3, 3);
    }
  }

  if (drag) {
    ctx.strokeStyle = COLOR.drag;
    ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
  }
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
  showPicked(pickInRect([...points.values()], { t0: scale.t(x0), t1: scale.t(x1), e0: scale.ms(y0), e1: scale.ms(y1) }));
  draw();
});

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
}

function showActive(list) {
  if (list.length === 0) return $('active').replaceChildren('없음');
  const table = document.createElement('table');
  for (const a of list) {
    const tr = row('td', [a.name, `${(a.elapsed / 1000).toFixed(1)}초`, a.lastSpan ?? '']);
    if (a.elapsed >= 3000) tr.className = 'err';
    else if (a.elapsed >= 1000) tr.className = 'warn';
    tr.children[1].className = 'num';
    tr.children[2].className = 'text';
    table.append(tr);
  }
  $('active').replaceChildren(table);
}

function showPicked(list) {
  const table = $('picked');
  table.replaceChildren(row('th', ['끝난 시각', '이름', '응답시간(ms)', '상태']));
  for (const p of list.slice(0, MAX_ROWS)) {
    const tr = row('td', [new Date(p.t).toLocaleTimeString(), p.name, Math.round(p.elapsed), p.error ? '에러' : '정상']);
    tr.className = p.error ? 'row err' : 'row';
    tr.children[2].className = 'num';
    tr.onclick = () => showDetail(p.id);
    table.append(tr);
  }
  if (list.length > MAX_ROWS) table.append(row('td', [`… 외 ${list.length - MAX_ROWS}건`]));
}

// ---- 상세 ----

async function showDetail(id) {
  const box = $('detail');
  const res = await fetch(`/tx/${encodeURIComponent(id)}`);
  if (!res.ok) return (box.textContent = '이미 정리된 트랜잭션입니다(10분 경과).');
  const tx = await res.json();
  const total = tx.elapsed || 1;
  const self = Math.max(0, tx.elapsed - tx.spans.reduce((sum, s) => sum + s.elapsed, 0));

  const head = document.createElement('p');
  head.textContent = `${tx.name}   ${Math.round(tx.elapsed)}ms   상태 ${tx.status}${tx.error ? `   — ${tx.error}` : ''}`;
  if (tx.error) head.className = 'err';

  const table = document.createElement('table');
  for (const s of tx.spans) {
    const label = s.error ? `${s.text}  (${s.error})` : s.text;
    table.append(spanRow(s.type === 'sql' ? 'SQL' : '외부', label, s.offset / total, s.elapsed, s.elapsed / total, s.error));
  }
  table.append(spanRow('앱', '앱 자체 처리', null, self, 0, null));
  box.replaceChildren(head, table);
}

// left·width는 전체 대비 비율(0~1). left가 null이면 막대 없이 시간만.
function spanRow(kind, text, left, elapsed, width, error) {
  const tr = row('td', [kind, text]);
  tr.children[1].className = 'text';
  if (error) tr.className = 'err';
  const barCell = document.createElement('td');
  const bar = document.createElement('div');
  bar.className = 'bar';
  if (left !== null) {
    const fill = document.createElement('i');
    fill.style.left = `${left * 100}%`;
    fill.style.width = `${Math.max(0.5, width * 100)}%`;
    if (error) fill.className = 'err';
    bar.append(fill);
  }
  barCell.append(bar);
  const ms = document.createElement('td');
  ms.className = 'num';
  ms.textContent = `${Math.round(elapsed)}ms`;
  tr.append(barCell, ms);
  return tr;
}
