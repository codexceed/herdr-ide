const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// main.js imports sheet.js; the harness strips imports, so sheet.js is inlined ahead of it.
const SHEET = fs.readFileSync(path.join(__dirname, '../mods/ide-editor/sheet.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export (const|function) /gm, '$1 ');

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
  const source = SHEET + fs.readFileSync(path.join(__dirname, '../mods/ide-editor/main.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class EditorGroup', 'class EditorGroup');
  const { EditorGroup: Group, mermaidError, parts, imagePath, IMG } = vm.runInNewContext(source + '\n({ EditorGroup, mermaidError, parts, imagePath, IMG });', sandbox);
  const context = { focus_handle: () => ({ focus() {}, is_focused: () => false }), spawn() {}, timer: { every() {} }, notify() {} };
  function attach(id) { state.group = id; const g = new Group(); g.init({}, context); return g; }
  function group(id, pane) {
    state.groups[id] = { tabs: [], preview: [], pane, tab: 'tab' };
    return attach(id);
  }
  return { state, group, attach, context, mermaidError, parts, imagePath, IMG };
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
  const source = SHEET + fs.readFileSync(path.join(__dirname, '../mods/ide-editor/main.js'), 'utf8')
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
    writeTextFile: async (p, text) => { writes.push(p); if (state.disk && p in state.disk) throw new Error('exists'); if (state.full) throw new Error('No space left on device'); return null; },
    readTextFile: async p => state.disk?.[p] ?? null,
    notify: n => { notes.push(n); return 'n'; },
  };
  const source = SHEET + fs.readFileSync(path.join(__dirname, '../mods/ide-editor/main.js'), 'utf8')
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

test('a remote copy that already holds the text is reused; a failed copy is reported, not opened', async () => {
  const { g, cx, state, execs, notes, settle } = htmlGroup(), tab = { path: '/home/s/curve.html', on: 'devbox' };
  g.docs.set('devbox:/home/s/curve.html', { text: '<p>remote' });
  state.disk = {};
  g.openInBrowser(tab, cx); await settle();
  const copy = execs.find(e => e[0] === 'sh').at(-1);
  state.disk[copy] = '<p>remote'; execs.length = 0;
  g.openInBrowser(tab, cx); await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 1, 'existing complete copy: opened');
  state.disk[copy] = '<p>rem'; execs.length = 0;
  g.openInBrowser(tab, cx); await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 0, 'partial copy: not opened');
  assert.equal(notes.at(-1).level, 'error');
  state.disk = {}; state.full = true;
  g.openInBrowser(tab, cx); await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 0);
  assert.match(notes.at(-1).body, /No space/);
});

test('a failed remote copy shows as a preview error too', async () => {
  const { g, cx, state, execs, settle } = htmlGroup(), tab = { path: '/home/s/c.html', on: 'devbox' };
  state.full = true; g.width = 700;
  g.htmlPage(tab, '<p>x', cx); await settle();
  assert.equal(execs.filter(e => e[0] === 'sh').length, 0, 'Chrome not started');
  const p = g.htmlPage(tab, '<p>x', cx);
  assert.equal(p.state, 'error'); assert.match(p.error, /No space/);
});

// Image blocks: TextView draws none, so the preview splits them out and draws each with image().
const PAGE = [
  '# Roles', '',
  '<picture>',
  '  <source media="(prefers-color-scheme: dark)" srcset="references/roles-dark.svg">',
  '  <img alt="The roles" src="references/roles-light.svg">',
  '</picture>', '',
  'Text ![inline](a.png) stays in the paragraph.',
  '![Diagram](<img/a b.png> "title")',
  '![Remote](https://x.invalid/a.png)',
  '```md', '![in a fence](skip.png)', '```',
  '```mermaid', 'graph TD; A-->B', '```',
].join('\n');

test('image blocks split out of the Markdown, and <picture> follows the theme', () => {
  const { parts } = harness();
  const kinds = ps => [...ps].map(p => p.image ?? (p.mermaid !== undefined ? 'mermaid' : 'md'));
  assert.deepEqual(kinds(parts(PAGE, true)), ['md', 'references/roles-dark.svg', 'md', 'img/a b.png', 'md', 'mermaid']);
  assert.deepEqual(kinds(parts(PAGE, false)), ['md', 'references/roles-light.svg', 'md', 'img/a b.png', 'md', 'mermaid']);
  const ps = parts(PAGE, true);
  assert.equal(ps[1].alt, 'The roles');
  assert.match(ps[2].md, /!\[inline\]\(a\.png\)/); // inline images stay Markdown
  assert.match(ps[4].md, /https:\/\/x\.invalid/); // URLs stay Markdown
  assert.match(ps[4].md, /in a fence/); // so do images inside code
  assert.equal(parts(PAGE, true).map(p => p.md ?? '').join('').includes('<picture>'), false);
});

test('images in code stay code: indented code, indented fences, longer closers, ~~~ in ```', () => {
  const { parts } = harness();
  const page = [
    'Example:', '', '    ![example](example.png)', '',
    '  ```md', '![in an indented fence](a.png)', '  ```', '',
    '```', '![closed by a longer fence](b.png)', '~~~', '![still in it](c.png)', '`````', '',
    '![real](d.png)',
  ].join('\n');
  const ps = [...parts(page, true)];
  assert.deepEqual(ps.map(p => p.image ?? 'md'), ['md', 'd.png']);
  for (const f of ['example.png', 'a.png', 'b.png', 'c.png']) assert.match(ps[0].md, new RegExp(f.replace('.', '\\.')));
});

test('image paths resolve against the page folder', () => {
  const { imagePath } = harness();
  assert.equal(imagePath('/r/skill/SKILL.md', 'references/x.svg'), '/r/skill/references/x.svg');
  assert.equal(imagePath('/r/skill/SKILL.md', './../img/./x.png'), '/r/img/x.png');
  assert.equal(imagePath('/r/skill/SKILL.md', '/abs/x.png'), '/abs/x.png');
});

// The copy script, run for real by sh; a fake hc stands in for `hc exec --on box cat`.
test('images are copied from this machine or through hc, then sized', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const { IMG } = harness();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'img-')), bin = path.join(tmp, 'bin'), out = path.join(tmp, 'out');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'hc'), '#!/bin/sh\n[ "$1 $2 $3" = "exec --on box" ] || exit 9\nshift 7; exec cat -- "$@"\n', { mode: 0o755 });
  const svgFile = path.join(tmp, 'Roles.SVG');
  fs.writeFileSync(svgFile, '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"\n  width="1522" height="848" viewBox="0 0 1522 848"></svg>');
  const sizer = path.join(__dirname, '../mods/ide-editor/image_size.py');
  const run = on => execFileSync('sh', ['-c', IMG, 'image', on, svgFile, out, sizer],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' }).trim().split(/\s+/);
  for (const on of ['', 'box']) {
    const [name, w, h] = run(on);
    assert.match(name, /^\d+-\d+\.svg$/);
    assert.deepEqual([w, h], ['1522', '848']);
    assert.equal(fs.readFileSync(path.join(out, name), 'utf8'), fs.readFileSync(svgFile, 'utf8'));
  }
  assert.throws(() => execFileSync('sh', ['-c', IMG, 'image', '', path.join(tmp, 'missing.png'), out, sizer], { stdio: 'pipe' }));
  assert.deepEqual(fs.readdirSync(out).filter(f => f.startsWith('.')), []); // no .part left behind
  fs.rmSync(tmp, { recursive: true });
});
