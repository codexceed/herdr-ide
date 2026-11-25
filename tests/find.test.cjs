const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../mods/ide-pane/main.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class Pane', 'class Pane');
const { matches, snippet, SHOWN, glow, fade } = vm.runInNewContext(source + '\n({ matches, snippet, SHOWN, glow, fade });', { View: class {} });

test('the header color fades in from faint to about 90% at the right edge, never stepping back', () => {
  const alphas = fade('#3fb5a8').map(c => parseInt(c.slice(7), 16));
  assert.ok(alphas[0] < 8 && alphas.at(-1) >= 0xe0, JSON.stringify(alphas));
  assert.ok(alphas.every((a, i) => i === 0 || a >= alphas[i - 1]));
});

test('a finished agent lights its header blue, one that needs you red, others not at all', () => {
  const t = { done: '#96b2d7', blocked: '#dc8c95', working: '#d8be87' };
  assert.equal(JSON.stringify(glow(t, 'done')), '{"edge":"#96b2d7","tint":"#96b2d72e"}');
  assert.equal(glow(t, 'blocked').edge, '#dc8c95');
  for (const s of ['working', 'idle', null]) assert.equal(glow(t, s), null);
});

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

// A pane header with stubbed Herdr: reads resolve only when the test says so.
function headers() {
  const state = { pane: 'term-a', shared: {}, calls: [], reads: [], clip: null };
  state.panes = [
    { pane: 'term-a', terminal: 't1', tab: 'tab', focused: true },
    { pane: 'term-b', terminal: 't2', tab: 'tab', focused: false },
    { pane: 'ed', terminal: null, mod: 'ide-editor', tab: 'tab', focused: false },
    { pane: 'ed2', terminal: null, mod: 'ide-editor', tab: 'tab', focused: false },
  ];
  const element = new Proxy({}, { get: () => () => element });
  const read = what => new Promise(resolve => state.reads.push({ what, resolve }));
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, image: () => element, h_flex: () => element, Input: { new: () => element },
    InputState: { new: () => { const on = {}; return { on: (e, fn) => { on[e] = fn; }, fire: (e, cx) => on[e](null, cx), focus() {}, v: '', set_value(v) { this.v = v; }, value() { return this.v; } }; } },
    panes: () => state.panes, terminals: () => [], focused: () => null, props: () => ({ pane: state.pane }), run: (command, args) => state.calls.push({ command, args }),
    theme: () => ({}), home: () => '/home/test', notify() {}, nextCommand: () => new Promise(() => {}),
    shared: key => state.shared[key], setShared: (key, value) => { state.shared[key] = value; },
    readTextFile: p => read(p),
  };
  const Pane = vm.runInNewContext(source + '\nPane;', sandbox);
  const cx = { spawn: fn => fn(cx), notify() {}, write_to_clipboard: t => { state.clip = t; } };
  const header = pane => { state.pane = pane; const h = new Pane(); h.init({}, cx); return h; };
  const as = (pane, fn) => { state.pane = pane; return fn(); };
  const settle = () => new Promise(r => setImmediate(r));
  const type = (h, pane, q) => as(pane, () => { h.input.v = q; h.input.fire('change', cx); });
  const group = (pane, active) => ({ open: true, pane, tab: 'tab', active: `:${active}`, tabs: [{ path: '/a.md', on: null }, { path: '/b.md', on: null }] });
  const editor = (active, other = '/b.md') => {
    state.shared['ide-editor.groups'] = { g: group('ed', active), g2: group('ed2', other) };
  };
  return { state, cx, header, as, settle, type, editor };
}

test('find in a terminal opens Herdr\'s own find bar, which jumps to each hit', () => {
  const { state, cx, header, as } = headers();
  const a = header('term-a');
  as('term-a', () => a.open(cx));
  assert.equal(JSON.stringify(state.calls), '[{"command":"terminal.search"}]');
  assert.equal(a.finding, false);
  assert.equal(state.reads.length, 0);
  assert.equal(state.shared['ide-find'], undefined);
});

test('a search in one pane survives opening find in another', async () => {
  const { state, cx, header, as, settle, type, editor } = headers();
  editor('/a.md', '/b.md');
  const a = header('ed'), b = header('ed2');
  as('ed', () => a.open(cx)); state.reads.shift().resolve('one herdr\ntwo'); await settle();
  type(a, 'ed', 'herdr');
  as('ed2', () => b.open(cx)); state.reads.shift().resolve('other'); await settle();
  type(b, 'ed2', 'zzz');
  assert.equal(as('ed', () => a.found().length), 1);
  as('ed', () => a.copy(cx));
  assert.equal(state.clip, 'one herdr');
  assert.equal(state.shared['ide-find'].ed2.query, 'zzz');
});

