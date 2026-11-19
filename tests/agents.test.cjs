const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../mods/ide-agents/main.js'), 'utf8')
  .replace(/^import [^;]*;\n/gm, '').replace(/^export (const|function|class)/gm, '$1')
  .replace('export default class Agents', 'class Agents');

// The mod with stubbed Herdr; `state` records what it asked Herdr to do.
function load() {
  const state = { shared: {}, calls: [], closed: [], props: {}, hc: [], commands: [{ name: 'tab.rename' }] };
  const element = new Proxy({}, { get: () => () => element });
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, image: () => element, v_flex: () => element, h_flex: () => element,
    props: () => state.props, run: (command, args) => state.calls.push({ command, args }),
    shared: key => state.shared[key], setShared: (key, value) => { state.shared[key] = value; },
    closeOverlay: id => state.closed.push(id), openOverlay: o => state.calls.push({ overlay: o }),
    spaces: () => [{ tabs: [{ id: 'tab-a' }, { id: 'tab-b' }] }], panes: () => [{ pane: 'p1' }, { pane: 'p2' }], theme: () => ({}),
    terminals: () => [], commands: () => state.commands, notify() {},
    hc: args => { state.hc.push(args.join(' ')); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); },
  };
  const mod = vm.runInNewContext(source + '\n({ Agents, SWATCHES, TINT, mix, byTab, colorFrom, legacyLabels, LABEL });', sandbox);
  return { state, ...mod };
}

// WCAG contrast, for the palette's promise to a dark sidebar.
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const lum = c => {
  const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (c, bg, alpha) => c.map((v, i) => Math.round(bg[i] + (v - bg[i]) * alpha));

test('every swatch stands out on a dark sidebar and keeps white and gray text readable on its tint', () => {
  const { SWATCHES, TINT } = load();
  // graphite's sidebar (chrome), text (foreground) and gray text (muted), as Herdr derives them.
  const chrome = rgb('#101114'), white = rgb('#eeeeef'), gray = rgb('#98999b');
  const alpha = parseInt(TINT, 16) / 255;
  for (const s of SWATCHES) {
    const tint = over(rgb(s.hex), chrome, alpha);
    assert.ok(contrast(rgb(s.hex), chrome) >= 3, `${s.name} border`);
    assert.ok(contrast(white, tint) >= 7, `${s.name}: white text`);
    assert.ok(contrast(gray, tint) >= 4.5, `${s.name}: gray text`);
  }
});

test('a color comes from the terminal label, and only a swatch counts', () => {
  const { colorFrom, SWATCHES, LABEL } = load();
  assert.equal(colorFrom({ [LABEL]: SWATCHES[0].hex }), SWATCHES[0].hex);
  for (const labels of [{ [LABEL]: '#123456' }, { [LABEL]: '' }, {}, undefined]) assert.equal(colorFrom(labels), null);
});

test('the row menu labels its agent\'s terminal, renames through Herdr and closes', () => {
  const { state, Agents, SWATCHES } = load();
  state.props = { overlay: 'o1', tabMenu: { tab: 'tab-a', pane: 'p1', terminal: 'box/t7', name: 'fix login' } };
  const menu = new Agents();
  menu.init({}, {});
  assert.doesNotThrow(() => menu.render({}));
  menu.colorAgent('box/t7', SWATCHES[2].hex);
  menu.colorAgent('box/t7', null);
  assert.equal(JSON.stringify(state.hc), JSON.stringify([`label box/t7 herdr-ide.color=${SWATCHES[2].hex}`, 'label box/t7 herdr-ide.color=']));
  menu.renameTab('tab-a', 'p1');
  assert.equal(JSON.stringify(state.calls.at(-1)), '{"command":"tab.rename","args":{"id":"tab-a"}}');
  state.commands.push({ name: 'pane.rename' }); // Herdr after 0.1.16
  menu.renameTab('tab-a', 'p1');
  assert.equal(JSON.stringify(state.calls.at(-1)), '{"command":"pane.rename","args":{"pane":"p1"}}');
  assert.equal(state.closed.length, 4);
});

test('the focused row\'s fill is an opaque mix, so its halo can\'t show through', () => {
  const { mix } = load();
  assert.equal(mix('#101114', '#ffffff', 0), '#101114');
  assert.equal(mix('#101114', '#ffffff', 1), '#ffffff');
  assert.match(mix('#101114', '#e06c75', 0.14), /^#[0-9a-f]{6}$/);
});

test('a sub-agent row wears its parent tab\'s color at half strength, else soft white', () => {
  const { Agents, SWATCHES } = load();
  const seen = [];
  const el = new Proxy({}, { get: (_, k) => (...args) => { seen.push([k, ...args]); return el; } });
  const rows = new Agents();
  rows.kin(el, SWATCHES[0].hex);
  rows.kin(el);
  assert.deepEqual(seen.filter(([k]) => k === 'border_color').map(([, c]) => c), [SWATCHES[0].hex + '80', '#ffffff4d']);
});

test('agents sharing one screen group into runs; a tab seen again later starts a new run', () => {
  const { byTab } = load();
  const runs = byTab([{ tab: 'a' }, { tab: 'a' }, { tab: 'a' }, { tab: 'b' }, { tab: null }, { tab: null }, { tab: 'a' }]);
  assert.equal(JSON.stringify(runs.map(r => r.length)), '[3,1,1,1,1]');
});

test('colors kept in shared state before move onto terminals without overwriting a label', () => {
  const { legacyLabels, LABEL } = load();
  const red = '#e06c75', blue = '#5b9cf0';
  const agents = [{ address: 't1', tab: 'A', pane: 'p1' }, { address: 't2', tab: 'A', pane: 'p2' },
    { address: 't3', tab: 'B', pane: 'p3' }, { address: 't4', tab: 'A', pane: 'p4' }];
  const labelsOf = a => (a === 't4' ? { [LABEL]: blue } : {});
  const moved = legacyLabels(agents, { A: red }, { p2: blue, p3: '#123456' }, labelsOf);
  assert.equal(JSON.stringify(moved), JSON.stringify([['t1', red], ['t2', blue]]));
});