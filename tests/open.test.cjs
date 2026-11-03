const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../mods/ide-open/main.js'), 'utf8')
  .replace(/^import [^;]*;\n/gm, '').replace('export default class Open', 'class Open');
const pure = vm.runInNewContext(source + '\n({ normalize, display, pathsIn, resolve, score, rank });', { View: class {} });
const { normalize, display, pathsIn, resolve, score, rank } = pure;
const json = v => JSON.stringify(v);

test('paths normalize and show relative to the root, else under ~', () => {
  assert.equal(normalize('/a/./b/../c//d'), '/a/c/d');
  assert.equal(display('/r/src/x.js', '/r', '/h'), 'src/x.js');
  assert.equal(display('/h/.claude/x.md', '/r', '/h'), '~/.claude/x.md');
  assert.equal(display('/tmp/x.md', '/r', '/h'), '/tmp/x.md');
});

test('printed paths: newest first, without line numbers, file URLs decoded', () => {
  const text = [
    'Read(mods/ide-pane/main.js)',
    'see https://github.com/a/b and e.g. this',
    '⎿ Wrote ~/.claude/notes.md and /tmp/out%20x.txt',
    'Updated README.md:42:7.',
    'link file:///tmp/a%20b.md',
  ].join('\n');
  const found = pathsIn(text);
  assert.equal(found[0], '/tmp/a b.md');
  assert.equal(found[1], 'README.md');
  assert.ok(found.indexOf('~/.claude/notes.md') < found.indexOf('mods/ide-pane/main.js'));
  assert.equal(resolve('README.md:42:7', '/r', '/h'), '/r/README.md');
  assert.equal(resolve('~/x/../y.md', '/r', '/h'), '/h/y.md');
  assert.equal(resolve('../z.md', '/r/sub', '/h'), '/r/z.md');
});

test('fuzzy: a subsequence matches, anything else does not', () => {
  assert.ok(score('mpm', 'mods/ide-pane/main.js'));
  assert.equal(score('xyz', 'mods/ide-pane/main.js'), null);
  assert.equal(score('main pane', 'mods/ide-pane/main.js') !== null, true);
  assert.equal(score('main zzz', 'mods/ide-pane/main.js'), null);
});

test('fuzzy: the file name and word starts beat scattered letters', () => {
  const items = ['mods/ide-agents/main.js', 'docs/MAINTAINERS', 'mods/ide-agents/swarm.py', 'tests/test_install.py']
    .map(p => ({ path: p }));
  assert.equal(rank('main', items)[0].path, 'mods/ide-agents/main.js');
  assert.equal(rank('swarm', items)[0].path, 'mods/ide-agents/swarm.py');
  assert.equal(rank('tinst', items)[0].path, 'tests/test_install.py');
});

test('fuzzy: hits point at the matched characters in the file name', () => {
  const { hits } = score('readme', 'docs/README.md');
  assert.equal(json(hits), json([5, 6, 7, 8, 9, 10]));
});

// The popup with stubbed Herdr.
function popup({ git = true, printed = '', exists = [], recent = [], focus = 'term' } = {}) {
  const state = { shared: { 'ide-open.recent': recent }, calls: [], closed: 0, execs: [] };
  const element = new Proxy({}, { get: () => () => element });
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, v_flex: () => element, h_flex: () => element, Input: { new: () => element },
    InputState: { new: () => { const on = {}; return { on: (e, fn) => { on[e] = fn; }, fire: (e, cx) => on[e](null, cx), focus() {}, v: '', set_value(v) { this.v = v; }, value() { return this.v; } }; } },
    spaces: () => [{ id: 's', active: true, folder: '/h/space', machine: null }],
    panes: () => [
      { pane: 'term', tab: 'tab', terminal: 't1', cwd: '/r/sub' },
      { pane: 'ed', tab: 'tab', mod: 'ide-editor', terminal: null },
    ],
    focused: () => ({ pane: focus, tab: 'tab', space: 's' }),
    home: () => '/h', theme: () => ({}), props: () => ({ overlay: 'mod-ide-open' }),
    closeOverlay: () => { state.closed++; }, run: (command, args) => state.calls.push({ command, args }),
    shared: k => state.shared[k], setShared: (k, v) => { state.shared[k] = v; },
    hc: async () => ({ code: 0, stdout: printed, stderr: '' }),
    exec: async (cmd, args, opts) => {
      state.execs.push({ cmd, args, opts });
      if (cmd === 'git' && args[0] === 'rev-parse') return git ? { code: 0, stdout: '/r\n', stderr: '' } : { code: 128, stdout: '', stderr: 'not a repo' };
      if (cmd === 'git') return { code: 0, stdout: 'README.md\0mods/ide-open/main.js\0sub/notes.md\0', stderr: '' };
      if (args[1]?.startsWith('for p;')) return { code: 0, stdout: args.slice(3).filter(p => exists.includes(p)).map(p => p + '\0').join(''), stderr: '' };
      if (args[1]?.includes('[ -d')) return { code: 0, stdout: exists.includes(args[3]) ? 'file\n' : '', stderr: '' };
      return { code: 0, stdout: 'a.txt\nb/c.md\n', stderr: '' };
    },
  };
  const Open = vm.runInNewContext(source + '\nOpen;', sandbox);
  const pending = [];
  const cx = { spawn: fn => { pending.push(fn(cx)); }, notify() {}, timer: { after() {} } };
  const o = new Open(); o.init({}, cx);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const type = q => { o.input.v = q; o.input.fire('change', cx); };
  const enter = async () => { o.input.fire('submit', cx); await settle(); };
  return { o, state, settle, type, enter };
}

