// A pane's header: the shipped `pane` header plus find (cmd-f).
// - terminal: Herdr's own find bar (`terminal.search`): it highlights each hit in the screen
//   and history and scrolls to it. keys.json binds cmd-f to it in terminals directly; this
//   path covers the palette and anyone who kept cmd-f on ide-pane.find.
// - editor pane (mods/ide-editor): the header turns into a find bar over the open file and
//   steps through matching lines; Enter copies one; the editor lists every match below.
//   Over a rendered Markdown preview it steps through every hit in the page instead (Enter /
//   Shift-Enter): the editor highlights them, scrolls to the current one and reports the count.
// State: shared("ide-find") = { [pane]: { query, at, matches } } for each open editor bar;
// matches are [{ n, parts: [before, hit, after] }], drawn by the editor.
// shared("ide-find.preview") = { [pane]: { file, query, count } }, written by the editor.
// Props from the app: { pane, terminal }.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { panes, terminals, props, run, theme, home, readTextFile, shared, setShared, nextCommand, notify } from "herdr";

const FIND = "ide-find", HITS = "ide-find.preview", SHOWN = 300, BEFORE = 40;
const keyOf = t => `${t.on ?? ""}:${t.path}`;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// An agent that finished (done) or needs you (blocked) lights its header up in the status
// color the sidebar's dots use: a tint and a 2px edge ({ edge, tint }, else null). Herdr's
// pane frame has no per-status border, so the header is the part of the pane a mod can light.
const GLOW = "2e"; // the tint: the color at 0x2e / 255 ≈ 18%
// The color picked for this pane's agent in the agents sidebar (ide-agents keeps it as the
// terminal label `herdr-ide.color`) fills the header's right side, fading in from the left:
// Herdr draws one pane border for the whole layout, so a mod can't color the pane's outline.
// An element takes only solid colors, so the fade is FADE strips of rising alpha, inset from
// the header's edges so it never crosses the pane's rounded border.
// The alpha eases in (CURVE > 1) so the color is strong toward the right edge, as vivid as the
// sidebar row's border, and faint where it meets the header's text.
const LABEL = "herdr-ide.color", FADE = 48, PEAK = 0xe6, CURVE = 1.8; // PEAK ≈ 90%
const fade = hex => Array.from({ length: FADE }, (_, i) =>
  hex + Math.round(PEAK * ((i + 1) / FADE) ** CURVE).toString(16).padStart(2, "0"));
// The header's buttons sit in a solid black box with white icons, always shown: over an agent's
// color a hover-only, theme-gray row was hard to find. Hovering a button gives it a halo: a soft
// white fill and ring (gpui-kit's shadows are black presets, so there's no colored glow).
const BOX = "#000000", ICON = "#ffffff", HALO = "#ffffff26", RING = "#ffffff66", NO_RING = "#ffffff00";
const glow = (t, status) => (status === "done" || status === "blocked") && t[status]
  ? { edge: t[status], tint: t[status].slice(0, 7) + GLOW } : null;

// Lines holding the query (any case), newest first: [{ n, text, at, len }], at most SHOWN.
const matches = (lines, query) => {
  const q = query.trim(), out = [];
  if (!q) return out;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  for (let i = lines.length - 1; i >= 0 && out.length < SHOWN; i--) {
    const m = re.exec(lines[i]);
    if (m) out.push({ n: i + 1, text: lines[i], at: m.index, len: m[0].length });
  }
  return out;
};

// A match's line cut to [before, match, after] around it. Never splits a surrogate pair:
// half an emoji is invalid UTF-8 and the frame fails to draw.
const snippet = m => {
  let start = Math.max(0, m.at - BEFORE);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(m.text[start])) start--;
  return [(start ? "…" : "") + m.text.slice(start, m.at), m.text.slice(m.at, m.at + m.len), m.text.slice(m.at + m.len)];
};

