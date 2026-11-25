const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const state = { focus: 'term-a', calls: [], shared: {} };
  const panes = [
    { pane: 'term-a', terminal: 't1', tab: 'tab', cwd: '/repo/a' },
    { pane: 'term-b', terminal: 't2', tab: 'tab', cwd: '/repo/b' },
    { pane: 'editor', terminal: null, mod: 'ide-editor', tab: 'tab', cwd: null },
    { pane: 'term-c', terminal: 't3', tab: 'other', cwd: '/repo/c' },
  ];
  const sandbox = {
    View: class {}, div: () => null, svg: () => null, v_flex: () => null, h_flex: () => null, Editor: {}, EditorState: {},
    spaces: () => [{ id: 'space', active: true, folder: '/home/test', machine: null }],
    panes: () => panes,
    focused: () => ({ pane: state.focus, tab: 'tab', cwd: null }),
    shared: key => state.shared[key], setShared: (key, value) => { state.shared[key] = value; },
    run: (command, args) => state.calls.push({ command, args }),
  };
  const source = fs.readFileSync(path.join(__dirname, '../mods/ide-files/main.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class Files', 'class Files');
  return { state, ...vm.runInNewContext(source + '\n({ location, openFile, DOWNLOAD });', sandbox) };
}

test('an editor pane keeps the folder of the terminal focused before it', () => {
  const { state, location } = harness();
  state.focus = 'term-b'; assert.equal(location().cwd, '/repo/b');
  state.focus = 'editor'; assert.equal(location().cwd, '/repo/b');
});

test('each tab remembers its own last terminal', () => {
  const { state, location } = harness();
  state.focus = 'term-b'; location();
  state.focus = 'term-c'; assert.equal(location().cwd, '/repo/c');
  state.focus = 'editor'; assert.equal(location().cwd, '/repo/b');
});

test('an editor pane focused first shows the tab\'s first terminal folder', () => {
  const { state, location } = harness();
  state.focus = 'editor'; assert.equal(location().cwd, '/repo/a');
});

test('a file opened with no editor group splits a new group to the right', () => {
  const { state, openFile } = harness();
  openFile('/repo/a/README.md', null);
  const gid = state.shared['ide-editor.active'];
  assert.equal(state.calls.at(-1).command, 'pane.split');
  assert.equal(state.calls.at(-1).args.props.group, gid);
});

// The download script, run for real by sh against temp folders. A fake `hc` on PATH stands in
// for `hc exec --on <machine> cat`: it checks its arguments and cats the file locally.
const { spawnSync } = require('node:child_process');
const os = require('node:os');

function sandboxDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-files-dl-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'hc'), '#!/bin/sh\n[ "$1 $2 $3" = "exec --on box" ] || exit 9\nshift 7; exec cat -- "$@"\n', { mode: 0o755 });
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}
const runDownload = (DOWNLOAD, env, ...args) => spawnSync('sh', ['-c', DOWNLOAD, 'download', ...args], { env, encoding: 'utf8' });

test('download copies a local file byte for byte and prints where it landed', () => {
  const { DOWNLOAD } = harness(), { dir, env } = sandboxDir();
  const src = path.join(dir, 'data.bin'), bytes = Buffer.from([0, 255, 10, 13, 0, 1, 2]);
  fs.writeFileSync(src, bytes);
  const r = runDownload(DOWNLOAD, env, '', src, path.join(dir, 'out'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, path.join(dir, 'out', 'data.bin'));
  assert.deepEqual(fs.readFileSync(r.stdout), bytes);
});

test('download from another machine goes through hc exec --on', () => {
  const { DOWNLOAD } = harness(), { dir, env } = sandboxDir();
  const src = path.join(dir, 'remote.md'); fs.writeFileSync(src, '# hi\n');
  const r = runDownload(DOWNLOAD, env, 'box', src, path.join(dir, 'out'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(r.stdout, 'utf8'), '# hi\n');
});

test('download never overwrites: name (1).ext, and dotfiles keep their name', () => {
  const { DOWNLOAD } = harness(), { dir, env } = sandboxDir(), out = path.join(dir, 'out');
  const a = path.join(dir, 'a.tar.gz'), g = path.join(dir, '.gitignore');
  fs.writeFileSync(a, 'x'); fs.writeFileSync(g, 'y');
  const landed = [a, a, a, g, g].map(src => runDownload(DOWNLOAD, env, '', src, out).stdout);
  assert.deepEqual(landed.map(p => path.basename(p)), ['a.tar.gz', 'a.tar (1).gz', 'a.tar (2).gz', '.gitignore', '.gitignore (1)']);
});

test('a failed download leaves nothing behind', () => {
  const { DOWNLOAD } = harness(), { dir, env } = sandboxDir(), out = path.join(dir, 'out');
  const r = runDownload(DOWNLOAD, env, 'box', path.join(dir, 'missing.txt'), out);
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(out), []);
});