test('the root is the git repo of the focused terminal, listed by git', async () => {
  const { o, state, settle } = popup();
  await settle();
  assert.equal(o.root, '/r');
  assert.equal(state.execs[0].opts.cwd, '/r/sub');
  assert.equal(o.files.length, 3);
});

test('outside a repo it lists the terminal folder with rg or find', async () => {
  const { o, settle } = popup({ git: false });
  await settle();
  assert.equal(o.root, '/r/sub');
  assert.equal(json(o.files), json(['a.txt', 'b/c.md']));
});

test('with no query: printed files that exist, newest first, then recent ones', async () => {
  const { o, settle } = popup({
    printed: 'Read(notes.md)\nwrote /tmp/out.md\nmissing/gone.md',
    exists: ['/r/sub/notes.md', '/tmp/out.md'],
    recent: [{ path: '/r/README.md', on: null }, { path: '/tmp/out.md', on: null }],
  });
  await settle();
  assert.equal(json(o.rows().map(r => [r.path, r.tag])), json([['/tmp/out.md', 'terminal'], ['sub/notes.md', 'terminal'], ['README.md', 'recent']]));
});

test('a query searches printed, recent and repo files once each', async () => {
  const { o, settle, type } = popup({ printed: 'see README.md', exists: ['/r/sub/README.md'] });
  await settle();
  type('notes');
  assert.equal(json(o.rows().map(r => r.path)), json(['sub/notes.md']));
  type('readme');
  assert.equal(json(o.rows().map(r => r.path)), json(['sub/README.md', 'README.md'])); // printed ranks first
});

test('Enter opens a new editor split right of the focused pane and remembers the file', async () => {
  const { o, state, settle, type, enter } = popup();
  await settle();
  type('ideopen');
  await enter();
  assert.equal(state.closed, 1);
  const split = state.calls.find(c => c.command === 'pane.split');
  assert.equal(split.args.pane, 'term');
  assert.equal(split.args.direction, 'right');
  assert.equal(split.args.props.seed.tabs[0].path, '/r/mods/ide-open/main.js');
  assert.equal(state.shared['ide-open.recent'][0].path, '/r/mods/ide-open/main.js');
});

test('a typed path opens files outside the repo, and refuses folders and missing files', async () => {
  const { o, state, settle, type, enter } = popup({ exists: ['/h/.claude/settings.json'] });
  await settle();
  type('~/.claude/settings.json');
  assert.equal(o.rows().length, 1);
  await enter();
  assert.equal(state.shared['ide-editor.groups'] && Object.values(state.shared['ide-editor.groups'])[0].tabs[0].path, '/h/.claude/settings.json');
  const second = popup();
  await second.settle();
  second.type('/nope.md');
  await second.enter();
  assert.equal(second.state.closed, 0);
  assert.equal(second.o.notice, 'No file at /nope.md');
});

test('opening into an existing group adds a tab and focuses its pane instead of splitting', async () => {
  const { state, settle, type, enter } = popup();
  state.shared['ide-editor.groups'] = { g1: { open: true, tab: 'tab', pane: 'ed', tabs: [{ path: '/r/README.md', on: null }], active: ':/r/README.md', used: 1 } };
  state.shared['ide-editor.active'] = 'g1';
  await settle();
  type('notes');
  await enter();
  assert.equal(state.calls.some(c => c.command === 'pane.split'), false);
  assert.equal(json(state.calls.at(-1)), json({ command: 'pane.focus', args: { pane: 'ed' } }));
  assert.equal(state.shared['ide-editor.groups'].g1.tabs.length, 2);
});