export default class Pane extends View {
  init(_props, cx) {
    this.finding = false;
    this.lines = null;
    this.source = null; // the key of the editor file this.lines came from
    this.gen = 0; // bumped by every load and close; a read that finishes later is dropped
    this.input = InputState.new({ placeholder: "Find" });
    this.input.on("change", (_e, cx) => { this.update({ query: this.input.value(), at: 0 }); cx.notify(); });
    this.input.on("submit", (_e, cx) => { if (this.previewing()) this.step(this.back ? -1 : 1); else this.copy(cx); this.back = false; cx.notify(); });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "find" && this.me()?.focused) this.open(cx);
        else if (c === "close" && this.finding) this.close();
        cx.notify();
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // The open file of the editor group that owns this pane, if it is one.
  file() {
    const g = Object.values(shared("ide-editor.groups") ?? {}).find(x => x.open && x.pane === props()?.pane);
    return g?.tabs?.find(t => keyOf(t) === g.active) ?? null;
  }

  // True when the editor shows this file as a rendered Markdown page.
  previewing() {
    const g = Object.values(shared("ide-editor.groups") ?? {}).find(x => x.open && x.pane === props()?.pane);
    return Boolean(g?.active && g.preview?.includes(g.active) && /\.(md|markdown|mdx)$/i.test(this.file()?.path ?? ""));
  }

  // The preview's hit count for the current query, or null until the editor has counted.
  previewCount() {
    const h = shared(HITS)?.[props()?.pane], tab = this.file();
    return h && tab && h.file === keyOf(tab) && h.query === this.state().query.trim() ? h.count : null;
  }

  state() {
    return shared(FIND)?.[props()?.pane] ?? { query: "", at: 0 };
  }

  // Writes this pane's search (null removes it), dropping entries of panes that are gone.
  save(next) {
    const live = new Set(panes().map(p => p.pane)), all = {};
    for (const [pane, s] of Object.entries(shared(FIND) ?? {})) if (live.has(pane)) all[pane] = s;
    if (next) all[props()?.pane] = next; else delete all[props()?.pane];
    setShared(FIND, Object.keys(all).length ? all : null);
  }

  found() {
    return matches(this.lines ?? [], this.state().query);
  }

  update(change) {
    const next = { ...this.state(), ...change };
    next.matches = matches(this.lines ?? [], next.query).map(m => ({ n: m.n, parts: snippet(m) }));
    this.save(next);
  }

  open(cx) {
    // The command only reaches a focused header, so the focused terminal is this pane's.
    if (this.me()?.terminal) { run("terminal.search"); return; }
    this.finding = true;
    this.input.set_value(""); this.update({ query: "", at: 0 });
    this.input.focus();
    this.load(cx);
  }

