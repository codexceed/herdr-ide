// A pane's header: the shipped `pane` header plus find (cmd-f), so the find bar sits on the
// pane it searches. Herdr has no find of its own, can't place a popup over a pane and can't
// scroll a terminal, so the bar steps through matching lines and Enter copies one:
// - terminal: its screen and history from herdr-core (`hc read`); the bar shows the line;
// - editor pane (mods/ide-editor): the open file; the editor lists every match below.
// State: shared("ide-find") = { [pane]: { query, at, matches? } } for each open bar; matches
// ([{ n, parts: [before, hit, after] }]) only for editor panes, which draw the list.
// Props from the app: { pane, terminal }.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { panes, props, run, theme, home, hc, readTextFile, shared, setShared, nextCommand, notify } from "herdr";

const FIND = "ide-find", HISTORY = 10000, SHOWN = 300, BEFORE = 40;
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
    this.hovered = false;
    this.finding = false;
    this.lines = null;
    this.source = null; // what this.lines came from: the terminal, or the editor file's key
    this.gen = 0; // bumped by every load and close; a read that finishes later is dropped
    this.input = InputState.new({ placeholder: "Find" });
    this.input.on("change", (_e, cx) => { this.update({ query: this.input.value(), at: 0 }); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.copy(cx));
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
    if (this.me()?.mod) next.matches = matches(this.lines ?? [], next.query).map(m => ({ n: m.n, parts: snippet(m) }));
    this.save(next);
  }

  open(cx) {
    this.finding = true;
    this.input.set_value(""); this.update({ query: "", at: 0 });
    this.input.focus();
    this.load(cx);
  }

  // (Re)reads what the pane shows: the terminal's history, or the editor's open file.
  load(cx) {
    const p = this.me(), tab = p?.mod ? this.file() : null, gen = ++this.gen;
    this.lines = null; this.error = null; this.source = tab ? keyOf(tab) : p?.terminal ?? null;
    this.update({ at: 0 });
    if (!p?.terminal && !tab) { this.error = "Nothing to search here"; return; }
    cx.spawn(async cx => {
      try {
        let lines;
        if (p.terminal) {
          const r = await hc(["read", p.terminal, "--lines", String(HISTORY)]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "hc read failed");
          lines = r.stdout.split("\n");
        } else {
          const text = await readTextFile(tab.path, { on: tab.on });
          if (text === null) throw new Error("This file is no longer available");
          lines = text.split("\n");
        }
        if (gen !== this.gen) return;
        this.lines = lines;
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
    const n = this.found().length;
    if (n) this.update({ at: (this.state().at + by + n) % n });
  }

  copy(cx) {
    const m = this.found()[this.state().at];
    if (!m) return;
    cx.write_to_clipboard(m.text.trim());
    notify({ title: `Copied line ${m.n}`, level: "success", timeout: 2000 });
    this.close();
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
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
    const found = this.found(), at = this.state().at, m = found[at], q = this.state().query.trim();
    const count = this.error ?? (this.lines === null ? "Reading…" : !q ? `${this.lines.length.toLocaleString()} lines`
      : found.length ? `${at + 1} of ${found.length === SHOWN ? `${SHOWN}+` : found.length}` : "No matches");
    const [before, hit, after] = m && p.terminal ? snippet(m) : [];
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
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_color(t.muted)
        .when(Boolean(hit), el => el
          .child(div().flex_none().text_color(t.dim).child(`${m.n}`)).child(div().w(8).flex_none())
          .child(div().flex_none().child(before))
          .child(div().flex_none().rounded(3).bg(t.accent).text_color(t.accent_foreground).child(hit))
          .child(div().flex_1().min_w(0).truncate().child(after))))
      .child(this.findButton(t, `pf-x-${p.pane}`, "close", () => this.close()));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    if (this.finding && p.mod) {
      // The editor switched files under an open bar: search the file it shows now.
      const tab = this.file();
      if ((tab ? keyOf(tab) : null) !== this.source) this.load(cx);
    }
    if (this.finding) return this.findBar(t, p);
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
