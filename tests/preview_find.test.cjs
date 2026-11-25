// Find in the rendered Markdown preview: blocks, shown text, hits and the gaps between blocks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../mods/ide-editor/find.js'), 'utf8')
  .replace(/^export (const|function) /gm, '$1 ');
const { blocks, blockGap, shown, hits } = vm.runInNewContext(source + '\n({ blocks, blockGap, shown, hits });', {});
const md = [
  '# Title', '',
  'Gates are **fixed and versioned** in the [skill](https://x.invalid/independent).',
  'Second line with `release_eligible: true` and snake_case.', '',
  '| A | B |', '|---|---|', '| independent | alpha |', '',
  '- one', '- two', '', '- three', '  continued', '',
  '```py', 'x = "fixed"', '', 'y = 2', '```', '',
  '<!--', '', 'hidden', '-->', '',
  'End.',
].join('\n');
const found = (q, text = md) => [...hits(text, q)].map(([a, b]) => text.slice(a, b));

test('blocks cut at blank lines but never inside fences, comments, lists or indented lines', () => {
  const bs = [...blocks(md)].map(b => b.md.trim().split('\n')[0]);
  assert.deepEqual(bs, ['# Title', 'Gates are **fixed and versioned** in the [skill](https://x.invalid/independent).',
    '| A | B |', '- one', '```py', '<!--', 'End.']);
  for (const b of blocks(md)) assert.equal(md.slice(b.start, b.start + b.md.length), b.md); // offsets hold
  assert.equal(blocks(md + '\n\n[ref]: https://x.invalid\n').length, 1); // reference links keep the page whole
});

test('hits match the shown text and map back to the source', () => {
  assert.deepEqual(found('are fixed'), ['are **fixed']); // across emphasis
  assert.deepEqual(found('FIXED AND'), ['fixed and']); // any case
  assert.deepEqual(found('skill'), ['skill']);
  assert.deepEqual(found('release_eligible'), ['release_eligible']); // code kept as written
  assert.deepEqual(found('snake_case'), ['snake_case']); // intraword _ is not emphasis
  assert.deepEqual(found('independent'), ['independent']); // the cell, not the link target
  assert.deepEqual(found('x.invalid'), []);
  assert.deepEqual(found('A B'), []); // never across table cells
  assert.deepEqual(found('with `release'), []); // the literal backtick isn't shown
  assert.deepEqual(found('y = 2'), ['y = 2']);
  assert.deepEqual(found('   '), []);
});

test('the gap between split blocks matches the unsplit view', () => {
  const near = (a, b) => Math.abs(a - b) < 0.05;
  assert.ok(near(blockGap('Para', 'Para'), 10.5));
  assert.ok(near(blockGap('Para', '## H2'), 14 * 4 / 3 * 1.6)); // the section gap, collapsed
  assert.ok(near(blockGap('## H2', 'Para'), 14 * 4 / 3 * 0.35));
  assert.ok(near(blockGap('## A', '### B'), 14 * 4 / 3 * 0.35 + 14 * 17 / 15 * 0.25));
  assert.ok(near(blockGap('Para', '---'), 14 * 1.6));
  assert.ok(near(blockGap('Title\n=====', 'Para'), 14 * 1.8 * 0.35)); // setext h1
});

test('a fence ends only at a real closer: same mark, at least as long, nothing after', () => {
  const page = '```\n```not-a-closer\n\n**still literal**\n````\n\nafter';
  assert.deepEqual([...blocks(page)].map(b => b.md.trim().split('\n').at(-1)), ['````', 'after']);
  assert.equal(shown(page).text.includes('**still literal**'), true); // kept as code
});

test('autolinks keep their address; HTML tags go', () => {
  const page = 'See <https://example.com>, <a@b.co> and <b>bold</b>.';
  assert.equal(shown(page).text, 'See https://example.com, a@b.co and bold.');
  assert.equal(hits(page, 'example.com').length, 1);
});

test('reference links show their text; definitions show nothing', () => {
  const page = 'Read [the guide][g] today, [g] and [G][].\n\n[g]: https://example.com/hidden "Title"\n\n[not a ref] stays.';
  assert.equal(hits(page, 'hidden').length, 0);
  assert.equal(hits(page, 'guide today').length, 1);
  const [[a, b]] = hits(page, 'the guide');
  assert.equal(page.slice(a, b), 'the guide');
  assert.match(shown(page).text, /\[not a ref\] stays\./);
});

test('an HTML comment may also end with --!>', () => {
  assert.equal([...blocks('<!--\n\nhidden\n--!>\n\nafter')].length, 2);
});
