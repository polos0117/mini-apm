const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('대시보드는 HTML 문자열을 끼워 넣지 않는다(textContent만)', () => {
  for (const file of ['app.mjs', 'alerts.mjs', 'calc.mjs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', file), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  }
});
