const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../mods/ide-pane/main.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class Pane', 'class Pane');
const { matches, snippet, SHOWN } = vm.runInNewContext(source + '\n({ matches, snippet, SHOWN });', { View: class {} });

test('matches ignore case, take the query literally and list newest first', () => {
  const found = matches(['Alpha a.b', 'axb', 'ALPHA A.B two'], ' a.b ');
  assert.equal(JSON.stringify(found.map(m => [m.n, m.at, m.len])), '[[3,6,3],[1,6,3]]');
});

test('an empty query finds nothing', () => {
  assert.equal(matches(['a', 'b'], '   ').length, 0);
});

test('matches stop at the shown limit', () => {
  assert.equal(matches(Array(SHOWN + 50).fill('hit'), 'hit').length, SHOWN);
});

test('a snippet never splits an emoji (half a surrogate pair fails to draw)', () => {
  const [m] = matches(['🟢'.repeat(30) + 'y herdr'], 'herdr');
  const parts = snippet(m);
  for (const part of parts) assert.doesNotThrow(() => encodeURIComponent(part), part);
  assert.equal(parts[1], 'herdr');
});
