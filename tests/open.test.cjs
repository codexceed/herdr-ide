const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../mods/ide-open/main.js'), 'utf8')
  .replace(/^import [^;]*;\n/gm, '').replace('export default class Open', 'class Open');
const pure = vm.runInNewContext(source + '\n({ normalize, display, pathsIn, resolve, score, rank, rankInto, termsOf, MAX_CELLS });', { View: class {} });
const { normalize, display, pathsIn, resolve, score, rank, rankInto, termsOf, MAX_CELLS } = pure;
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

test('printed paths keep spaces when quoted, brackets, any script and escaped spaces', () => {
  const text = [
    'Wrote `/tmp/project/path with space/notes.md` and "/tmp/q dir/a.md"',
    'it\'s in `src/x.js` and don\'t forget /tmp/project/src/app/[id]/page.tsx.',
    'see /tmp/project/docs/研究.md, then /tmp/esc\\ aped/f.md and [README.md](README.md)',
    'opened `/tmp/John\'s Project/notes.md` and "/tmp/Ann\'s/b.md"',
  ].join('\n');
  const found = pathsIn(text);
  for (const p of ['/tmp/project/path with space/notes.md', '/tmp/q dir/a.md', 'src/x.js',
    '/tmp/project/src/app/[id]/page.tsx', '/tmp/project/docs/研究.md', '/tmp/esc aped/f.md', 'README.md',
    "/tmp/John's Project/notes.md", "/tmp/Ann's/b.md"]) {
    assert.ok(found.includes(p), `${p} in ${json(found)}`);
  }
  // The quoted path ranks where it ends, ahead of the words inside it.
  assert.ok(found.indexOf('/tmp/project/path with space/notes.md') < found.indexOf('space/notes.md'));
  assert.equal(resolve('"/tmp/a b.md:3"'.slice(1, -1), '/r', '/h'), '/tmp/a b.md');
});

test('ranking in timed batches gives the same top rows as ranking at once', () => {
  const items = Array.from({ length: 2500 }, (_, i) => ({ path: `packages/c${i % 97}/src/main${i}.test.js` }));
  const top = [], matched = [];
  let batches = 0;
  // A deadline already past: each batch still ranks one item, then stops.
  for (let i = 0; i < items.length; batches++) i = rankInto(termsOf('main test'), items, i, top, matched, Date.now() - 1);
  assert.equal(batches, 2500);
  assert.equal(json(top.map(r => r.path)), json(rank('main test', items).map(r => r.path)));
  assert.equal(matched.length, 2500);
});

