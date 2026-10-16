const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('대시보드는 HTML 문자열을 끼워 넣지 않는다(textContent만)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app.mjs'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
