// An editor group: a pane holding a stack of file tabs, like a VSCode editor group.
// Open several side by side (split button / cmd-\) to see files next to each other.
//
// State lives in shared("ide-editor.groups")[props().group]:
//   { tabs: [{ path, on }], active: key, preview: [key], tab, open, used, pane? }
// The Files panel (mods/ide-files) adds tabs to the most recently used group of the
// current Herdr tab, or splits a new group to the right.
// Commands (keys.json): ide-editor.markdown (cmd-shift-v), .split (cmd-\), .close (cmd-w).
// Find (cmd-f) lives in the pane header (mods/ide-pane); this pane lists its matches.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, shared, setShared, focused, panes, run, exec, readTextFile, theme, settings, appHome, home, nextCommand } from "herdr";

const KEY = "ide-editor.groups", ACTIVE = "ide-editor.active", MOD = "ide-editor", FIND = "ide-find";
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const keyOf = t => `${t.on ?? ""}:${t.path}`;
const nameOf = path => path.split(/[\\/]/).pop();
const isMarkdown = path => /\.(md|markdown|mdx)$/i.test(path ?? "");
const newId = () => "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const all = () => JSON.parse(JSON.stringify(shared(KEY) ?? {}));
const blank = () => ({ tabs: [], active: null, preview: [], open: false });

// Front matter is hidden in the preview, as VSCode does.
const body = text => text.replace(/^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1[ \t]*(\r?\n|$)/, "");

// Mermaid: each ```mermaid block is rendered once by mermaid-cli (mmdc) to a PNG, cached by content + theme.
const MERMAID_DIR = "data/ide-mermaid", MERMAID_SCALE = 2;
const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
const hash = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16) + text.length.toString(16); };
const MMDC = `set -e; mkdir -p "$(dirname "$2")"
if [ ! -s "$2" ]; then tmp="$2.$$.mmd"; printf '%s' "$1" > "$tmp"
  mmdc -q -i "$tmp" -o "$2.$$.png" -t "$3" -b transparent -s ${MERMAID_SCALE} >&2 || { rm -f "$tmp" "$2.$$.png"; exit 1; }
  rm -f "$tmp"; mv "$2.$$.png" "$2"; fi
sips -g pixelWidth -g pixelHeight "$2" | awk '/pixel/ {print $2}'`;
const parts = text => {
  const out = []; let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) out.push({ md: text.slice(last, m.index) });
    out.push({ mermaid: m[1] }); last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ md: text.slice(last) });
  return out;
};
// mmdc prints the parse error, then a stack trace; keep the error.
const mermaidError = stderr => {
  const lines = stderr.trim().split("\n"), end = lines.findIndex(l => /^\s*at\s|\(\S+:\d+:\d+\)$/.test(l));
  return lines.slice(0, end < 0 ? lines.length : end).join("\n").replace(/^Error:\s*/, "").trim();
};
// Geist, the UI font, ships without bold or italic faces; the system font has both.
const PREVIEW_FONT = ".SystemUIFont";
const diagrams = new Map(); // shared by every group in this mod: hash -> { state, path, w, h, error }

