// The spreadsheet view's pure parts (mods/ide-editor/sheet.js): geometry, selection, ####.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../mods/ide-editor/sheet.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export (const|function) /gm, '$1 ');
  return vm.runInNewContext(source + '\n({ colName, prepare, initialView, moveSel, scrollBy, cellContent, fitNumber, shownSheets });',
    { div: () => null, h_flex: () => null, v_flex: () => null, Float64Array });
}

const book = () => ({
  active: 0, styles: [{}],
  sheets: [
    { name: 'Hidden', hidden: true, cells: [], merges: [], colw: {}, rowh: {}, dcw: 64, drh: 20, freeze: [0, 0] },
    {
      name: 'Main', hidden: false, dcw: 64, drh: 20, freeze: [1, 1],
      colw: { 1: 0, 2: 100 }, rowh: { 3: 40 },
      merges: [[5, 0, 6, 2]],
      cells: [[0, 0, 'Head', 0, null, 's'], [2, 3, '42', 0, '=6*7', 'n'], [5, 0, 'merged', 0, null, 's']],
    },
  ],
});

test('column names run A..Z, AA..', () => {
  const { colName } = load();
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(colName), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('geometry: custom and hidden widths, custom heights, past the table', () => {
  const { prepare } = load(), p = prepare(book().sheets[1]);
  assert.equal(p.Co.pos(1), 64); assert.equal(p.Co.pos(2), 64); assert.equal(p.Co.pos(3), 164);
  assert.equal(p.R.pos(4), 20 * 3 + 40);
  assert.equal(p.Co.find(170), 3); assert.equal(p.R.find(79), 3);
  const far = p.R.n + 10;
  assert.equal(p.R.pos(far), p.R.pos(p.R.n) + 10 * 20);
  assert.equal(p.R.find(p.R.pos(far) + 5), far);
});

test('a hidden first sheet: the view opens on the first shown one', () => {
  const { initialView, shownSheets } = load(), b = book();
  assert.equal(initialView(b).sheet, 1);
  assert.deepEqual([...shownSheets(b).map(([s]) => s.name)], ['Main']);
});

test('arrows skip hidden columns and land on a merge\'s top-left cell', () => {
  const { moveSel } = load(), b = book(), view = { sheet: 1, sx: 0, sy: 0, sel: { r: 0, c: 0 } };
  moveSel(view, b, 0, 1, null); assert.deepEqual({ ...view.sel }, { r: 0, c: 2 });
  view.sel = { r: 6, c: 2 }; moveSel(view, b, 0, 1, null); moveSel(view, b, 0, -1, null);
  assert.deepEqual({ ...view.sel }, { r: 5, c: 0 });
});

test('right / down from a merge leave it past its far edge; left / up land back on it', () => {
  const { moveSel } = load(), b = book(), view = { sheet: 1, sx: 0, sy: 0, sel: { r: 5, c: 0 } };
  moveSel(view, b, 0, 1, null); assert.deepEqual({ ...view.sel }, { r: 5, c: 3 });
  moveSel(view, b, 0, -1, null); assert.deepEqual({ ...view.sel }, { r: 5, c: 0 });
  moveSel(view, b, 1, 0, null); assert.deepEqual({ ...view.sel }, { r: 7, c: 0 });
  moveSel(view, b, -1, 0, null); assert.deepEqual({ ...view.sel }, { r: 5, c: 0 });
});

test('moving the selection scrolls it into view, and scrolling stays in bounds', () => {
  const { moveSel, scrollBy } = load(), b = book(), size = { width: 400, height: 300 };
  const view = { sheet: 1, sx: 0, sy: 0, sel: { r: 0, c: 0 } };
  moveSel(view, b, 30, 0, size);
  assert.ok(view.sy > 0);
  scrollBy(view, b, -1e9, -1e9, size); assert.deepEqual([view.sx, view.sy], [0, 0]);
  scrollBy(view, b, 1e9, 1e9, size); assert.ok(view.sy > 0 && view.sy < 1e9);
});

test('the formula bar shows a formula, else the value', () => {
  const { cellContent } = load(), b = book();
  assert.equal(cellContent(b, { sheet: 1, sel: { r: 2, c: 3 } }), '=6*7');
  assert.equal(cellContent(b, { sheet: 1, sel: { r: 0, c: 0 } }), 'Head');
  assert.equal(cellContent(b, { sheet: 1, sel: { r: 9, c: 9 } }), '');
});

test('a number too wide for its cell becomes #####', () => {
  const { fitNumber } = load();
  assert.equal(fitNumber('42', 12, 50), '42');
  assert.match(fitNumber('1,234,567.89', 12, 40), /^#+$/);
});

test('a wrapped row with no height of its own grows to fit its text, as Excel auto-fits it', () => {
  const { prepare } = load();
  const sheet = { cells: [[0, 0, 'word '.repeat(40), 1, null, 's'], [1, 0, 'short', 1, null, 's'], [2, 0, 'x\ny\nz', 1, null, 's']],
    merges: [], colw: { 0: 100 }, rowh: {}, dcw: 64, drh: 20, freeze: [0, 0] };
  const p = prepare(sheet, [{ pt: 11 }, { wrap: true }]);
  assert.ok(p.R.size(0) > 100, `long text row is ${p.R.size(0)}px`);
  assert.equal(p.R.size(1), 20);
  assert.ok(p.R.size(2) >= 3 * 14);
});