test('a huge alignment falls back to a greedy match instead of a giant table', () => {
  const long = 'deep/'.repeat(Math.ceil(MAX_CELLS / 4 / 5)) + 'main.test.js';
  const s = score('main', long);
  assert.ok(s);
  assert.equal(s.hits.length, 4);
  assert.equal(score('zzzz', long), null);
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
function popup({ tick = 0, git = true, printed = '', printed2 = '', exists = [], recent = [], focus = 'term', files = 'README.md\0mods/ide-open/main.js\0sub/notes.md\0' } = {}) {
  const state = { shared: { 'ide-open.recent': recent }, calls: [], closed: 0, execs: [], yields: 0 };
  const element = new Proxy({}, { get: () => () => element });
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, v_flex: () => element, h_flex: () => element, Input: { new: () => element },
    InputState: { new: () => { const on = {}; return { on: (e, fn) => { on[e] = fn; }, fire: (e, cx) => on[e](null, cx), focus() {}, v: '', set_value(v) { this.v = v; }, value() { return this.v; } }; } },
    spaces: () => [{ id: 's', active: true, folder: '/h/space', machine: null }],
    panes: () => [
      { pane: 'term', tab: 'tab', terminal: 't1', cwd: '/r/sub' },
      { pane: 'term2', tab: 'tab', terminal: 't2', cwd: '/other' },
      { pane: 'ed', tab: 'tab', mod: 'ide-editor', terminal: null },
    ],
    focused: () => ({ pane: focus, tab: 'tab', space: 's' }),
    home: () => '/h', theme: () => ({}), props: () => ({ overlay: 'mod-ide-open' }),
    closeOverlay: () => { state.closed++; }, run: (command, args) => state.calls.push({ command, args }),
    shared: k => state.shared[k], setShared: (k, v) => { state.shared[k] = v; },
    hc: async args => ({ code: 0, stdout: args[1] === 't2' ? printed2 : printed, stderr: '' }),
    exec: async (cmd, args, opts) => {
      state.execs.push({ cmd, args, opts });
      if (cmd === 'git' && args[0] === 'rev-parse') return git ? { code: 0, stdout: '/r\n', stderr: '' } : { code: 128, stdout: '', stderr: 'not a repo' };
      if (cmd === 'git') return { code: 0, stdout: files, stderr: '' };
      if (args[1]?.startsWith('for p;')) return { code: 0, stdout: args.slice(3).filter(p => exists.includes(p)).map(p => p + '\0').join(''), stderr: '' };
      if (args[1]?.includes('[ -d')) return { code: 0, stdout: exists.includes(args[3]) ? 'file\n' : '', stderr: '' };
      return { code: 0, stdout: 'a.txt\nb/c.md\n', stderr: '' };
    },
  };
  // tick > 0: a fake clock that moves `tick` ms per read, so batches end after a few paths.
  if (tick) { let now = 0; sandbox.Date = { now: () => (now += tick) }; }
  const Open = vm.runInNewContext(source + '\nOpen;', sandbox);
  const pending = [];
  const cx = { spawn: fn => { pending.push(fn(cx)); }, notify() {}, sleep: async () => { state.yields++; }, timer: { after() {} } };
  const o = new Open(); o.init({}, cx);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const type = async q => { o.input.v = q; o.input.fire('change', cx); await settle(); };
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
  await type('notes');
  assert.equal(json(o.rows().map(r => r.path)), json(['sub/notes.md']));
  await type('readme');
  assert.equal(json(o.rows().map(r => r.path)), json(['sub/README.md', 'README.md'])); // printed ranks first
});

test('Enter opens a new editor split right of the focused pane and remembers the file', async () => {
  const { o, state, settle, type, enter } = popup();
  await settle();
  await type('ideopen');
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
  await type('~/.claude/settings.json');
  assert.equal(o.rows().length, 1);
  await enter();
  assert.equal(state.shared['ide-editor.groups'] && Object.values(state.shared['ide-editor.groups'])[0].tabs[0].path, '/h/.claude/settings.json');
  const second = popup();
  await second.settle();
  await second.type('/nope.md');
  await second.enter();
  assert.equal(second.state.closed, 0);
  assert.equal(second.o.notice, 'No file at /nope.md');
});

test('opening into an existing group adds a tab and focuses its pane instead of splitting', async () => {
  const { state, settle, type, enter } = popup();
  state.shared['ide-editor.groups'] = { g1: { open: true, tab: 'tab', pane: 'ed', tabs: [{ path: '/r/README.md', on: null }], active: ':/r/README.md', used: 1 } };
  state.shared['ide-editor.active'] = 'g1';
  await settle();
  await type('notes');
  await enter();
  assert.equal(state.calls.some(c => c.command === 'pane.split'), false);
  assert.equal(json(state.calls.at(-1)), json({ command: 'pane.focus', args: { pane: 'ed' } }));
  assert.equal(state.shared['ide-editor.groups'].g1.tabs.length, 2);
});

test('printed relative paths resolve against the terminal that printed them', async () => {
  const { o, settle } = popup({
    printed: 'Read(src/main.js)', printed2: 'Edit(src/main.js)',
    exists: ['/r/sub/src/main.js', '/other/src/main.js'],
  });
  await settle();
  assert.equal(json(o.printed), json(['/r/sub/src/main.js', '/other/src/main.js']));
});

test('a printed path with spaces, brackets or other scripts survives the existence check', async () => {
  const wanted = ['/tmp/p/path with space/notes.md', '/tmp/p/app/[id]/page.tsx', '/tmp/p/docs/研究.md'];
  const { o, settle } = popup({ printed: 'wrote `/tmp/p/path with space/notes.md`, /tmp/p/app/[id]/page.tsx and /tmp/p/docs/研究.md', exists: wanted });
  await settle();
  assert.equal(json([...o.printed].sort()), json([...wanted].sort()));
});

const many = n => Array.from({ length: n }, (_, i) => `packages/c${i % 97}/src/main${i}.test.js\0`).join('');

