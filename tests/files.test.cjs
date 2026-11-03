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
  return { state, ...vm.runInNewContext(source + '\n({ location, openFile });', sandbox) };
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
