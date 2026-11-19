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

test('a copy opened without a group (herdr-app check) saves nothing', () => {
  const { context } = harness();
  const sandbox = { View: class {}, div: () => null, svg: () => null, image: () => null, v_flex: () => null, h_flex: () => null,
    Editor: {}, TextView: {}, EditorState: {}, props: () => ({}), shared: () => undefined,
    setShared: () => { throw new Error('saved'); }, focused: () => null, panes: () => [], run() {}, theme: () => ({}), settings: () => ({}), home: () => '/' };
  const source = fs.readFileSync(path.join(__dirname, '../mods/ide-editor/main.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class EditorGroup', 'class EditorGroup');
  const Group = vm.runInNewContext(source + '\nEditorGroup;', sandbox);
  assert.doesNotThrow(() => new Group().init({}, context));
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


function htmlGroup() {
  const execs = [], writes = [], notes = [];
  let reply = { code: 0, stdout: '700 477\n', stderr: '' };
  const state = { groups: { a: { tabs: [], preview: [], pane: 'pane-a', tab: 'tab' } }, active: 'a' };
  const element = new Proxy({}, { get: () => () => element });
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, image: () => element, v_flex: () => element, h_flex: () => element,
    Editor: { new: () => element }, TextView: {}, EditorState: { new: () => ({ release() {} }) },
    props: () => ({ group: 'a' }), shared: key => key.endsWith('groups') ? state.groups : state.active,
    setShared: (key, value) => { if (key.endsWith('groups')) state.groups = value; else state.active = value; },
    focused: () => ({ pane: 'pane-a', tab: 'tab' }), panes: () => [{ pane: 'pane-a', mod: 'ide-editor', tab: 'tab' }],
    run() {}, theme: () => ({}), settings: () => ({ dark: true }), home: () => '/h', appHome: () => '/app',
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return cmd === 'sh' ? reply : { code: 0, stdout: '', stderr: '' }; },
    writeTextFile: async p => { writes.push(p); return null; },
    notify: n => { notes.push(n); return 'n'; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../mods/ide-editor/main.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class EditorGroup', 'class EditorGroup');
  const Group = vm.runInNewContext(source + '\nEditorGroup;', sandbox);
  const g = new Group();
  let pending = [];
  const cx = { focus_handle: () => ({ focus() {}, is_focused: () => false }), spawn: fn => { pending.push(fn(cx)); }, timer: { every() {} }, notify() {} };
  g.init({}, { ...cx, spawn() {} }); // init's command loop isn't under test
  const settle = async () => { while (pending.length) { const p = pending; pending = []; await Promise.all(p); } };
  return { g, cx, state, execs, writes, notes, settle, reply: r => { reply = r; } };
}

test('cmd-shift-v toggles the preview for HTML files as for markdown, and not for others', () => {
  const { g, cx, state } = htmlGroup();
  for (const [file, on] of [['/x/curve.html', true], ['/x/a.htm', true], ['/x/notes.md', true], ['/x/main.js', false]]) {
    state.groups.a.tabs = [{ path: file, on: null }]; state.groups.a.active = `:${file}`; state.groups.a.preview = [];
    g.command('markdown', cx);
    assert.equal(state.groups.a.preview.includes(`:${file}`), on, file);
  }
});

test('an HTML preview waits for the pane width, then renders once per width step', async () => {
  const { g, cx, execs, settle } = htmlGroup(), tab = { path: '/x/curve.html', on: null };
  assert.equal(g.htmlPage(tab, '<p>hi', cx).state, 'pending');
  assert.equal(execs.length, 0, 'no render before the width is known');
  g.width = 704;
  g.htmlPage(tab, '<p>hi', cx); g.htmlPage(tab, '<p>hi', cx);
  await settle();
  const shots = execs.filter(e => e[0] === 'sh');
  assert.equal(shots.length, 1);
  assert.deepEqual(shots[0].slice(-4), ['/x/curve.html', shots[0].at(-3), '700', 'dark']);
  const p = g.htmlPage(tab, '<p>hi', cx);
  assert.equal(p.state, 'ready'); assert.equal(p.w, 700); assert.equal(p.h, 477);
  g.width = 709; g.htmlPage(tab, '<p>hi', cx); await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 1, 'same 20px step: cached');
});

test('while a new width renders, the last page stands in; one render runs at a time', async () => {
  const { g, cx, execs, settle } = htmlGroup(), tab = { path: '/x/c.html', on: null };
  g.width = 700; g.htmlPage(tab, 'a', cx); await settle();
  const first = g.htmlPage(tab, 'a', cx);
  g.width = 900;
  const during = g.htmlPage(tab, 'a', cx);
  g.width = 1100;
  assert.equal(g.htmlPage(tab, 'a', cx), first, 'stale page shown, scaled by the view');
  assert.equal(during, first);
  await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 2, 'the 1100 request waited for the 900 render');
  g.htmlPage(tab, 'a', cx); await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 3);
});

test('a remote HTML file is copied locally before rendering', async () => {
  const { g, cx, execs, writes, settle } = htmlGroup(), tab = { path: '/home/s/curve.html', on: 'devbox' };
  g.width = 700; g.htmlPage(tab, '<p>remote', cx); await settle();
  assert.equal(writes.length, 1); assert.match(writes[0], /^\/app\/data\/ide-html\/\w+\.html$/);
  assert.equal(execs.find(e => e[0] === 'sh').at(-4), writes[0]);
});

test('a failed render shows Chrome\'s error', async () => {
  const { g, cx, settle, reply } = htmlGroup(), tab = { path: '/x/c.html', on: null };
  reply({ code: 1, stdout: '', stderr: 'HTML preview needs @mermaid-js/mermaid-cli\n' });
  g.width = 700; g.htmlPage(tab, 'x', cx); await settle();
  const p = g.htmlPage(tab, 'x', cx);
  assert.equal(p.state, 'error'); assert.match(p.error, /mermaid-cli/);
});

test('Open in browser opens a local HTML file where it is, with the default browser', async () => {
  const { g, cx, execs, writes, notes, settle } = htmlGroup(), tab = { path: '/x/report#1.html', on: null };
  g.openInBrowser(tab, cx); await settle();
  const open = execs.find(e => e[0] === 'sh');
  assert.match(open[2], /open -b .*com\.apple\.Safari/); assert.match(open[2], /xdg-open/);
  assert.equal(open.at(-1), '/x/report#1.html');
  assert.equal(writes.length, 0); assert.equal(notes.length, 0);
});

test('Open in browser copies a remote file first, and waits until it has been read', async () => {
  const { g, cx, execs, writes, settle } = htmlGroup(), tab = { path: '/home/s/curve.html', on: 'devbox' };
  g.openInBrowser(tab, cx); await settle();
  assert.equal(execs.length, 0, 'nothing read yet: nothing to open');
  g.docs.set('devbox:/home/s/curve.html', { text: '<p>remote' });
  g.openInBrowser(tab, cx); await settle();
  assert.equal(writes.length, 1); assert.match(writes[0], /^\/app\/data\/ide-html\/\w+\.html$/);
  assert.equal(execs.find(e => e[0] === 'sh').at(-1), writes[0]);
});

test('a failed Open in browser posts an error notification', async () => {
  const { g, cx, notes, settle, reply } = htmlGroup();
  reply({ code: 1, stdout: '', stderr: 'LSOpenURLsWithRole() failed\n' });
  g.openInBrowser({ path: '/x/c.html', on: null }, cx); await settle();
  assert.equal(notes.length, 1); assert.equal(notes[0].level, 'error'); assert.match(notes[0].body, /LSOpen/);
});