test('an editor bar searches the file the editor shows now', async () => {
  const { state, cx, header, as, settle, type, editor } = headers();
  editor('/a.md');
  const h = header('ed');
  as('ed', () => h.open(cx));
  assert.equal(state.reads[0].what, '/a.md'); state.reads.shift().resolve('alpha herdr'); await settle();
  type(h, 'ed', 'herdr');
  editor('/b.md'); as('ed', () => h.render(cx));
  assert.equal(state.reads[0].what, '/b.md'); state.reads.shift().resolve('x\nbeta herdr'); await settle();
  assert.equal(state.shared['ide-find'].ed.matches[0].n, 2);
  assert.equal(state.shared['ide-find'].ed.matches[0].parts[0], 'beta ');
});

test('a read that finishes after a newer search is dropped', async () => {
  const { state, cx, header, as, settle, editor } = headers();
  editor('/a.md');
  const h = header('ed');
  as('ed', () => h.open(cx)); const old = state.reads.shift();
  as('ed', () => h.close());
  editor('/b.md'); as('ed', () => h.open(cx));
  state.reads.shift().resolve('from b'); await settle();
  old.resolve('from a'); await settle();
  assert.equal(JSON.stringify(h.lines), '["from b"]');
});

test('a closed bar\'s read does not bring its search back', async () => {
  const { state, cx, header, as, settle, editor } = headers();
  editor('/a.md');
  const a = header('ed');
  as('ed', () => a.open(cx)); const pending = state.reads.shift();
  as('ed', () => a.close());
  pending.resolve('late'); await settle();
  assert.equal(state.shared['ide-find']?.ed, undefined);
  assert.equal(a.lines, null);
});

// Over a rendered Markdown page the bar steps through the editor's hits (its count arrives in
// shared("ide-find.preview")); Enter steps instead of copying, Shift-Enter steps back.
test('over a Markdown preview, Enter and Shift-Enter step through the page\'s hits', async () => {
  const { state, cx, header, as, settle, type, editor } = headers();
  editor('/a.md');
  state.shared['ide-editor.groups'].g.preview = [':/a.md'];
  const h = header('ed');
  as('ed', () => h.open(cx)); state.reads.shift().resolve('**herdr** and herdr'); await settle();
  type(h, 'ed', 'herdr');
  assert.equal(as('ed', () => h.previewCount()), null); // the editor hasn't counted yet
  state.shared['ide-find.preview'] = { ed: { file: ':/a.md', query: 'herdr', count: 3 } };
  const submit = (shift = false) => as('ed', () => {
    h.findBar({}, { pane: 'ed' }); // the bar's key handler notes Shift before the input submits
    h.back = shift; h.input.fire('submit', cx);
  });
  submit(); submit();
  assert.equal(state.shared['ide-find'].ed.at, 2);
  submit(); assert.equal(state.shared['ide-find'].ed.at, 0); // wraps
  submit(true); assert.equal(state.shared['ide-find'].ed.at, 2);
  assert.equal(state.clip, null); // nothing copied
  assert.equal(h.finding, true); // the bar stays open
  // A count for another query or file is ignored.
  state.shared['ide-find.preview'] = { ed: { file: ':/b.md', query: 'herdr', count: 9 } };
  assert.equal(as('ed', () => h.previewCount()), null);
});

test('over the source view, Enter still copies the line', async () => {
  const { state, cx, header, as, settle, type, editor } = headers();
  editor('/a.md');
  const h = header('ed');
  as('ed', () => h.open(cx)); state.reads.shift().resolve('one herdr'); await settle();
  type(h, 'ed', 'herdr');
  as('ed', () => h.input.fire('submit', cx));
  assert.equal(state.clip, 'one herdr');
});

test('Esc on the page itself closes the bar: the editor drops the pane\'s search', async () => {
  const { state, cx, header, as, settle, type, editor } = headers();
  editor('/a.md');
  state.shared['ide-editor.groups'].g.preview = [':/a.md'];
  const h = header('ed');
  as('ed', () => h.open(cx)); state.reads.shift().resolve('herdr'); await settle();
  type(h, 'ed', 'herdr');
  as('ed', () => h.render(cx));
  assert.equal(h.finding, true); // its own search keeps it open
  delete state.shared['ide-find'].ed; // what the editor's Esc does
  as('ed', () => h.render(cx));
  assert.equal(h.finding, false);
  assert.equal(state.calls.at(-1).command, 'pane.focus');
  as('ed', () => h.open(cx)); // reopening works again
  as('ed', () => h.render(cx));
  assert.equal(h.finding, true);
});
