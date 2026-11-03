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

// A pane header with stubbed Herdr: reads resolve only when the test says so.
function headers() {
  const state = { pane: 'term-a', shared: {}, calls: [], reads: [], clip: null };
  state.panes = [
    { pane: 'term-a', terminal: 't1', tab: 'tab', focused: true },
    { pane: 'term-b', terminal: 't2', tab: 'tab', focused: false },
    { pane: 'ed', terminal: null, mod: 'ide-editor', tab: 'tab', focused: false },
  ];
  const element = new Proxy({}, { get: () => () => element });
  const read = what => new Promise(resolve => state.reads.push({ what, resolve }));
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, image: () => element, h_flex: () => element, Input: { new: () => element },
    InputState: { new: () => { const on = {}; return { on: (e, fn) => { on[e] = fn; }, fire: (e, cx) => on[e](null, cx), focus() {}, v: '', set_value(v) { this.v = v; }, value() { return this.v; } }; } },
    panes: () => state.panes, props: () => ({ pane: state.pane }), run: (command, args) => state.calls.push({ command, args }),
    theme: () => ({}), home: () => '/home/test', notify() {}, nextCommand: () => new Promise(() => {}),
    shared: key => state.shared[key], setShared: (key, value) => { state.shared[key] = value; },
    hc: args => read(args[1]).then(stdout => ({ code: 0, stdout, stderr: '' })),
    readTextFile: p => read(p),
  };
  const Pane = vm.runInNewContext(source + '\nPane;', sandbox);
  const cx = { spawn: fn => fn(cx), notify() {}, write_to_clipboard: t => { state.clip = t; } };
  const header = pane => { state.pane = pane; const h = new Pane(); h.init({}, cx); return h; };
  const as = (pane, fn) => { state.pane = pane; return fn(); };
  const settle = () => new Promise(r => setImmediate(r));
  const type = (h, pane, q) => as(pane, () => { h.input.v = q; h.input.fire('change', cx); });
  const editor = active => {
    state.shared['ide-editor.groups'] = { g: { open: true, pane: 'ed', tab: 'tab', active: `:${active}`, tabs: [{ path: '/a.md', on: null }, { path: '/b.md', on: null }] } };
  };
  return { state, cx, header, as, settle, type, editor };
}

test('a search in one pane survives opening find in another', async () => {
  const { state, cx, header, as, settle, type } = headers();
  const a = header('term-a'), b = header('term-b');
  as('term-a', () => a.open(cx)); state.reads.shift().resolve('one herdr\ntwo'); await settle();
  type(a, 'term-a', 'herdr');
  as('term-b', () => b.open(cx)); state.reads.shift().resolve('other'); await settle();
  type(b, 'term-b', 'zzz');
  assert.equal(as('term-a', () => a.found().length), 1);
  as('term-a', () => a.copy(cx));
  assert.equal(state.clip, 'one herdr');
  assert.equal(state.shared['ide-find']['term-b'].query, 'zzz');
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
  const { state, cx, header, as, settle } = headers();
  const a = header('term-a');
  as('term-a', () => a.open(cx)); const pending = state.reads.shift();
  as('term-a', () => a.close());
  pending.resolve('late'); await settle();
  assert.equal(state.shared['ide-find']?.['term-a'], undefined);
  assert.equal(a.lines, null);
});
