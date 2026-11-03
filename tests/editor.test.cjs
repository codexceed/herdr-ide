const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const state = { groups: {}, active: null, group: 'a', focus: 'pane-a', read: 'original', calls: [], panes: ['pane-a', 'pane-b'] };
  const element = new Proxy({}, { get: () => () => element });
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, image: () => element,
    v_flex: () => element, h_flex: () => element,
    Editor: { new: () => element }, TextView: {},
    EditorState: { new: () => ({ released: false, release() { this.released = true; } }) },
    props: () => ({ group: state.group }),
    shared: key => key.endsWith('groups') ? state.groups : state.active,
    setShared: (key, value) => { if (key.endsWith('groups')) state.groups = value; else state.active = value; },
    focused: () => ({ pane: state.focus, tab: 'tab' }),
    panes: () => state.panes.map(pane => ({ pane, mod: 'ide-editor', tab: 'tab' })),
    run: (command, args) => state.calls.push({ command, args }),
    theme: () => ({}), settings: () => ({}), home: () => '/home/test',
    readTextFile: async () => { if (state.read instanceof Error) throw state.read; return state.read; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../mods/ide-editor/main.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class EditorGroup', 'class EditorGroup');
  const { EditorGroup: Group, mermaidError } = vm.runInNewContext(source + '\n({ EditorGroup, mermaidError });', sandbox);
  const context = { focus_handle: () => ({ focus() {}, is_focused: () => false }), spawn() {}, timer: { every() {} }, notify() {} };
  function attach(id) { state.group = id; const g = new Group(); g.init({}, context); return g; }
  function group(id, pane) {
    state.groups[id] = { tabs: [], preview: [], pane, tab: 'tab' };
    return attach(id);
  }
  return { state, group, attach, context, mermaidError };
}

test('restored background groups keep their own pane and split there after Files activation', () => {
  const { state, group, context } = harness();
  const a = group('a', 'pane-a'), b = group('b', 'pane-b');
  a.render(context); b.render(context);
  assert.equal(b.pane, 'pane-b');
  assert.equal(state.groups.b.pane, 'pane-b');
  const tab = { path: '/readme.md', on: null };
  state.groups.b.tabs = [tab]; state.groups.b.active = ':/readme.md'; state.active = 'b';
  b.command('split', context);
  assert.equal(state.calls.at(-1).args.pane, 'pane-b');
});

test('a group without a saved pane waits for its own activation', () => {
  const { state, group, context } = harness();
  const b = group('b');
  b.render(context);
  assert.equal(b.pane, undefined);
  state.focus = 'pane-b'; b.activate(); b.render(context);
  assert.equal(b.pane, 'pane-b');
});

for (const [name, failure] of [['deleted', null], ['binary', 'binary\0data'], ['unreadable', new Error('denied')]]) {
  test(`${name} reload clears source and preview caches, then recovers`, async () => {
    const { state, group } = harness();
    const g = group('a', 'pane-a'), tab = { path: '/readme.md', on: null };
    let pending;
    const cx = { spawn: fn => { pending = fn(cx); }, notify() {} };
    g.load(tab, cx); await pending;
    const d = g.docs.get(':/readme.md'), previous = d.code;
    state.read = failure; g.load(tab, cx); await pending;
    assert.equal(previous.released, true);
    assert.equal(d.text, null); assert.equal(d.code, null);
    assert.ok(d.error); assert.equal(d.loading, false);
    state.read = 'original'; g.load(tab, cx); await pending;
    assert.equal(d.text, 'original'); assert.ok(d.code); assert.equal(d.error, null);
  });
}

test('a split group finds its new pane without focus, so closing its last tab closes it', () => {
  const { state, group, attach, context } = harness();
  const a = group('a', 'pane-a'); a.render(context);
  state.groups.a.open = true;
  state.groups.a.tabs = [{ path: '/readme.md', on: null }]; state.groups.a.active = ':/readme.md'; state.active = 'a';
  a.command('split', context);
  const gid = state.active;
  assert.notEqual(gid, 'a');
  state.panes.push('pane-2'); // pane.split lands after the call returns
  const b = attach(gid);
  b.closeTab(':/readme.md');
  assert.equal(b.pane, undefined, 'two unowned editor panes: no guess');
  state.groups['b-owner'] = { open: true, pane: 'pane-b', tabs: [], tab: 'tab' };
  b.learnPane(); b.edit(g => { g.tabs = [{ path: '/x', on: null }]; g.active = ':/x'; });
  b.closeTab(':/x');
  assert.equal(state.calls.at(-1).command, 'pane.close'); assert.equal(state.calls.at(-1).args.pane, 'pane-2');
});

test('an activated group never claims a pane another open group owns', () => {
  const { state, group, attach, context } = harness();
  const a = group('a', 'pane-a'); a.render(context);
  state.groups.a.open = true;
  state.groups.n = { tabs: [], preview: [], tab: 'tab' };
  const n = attach('n'); n.activate(); n.render(context); // focus is still on pane-a
  assert.equal(n.pane, 'pane-b');
  assert.equal(state.groups.a.pane, 'pane-a');
});

test('the preview only takes the mouse while its pane has focus', () => {
  const { state, group, context } = harness();
  const a = group('a', 'pane-a');
  a.render(context);
  assert.equal(a.here, true);
  const gen = a.gen;
  state.focus = 'pane-b'; a.render(context);
  assert.equal(a.here, false);
  assert.equal(a.gen, gen + 1);
});

test('mermaid errors keep the parse message and drop the stack trace', () => {
  const { mermaidError } = harness();
  const stderr = [
    'Error: Parse error on line 3:',
    "Expecting 'AMP', got 'EOF'",
    'Parser.parse (https://x.invalid/mermaid.mjs:1633:16)',
    '    at async CdpPage.$eval (file:///x/Page.js:462:20)',
  ].join('\n');
  assert.equal(mermaidError(stderr), "Parse error on line 3:\nExpecting 'AMP', got 'EOF'");
  assert.equal(mermaidError(''), '');
});