test('a query ranks in timed batches off the render path, yielding between them', async () => {
  const { o, state, settle, type } = popup({ tick: 5, files: many(300) });
  await settle();
  const before = state.yields;
  await type('test');
  // 5 ms a clock read, 20 ms a batch: a few paths per batch, so dozens of yields.
  assert.ok(state.yields - before >= 50, `yields: ${state.yields - before}`);
  assert.equal(o.found.done, true);
  assert.equal(o.rows().length, 60);
  // render reads the finished rows; it ranks nothing itself.
  o.found = { ...o.found, rows: [] };
  assert.equal(o.rows().length, 0);
});

test('a newer query abandons an older one, and a longer query narrows the last matches', async () => {
  const { o, settle, type } = popup({ tick: 5, files: many(300) + 'docs/other.md\0' });
  await settle();
  o.input.v = 'main';
  o.input.fire('change', { spawn: () => {}, notify() {} }); // its search never runs to the end
  await type('main1');
  assert.equal(o.found.q, 'main1');
  const pool = o.pool().all;
  await type('main12');
  assert.ok(o.last.matched.length < pool.length);
  assert.equal(json(o.rows().map(r => r.path)), json(rank('main12', pool).map(r => r.path)));
});

test('Enter while a query is still ranking opens its best file once ranked', async () => {
  const { o, state, settle } = popup();
  await settle();
  o.input.v = 'ideopen';
  o.input.fire('change', { spawn: () => {}, notify() {} }); // ranking not started yet
  o.input.fire('submit', null);
  assert.equal(state.closed, 0);
  assert.equal(o.enter, true);
  // The search finishes later.
  await new Promise(r => setImmediate(r));
  const cx = { spawn: fn => fn(cx), notify() {}, sleep: async () => {} };
  o.search(cx);
  await new Promise(r => setImmediate(r));
  await settle();
  assert.equal(state.closed, 1);
  assert.equal(state.calls.find(c => c.command === 'pane.split').args.props.seed.tabs[0].path, '/r/mods/ide-open/main.js');
});

// Herdr's own engine, on the reviewer's worst case: long paths and a seven-word query.
// - render: one timed batch fits even a render's 50 ms (tasks get 500 ms), and the popup with
//   50,000 files and a query renders without ranking;
// - init: the real search() runs its first batch (check exits before later ones) and must not
//   be interrupted; check reports that only as a warning, so the output is checked too.
// Skipped where Herdr isn't installed (CI).
const herdrApp = (() => { try { return execFileSync('sh', ['-c', 'command -v herdr-app'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
test('native: ranking stays inside Herdr\'s execution limits', { skip: herdrApp ? false : 'herdr-app not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-open-native-'));
  try {
    const mod = path.join(dir, 'probe');
    fs.mkdirSync(mod);
    fs.writeFileSync(path.join(mod, 'mod.json'), '{ "place": "none", "title": "probe" }');
    const main = fs.readFileSync(path.join(__dirname, '../mods/ide-open/main.js'), 'utf8').replace('export default class Open', 'class Open');
    fs.writeFileSync(path.join(mod, 'main.js'), main + `
const QUERY = "components quick open search main test";
const LONG = i => \`packages/curriculum-engineering/tasks/repository-workflows/frontend/components/quick-open/file-search/component-\${i}/src/main.test.js\`;
export default class Probe extends View {
  init(_props, cx) {
    this.items = Array.from({ length: 5000 }, (_, i) => ({ path: LONG(i) }));
    const open = cx => {
      const o = Object.create(Open.prototype);
      Object.assign(o, { root: "/r", printed: [], ctx: { on: null, cwd: "/r" }, query: QUERY, gen: 0, found: null, last: null, enter: false, notice: null, error: null, at: 0, top: 0 });
      o.recent = () => [];
      o.files = Array.from({ length: 50000 }, (_, i) => LONG(i));
      return o;
    };
    this.open = open();
    this.open.input = InputState.new({});
    open().search(cx);
  }
  render() {
    rankInto(termsOf(QUERY), this.items, 0, [], [], Date.now() + BATCH_MS);
    return this.open.render();
  }
}
`);
    const r = spawnSync(herdrApp, ['check', mod], { encoding: 'utf8', env: { ...process.env, HERDR_APP_HOME: path.join(dir, 'home') } });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /check passed/);
    assert.doesNotMatch(out, /interrupted|error/i, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