export default class EditorGroup extends View {
  init(_props, cx) {
    this.gid = props()?.group ?? newId();
    this.docs = new Map(); // tab key -> { text, code, error, loading }
    this.handle = cx.focus_handle();
    this.pane = this.group().pane;
    this.claimPane = false; // restored background groups must not claim global focus
    this.gen = 0; // bumped when this pane loses focus, to remount the preview's text
    // props.seed = { tabs: [{ path, on }], active?, preview? } fills a brand-new group.
    const seed = props()?.seed;
    this.edit(g => {
      if (seed?.tabs?.length && !g.tabs.length) {
        g.tabs = seed.tabs.map(t => ({ path: t.path, on: t.on ?? null }));
        g.active = seed.active ?? keyOf(g.tabs[0]); g.preview = seed.preview ?? [];
      }
      g.open = true; g.tab ??= focused()?.tab; g.used = Date.now();
    });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); this.activate(); }
        else if (shared(ACTIVE) === this.gid) { this.learnPane(); this.command(c, cx); }
        cx.notify();
      }
    });
    cx.timer.every(3000, cx => { this.learnPane(); this.reload(cx); });
  }

  // Our pane id isn't a prop. Short of focus telling us (render), it's the one editor pane in
  // our tab that no other open group owns: a split or a Files click leaves exactly one.
  learnPane() {
    if (this.pane && panes().some(p => p.pane === this.pane)) return;
    const g = this.group(), groups = all();
    const owned = new Set(Object.entries(groups).filter(([id, x]) => id !== this.gid && x.open && x.pane).map(([, x]) => x.pane));
    const free = panes().filter(p => p.mod === MOD && p.tab === g.tab && !owned.has(p.pane));
    if (free.length === 1) { this.pane = free[0].pane; this.edit(x => { x.pane = this.pane; }); }
  }

  async close() {
    for (const d of this.docs.values()) d.code?.release();
    const groups = all();
    if (groups[this.gid]) { groups[this.gid].open = false; setShared(KEY, groups); }
  }

  group() { return { ...blank(), ...(shared(KEY) ?? {})[this.gid] }; }

  edit(fn) {
    const groups = all(), g = { ...blank(), ...groups[this.gid] };
    fn(g);
    groups[this.gid] = g;
    // Forget closed groups beyond the 60 most recent.
    const closed = Object.entries(groups).filter(([, x]) => !x.open).sort((a, b) => (b[1].used ?? 0) - (a[1].used ?? 0));
    for (const [id] of closed.slice(60)) delete groups[id];
    setShared(KEY, groups);
  }

  activate() {
    if (shared(ACTIVE) !== this.gid) setShared(ACTIVE, this.gid);
    this.edit(g => { g.used = Date.now(); });
    this.claimPane = true;
  }

  command(c, cx) {
    const g = this.group(), tab = g.tabs.find(t => keyOf(t) === g.active);
    if (c === "markdown" && tab && isMarkdown(tab.path)) this.togglePreview(g.active);
    else if (c === "close" && tab) this.closeTab(g.active);
    else if (c === "split" && tab) this.split(tab);
  }

  togglePreview(k) {
    this.edit(g => { g.preview = g.preview.includes(k) ? g.preview.filter(x => x !== k) : [...g.preview, k]; });
  }

  closeTab(k) {
    this.docs.get(k)?.code?.release(); this.docs.delete(k);
    let empty = false;
    this.edit(g => {
      const i = g.tabs.findIndex(t => keyOf(t) === k);
      g.tabs = g.tabs.filter(t => keyOf(t) !== k);
      g.preview = g.preview.filter(x => x !== k);
      if (g.active === k) g.active = g.tabs.length ? keyOf(g.tabs[Math.min(i, g.tabs.length - 1)]) : null;
      empty = !g.tabs.length;
    });
    this.learnPane();
    if (empty && this.pane && panes().some(p => p.pane === this.pane)) run("pane.close", { pane: this.pane });
  }

  // Open this file in a new group to the right, like VSCode's Split Editor.
  split(tab) {
    const gid = newId(), groups = all(), k = keyOf(tab), g = this.group();
    groups[gid] = { ...blank(), tabs: [tab], active: k, preview: g.preview.includes(k) ? [k] : [], tab: g.tab ?? focused()?.tab, used: Date.now() };
    setShared(KEY, groups); setShared(ACTIVE, gid);
    run("pane.split", { direction: "right", mod: MOD, props: { group: gid }, ...(this.pane ? { pane: this.pane } : {}) });
  }

  load(tab, cx) {
    const k = keyOf(tab);
    const d = this.docs.get(k) ?? { loading: true };
    this.docs.set(k, d);
    d.loading = true;
    const fail = message => {
      d.code?.release();
      d.code = null; d.text = null; d.error = message;
    };
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(tab.path, { on: tab.on });
        if (text === null) { fail("This file is no longer available"); return; }
        if (text.includes("\0")) { fail("Binary file · no text preview"); return; }
        if (text === d.text) return;
        const t = theme(), ext = tab.path.includes(".") ? tab.path.split(".").pop() : "txt";
        d.code?.release();
        d.code = null;
        d.text = text; d.error = null;
        d.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { fail("Cannot open this file (binary, too large, or unreadable)"); }
      finally { d.loading = false; cx.notify(); }
    });
  }

  // Pick up edits made on disk to the shown file.
  reload(cx) {
    const g = this.group(), tab = g.tabs.find(t => keyOf(t) === g.active);
    if (tab && !this.docs.get(g.active)?.loading) this.load(tab, cx);
  }

  diagram(source, cx) {
    const theme_ = settings().dark === false ? "default" : "dark", id = hash(`${theme_}\n${source}`);
    let d = diagrams.get(id);
    if (!d) {
      d = { state: "pending", path: `${MERMAID_DIR}/${id}.png` };
      diagrams.set(id, d);
      cx.spawn(async cx => {
        try {
          const r = await exec("sh", ["-c", MMDC, "mermaid", source, `${appHome()}/${d.path}`, theme_]);
          const [w, h] = r.stdout.trim().split(/\s+/).map(Number);
          if (r.code !== 0 || !w || !h) throw new Error(mermaidError(r.stderr) || "mmdc failed (is @mermaid-js/mermaid-cli installed?)");
          Object.assign(d, { state: "ready", w: w / MERMAID_SCALE, h: h / MERMAID_SCALE });
        } catch (e) { Object.assign(d, { state: "error", error: String(e.message ?? e) }); }
        finally { cx.notify(); }
      });
    }
    return d;
  }

  markdownView(k, text, t, cx) {
    const room = Math.max(120, (this.width ?? 600) - 48);
    // Only the focused pane's preview takes the mouse: a drag that ends over another pane never
    // sees its mouse-up, and an unfocused preview would keep selecting on hover.
    const id = `md-${k}-${this.gen}`;
    return parts(body(text)).map((part, i) => {
      if (part.md !== undefined) return TextView.markdown(`${id}-${i}`, part.md).selectable(this.here);
      const d = this.diagram(part.mermaid, cx);
      if (d.state === "ready") {
        const s = Math.min(1, room / d.w);
        return h_flex().w_full().justify_center().py(8).child(image(d.path).w(d.w * s).h(d.h * s));
      }
      if (d.state === "pending") return div().py(8).text_size(12).text_color(t.dim).child("Rendering diagram…");
      return v_flex().py(8).gap(4)
        .child(div().text_size(12).text_color(t.ansi1).child(`Mermaid error: ${d.error}`))
        .child(TextView.markdown(`${id}-${i}-src`, "```mermaid\n" + part.mermaid + "```").selectable(this.here));
    });
  }

  iconButton(t, id, icon, title, onClick) {
    return div().id(id).p(4).rounded(4).flex_none().cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(svg(`mods/${MOD}/${icon}.svg`).size(14));
  }

  // The header's find matches for this pane: line number, then the line cut around the hit.
  findList(t) {
    const f = shared(FIND)?.[this.pane];
    if (!this.pane || !f?.matches?.length) return null;
    return v_flex().id("eg-find").flex_none().max_h(220).overflow_y_scrollbar().py(4).border_b(1).border_color(t.border)
      .bg(t.chrome).font_family(settings().font_family).text_size(12)
      .children(f.matches.map((m, i) => h_flex().id(`eg-find-${i}`).h(22).flex_none().px(10).gap(10).items_center().cursor_pointer()
        .bg(i === f.at ? t.selected : t.chrome).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { setShared(FIND, { ...shared(FIND), [this.pane]: { ...f, at: i } }); cx.notify(); })
        .child(div().w(40).flex_none().text_right().text_color(t.dim).child(String(m.n)))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_color(t.muted)
          .child(div().flex_none().child(m.parts[0]))
          .child(div().flex_none().rounded(3).bg(t.accent).text_color(t.accent_foreground).child(m.parts[1]))
          .child(div().flex_1().min_w(0).truncate().child(m.parts[2])))));
  }

  tabStrip(g, t) {
    return h_flex().id("eg-strip").h(34).flex_none().bg(t.chrome).border_b(1).border_color(t.border).items_center()
      .child(h_flex().id("eg-tabs").flex_1().min_w(0).h_full().overflow_x_scroll().children(g.tabs.map((tab, i) => {
        const k = keyOf(tab), on = k === g.active;
        return h_flex().id(`eg-tab-${i}`).h_full().flex_none().pl(10).pr(4).gap(6).items_center().cursor_pointer()
          .border_r(1).border_color(t.border).text_size(12)
          .bg(on ? t.background : t.chrome).text_color(on ? t.foreground : t.muted)
          .when(on, el => el.border_t(1).border_color(t.accent))
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.activate(); this.edit(x => { x.active = k; }); cx.notify(); })
          .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.closeTab(k); cx.notify(); })
          .child(svg(`mods/${MOD}/${g.preview.includes(k) ? "preview" : "file"}.svg`).size(13).flex_none().text_color(t.dim))
          .child(div().max_w(220).truncate().child(nameOf(tab.path)))
          .child(div().id(`eg-close-${i}`).p(3).rounded(4).flex_none().text_color(on ? t.muted : t.dim)
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(k); cx.notify(); })
            .child(svg(`mods/${MOD}/close.svg`).size(12)));
      })))
      .child(h_flex().flex_none().px(6).gap(2).items_center()
        .when(isMarkdown(g.tabs.find(x => keyOf(x) === g.active)?.path), el => el.child(
          this.iconButton(t, "eg-md", g.preview.includes(g.active) ? "source" : "preview",
            "Toggle preview (⌘⇧V)", () => { this.activate(); this.togglePreview(g.active); })))
        .when(Boolean(g.active), el => el.child(this.iconButton(t, "eg-split", "split", "Split right (⌘\\)",
          () => { this.activate(); const tab = g.tabs.find(x => keyOf(x) === g.active); if (tab) this.split(tab); }))));
  }

  render(cx) {
    // Our pane id isn't a prop; learn it from focus right after we were clicked or created,
    // unless another open group already owns the focused pane.
    if (this.claimPane || this.handle.is_focused()) {
      const f = focused()?.pane, p = f && panes().find(x => x.pane === f);
      const taken = Object.entries(shared(KEY) ?? {}).some(([id, x]) => id !== this.gid && x.open && x.pane === f);
      if (p?.mod === MOD && !taken) {
        this.claimPane = false;
        if (this.pane !== f) { this.pane = f; this.edit(g => { g.pane = f; }); }
      }
    }
    if (!this.pane) this.learnPane();
    const here = this.pane ? focused()?.pane === this.pane : this.handle.is_focused();
    if (this.here && !here) this.gen++;
    this.here = here;
    const t = theme(), g = this.group(), tab = g.tabs.find(x => keyOf(x) === g.active);
    const k = tab ? keyOf(tab) : null, d = k ? this.docs.get(k) : null;
    if (tab && !d) this.load(tab, cx);
    const h = home(), rel = tab ? (tab.on ? `${tab.on}:` : "") + (tab.path.startsWith(h + "/") ? "~" + tab.path.slice(h.length) : tab.path) : "";
    const preview = k && g.preview.includes(k) && d?.text != null;

    return v_flex().id("eg").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.activate())
      .child(this.tabStrip(g, t))
      .when(Boolean(tab), el => el.child(h_flex().h(24).flex_none().px(12).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(rel))))
      .when(Boolean(this.findList(t)), el => el.child(this.findList(t)))
      .child(!tab
        ? v_flex().flex_1().items_center().justify_center().text_color(t.dim).child("No open files · pick one in Files")
        : preview
          ? v_flex().id(`eg-md-${k}`).flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16).text_size(14).font_family(PREVIEW_FONT)
              .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
              .children(this.markdownView(k, d.text, t, cx))
          : d?.code ? Editor.new(d.code).flex_1().min_h(0)
          : div().p(12).text_color(t.dim).child(d?.error || "Loading file…"));
  }
}