  // (Re)reads the editor's open file.
  load(cx) {
    const tab = this.file(), gen = ++this.gen;
    this.lines = null; this.error = null; this.source = tab ? keyOf(tab) : null;
    this.update({ at: 0 });
    if (!tab) { this.error = "Nothing to search here"; return; }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(tab.path, { on: tab.on });
        if (text === null) throw new Error("This file is no longer available");
        if (gen !== this.gen) return;
        this.lines = text.split("\n");
        this.update({});
      } catch (e) { if (gen === this.gen) this.error = String(e.message ?? e); }
      finally { cx.notify(); }
    });
  }

  close() {
    this.gen++;
    this.finding = false; this.lines = null; this.source = null;
    this.save(null);
    run("pane.focus", { pane: props()?.pane });
  }

  step(by) {
    const n = this.previewing() ? this.previewCount() ?? 0 : this.found().length;
    if (n) this.update({ at: (this.state().at + by + n) % n });
  }

  copy(cx) {
    const m = this.found()[this.state().at];
    if (!m) return;
    cx.write_to_clipboard(m.text.trim());
    notify({ title: `Copied line ${m.n}`, level: "success", timeout: 2000 });
    this.close();
  }

  // 14px icon + 2px padding + 1px ring each side = 20px; in the box's 2px padding = 24px,
  // the height of the color strip in the 30px header.
  button(id, icon, command, args) {
    return div()
      .id(id)
      .p(2)
      .rounded(4)
      .border_1()
      .border_color(NO_RING)
      .text_color(ICON)
      .hover((s) => s.bg(HALO).border_color(RING))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/ide-pane/${icon}.svg`).size(14));
  }

  findButton(t, id, icon, action) {
    return div().id(id).p(3).rounded(4).flex_none().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); })
      .child(svg(`mods/ide-pane/${icon}.svg`).size(13));
  }

  findBar(t, p) {
    const found = this.found(), at = this.state().at, q = this.state().query.trim();
    const hits = this.previewing() ? this.previewCount() : undefined;
    const count = hits !== undefined
      ? (!q ? "Find in page" : hits === null ? "Searching…" : hits ? `${at % hits + 1} of ${hits}` : "No matches")
      : this.error ?? (this.lines === null ? "Reading…" : !q ? `${this.lines.length.toLocaleString()} lines`
      : found.length ? `${at + 1} of ${found.length === SHOWN ? `${SHOWN}+` : found.length}` : "No matches");
    return h_flex()
      .id(`pane-find-${p.pane}`)
      .size_full()
      .px(8)
      .gap(6)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.accent)
      .text_size(12)
      .on_key_down((e, cx) => {
        // Shift-Enter steps back over a preview; the input's submit does the stepping.
        if (e.key === "enter") { this.back = Boolean(e.modifiers?.shift); return; }
        if (e.key === "escape") this.close();
        else if (e.key === "down") this.step(1);
        else if (e.key === "up") this.step(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(svg("mods/ide-pane/search.svg").size(13).flex_none().text_color(t.dim))
      .child(div().w(180).flex_none().h(22).px(6).rounded(5).border_1().border_color(t.input).bg(t.surface)
        .child(Input.new(this.input).size_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().text_color(this.error ? t.ansi1 : t.dim).child(count))
      .child(this.findButton(t, `pf-up-${p.pane}`, "chevron-up", () => this.step(-1)))
      .child(this.findButton(t, `pf-down-${p.pane}`, "chevron-down", () => this.step(1)))
      .child(div().flex_1())
      .child(this.findButton(t, `pf-x-${p.pane}`, "close", () => this.close()));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // The editor dropped our search (Esc pressed on the page itself): close the bar.
    // (Only once the entry was seen, in case a fresh write isn't visible yet.)
    const mine = Boolean(shared(FIND)?.[p.pane]);
    if (this.finding && this.seen && !mine) this.close();
    this.seen = this.finding && mine;
    if (this.finding) {
      // The editor switched files under an open bar: search the file it shows now.
      const tab = this.file();
      if ((tab ? keyOf(tab) : null) !== this.source) this.load(cx);
    }
    if (this.finding) return this.findBar(t, p);
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const lit = glow(t, st);
    const hue = /^#[0-9a-f]{6}$/i.test(terminals().find(x => x.address === p.terminal)?.labels?.[LABEL] ?? "")
      ? terminals().find(x => x.address === p.terminal).labels[LABEL] : null;
    return h_flex()
      .id(`pane-head-${pane}`)
      .relative()
      .when(Boolean(hue), el => el.child(h_flex().absolute().top(3).bottom(3).right(4).w("36%").rounded_r(7).overflow_hidden()
        .children(fade(hue).map((c, i) => div().flex_1().h_full().bg(c).when(i === FADE - 1, s => s.rounded_r(7))))))
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(lit ? lit.tint : t.background)
      .when(!lit, el => el.border_b(1).border_color(t.border))
      .when(Boolean(lit), el => el.border_b(2).border_color(lit.edge))
      .text_size(12)
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .child(h_flex().flex_none().gap(2).p(2).rounded(6).bg(BOX)
        .child(this.button(`ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(`ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(`ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(`ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
