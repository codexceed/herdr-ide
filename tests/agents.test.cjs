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
  const state = { shared: {}, calls: [], closed: [], props: {} };
  const element = new Proxy({}, { get: () => () => element });
  const sandbox = {
    View: class {}, div: () => element, svg: () => element, image: () => element, v_flex: () => element, h_flex: () => element,
    props: () => state.props, run: (command, args) => state.calls.push({ command, args }),
    shared: key => state.shared[key], setShared: (key, value) => { state.shared[key] = value; },
    closeOverlay: id => state.closed.push(id), openOverlay: o => state.calls.push({ overlay: o }),
    spaces: () => [{ tabs: [{ id: 'tab-a' }, { id: 'tab-b' }] }], theme: () => ({}),
  };
  const mod = vm.runInNewContext(source + '\n({ Agents, SWATCHES, TINT, withColor, mix });', sandbox);
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

test('a color is set and cleared per tab; gone tabs and unknown colors are dropped', () => {
  const { withColor, SWATCHES } = load();
  const live = new Set(['tab-a', 'tab-b']), red = SWATCHES[0].hex, blue = SWATCHES[5].hex;
  const set = withColor({ 'tab-b': blue, gone: red, 'tab-a': '#123456' }, 'tab-a', red, live);
  assert.equal(JSON.stringify(set), JSON.stringify({ 'tab-b': blue, 'tab-a': red }));
  assert.equal(JSON.stringify(withColor(set, 'tab-a', null, live)), JSON.stringify({ 'tab-b': blue }));
});

test('the tab menu colors its tab, renames through Herdr and closes', () => {
  const { state, Agents, SWATCHES } = load();
  state.props = { overlay: 'o1', tabMenu: { tab: 'tab-a', name: 'fix login' } };
  const menu = new Agents();
  menu.init({}, {});
  assert.doesNotThrow(() => menu.render({}));
  menu.colorTab('tab-a', SWATCHES[2].hex);
  assert.equal(state.shared['ide-agents.tab-colors']['tab-a'], SWATCHES[2].hex);
  menu.colorTab('tab-a', null);
  assert.equal(state.shared['ide-agents.tab-colors'], null);
  menu.renameTab('tab-a');
  assert.equal(JSON.stringify(state.calls.at(-1)), '{"command":"tab.rename","args":{"id":"tab-a"}}');
  assert.deepEqual(state.closed, ['o1', 'o1', 'o1']);
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
