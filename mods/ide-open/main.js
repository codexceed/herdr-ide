// Go to a file (cmd-p), like VS Code's Quick Open. A popup at the top of the window:
// - type to fuzzy-find a file in the focused terminal's git repo (else its folder, else the space's);
// - with no query: files the tab's terminals printed (newest first), then recently opened ones,
//   so cmd-p, Enter opens what an agent just mentioned (Herdr gives mods no Cmd-click, #228);
// - a query starting with / or ~ opens that path, inside the repo or not.
// Enter opens the file the way a Files click does: a tab in the tab's editor group, or a new
// editor pane split to the right.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, hc, home, theme, shared, setShared, run, props, closeOverlay } from "herdr";

const GROUPS = "ide-editor.groups", ACTIVE = "ide-editor.active", RECENT = "ide-open.recent";
const MAX_FILES = 50000, SHOWN = 60, ROWS = 12, ROW = 30, HISTORY = 2000, CANDIDATES = 300;

// ---- paths

// "/a/./b/../c" -> "/a/c"
const normalize = p => {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return "/" + out.join("/");
};

// A path as the list shows it: relative inside the root, ~/… under home, else absolute.
const display = (abs, root, h) =>
  root && abs.startsWith(root + "/") ? abs.slice(root.length + 1)
    : h && abs.startsWith(h + "/") ? "~" + abs.slice(h.length) : abs;

// The file-looking words in terminal text, newest (last) first, without `:line:col` or a
// sentence's period. Only the ones that exist survive, so loose matches cost nothing.
const PATHISH = /(?:file:\/\/)?(?:~\/|\.\.?\/|\/)?[\w@+.%-]+(?:\/[\w@+.%-]+)*/g;
const pathsIn = text => {
  const seen = new Set(), out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < CANDIDATES; i--) {
    const found = [...lines[i].matchAll(PATHISH)].map(m => m[0]).reverse();
    for (let p of found) {
      if (p.startsWith("file://")) { try { p = decodeURIComponent(p.slice(7)); } catch { continue; } }
      p = p.replace(/[.]+$/, "");
      // A path has a folder or an extension; "e.g" and "v0.1" fail the existence check later.
      if (!p.includes("/") && !/\.[A-Za-z0-9]{1,10}$/.test(p)) continue;
      if (p === "/" || p === "~/" || seen.has(p)) continue;
      seen.add(p); out.push(p);
      if (out.length >= CANDIDATES) break;
    }
  }
  return out;
};

// Resolves a typed or printed path against home and a folder.
const resolve = (p, cwd, h) => {
  p = p.replace(/(?::\d+){1,2}$/, "");
  if (p === "~") return h;
  if (p.startsWith("~/")) return normalize(h + p.slice(1));
  return normalize(p.startsWith("/") ? p : `${cwd}/${p}`);
};

// ---- fuzzy matching (fzf-style: word starts, the file name and runs of letters score)

const isSep = c => c === "/" || c === "-" || c === "_" || c === "." || c === " ";
function bonus(text, i, base) {
  let b = i >= base ? 6 : 0;
  if (i === 0 || text[i - 1] === "/") return b + 10;
  if (isSep(text[i - 1])) return b + 8;
  if (text[i - 1] === text[i - 1].toLowerCase() && text[i] !== text[i].toLowerCase()) return b + 7;
  return b;
}

// Best alignment of one term in `text`: { score, hits } or null when it isn't a subsequence.
function align(term, text) {
  const t = text.toLowerCase(), n = t.length, m = term.length;
  // Fast reject.
  for (let i = 0, j = 0; ; i++) {
    if (j === m) break;
    if (i === n) return null;
    if (t[i] === term[j]) j++;
  }
  const base = text.lastIndexOf("/") + 1, NEG = -1e9;
  const M = Array.from({ length: m }, () => new Float64Array(n).fill(NEG));
  const from = Array.from({ length: m }, () => new Int32Array(n).fill(-1));
  for (let j = 0; j < m; j++) {
    let gap = NEG, gapAt = -1;
    for (let i = j; i < n; i++) {
      // gap: best earlier match of term[j-1] ending at k <= i-2, minus 3 to open and 1 per char.
      if (j > 0 && i >= 2 && M[j - 1][i - 2] - 3 > gap - 1) { gap = M[j - 1][i - 2] - 3; gapAt = i - 2; } else gap -= 1;
      if (t[i] !== term[j]) continue;
      const own = 16 + bonus(text, i, base);
      if (j === 0) { M[0][i] = own; continue; }
      const run = M[j - 1][i - 1] > NEG ? M[j - 1][i - 1] + 4 : NEG;
      if (run >= gap && run > NEG) { M[j][i] = own + run; from[j][i] = i - 1; }
      else if (gap > NEG / 2) { M[j][i] = own + gap; from[j][i] = gapAt; }
    }
  }
  let end = -1, score = NEG;
  for (let i = 0; i < n; i++) if (M[m - 1][i] > score) { score = M[m - 1][i]; end = i; }
  if (end < 0) return null;
  const hits = [];
  for (let j = m - 1, i = end; j >= 0; i = from[j][i], j--) hits.push(i);
  return { score, hits: hits.reverse() };
}

// Space-separated terms must all match (any order), like VS Code. Shorter file names, then
// shorter paths, win ties: "main" ranks main.js over MAINTAINERS.
function score(query, text) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let total = -0.3 * (text.length - text.lastIndexOf("/") - 1) - 0.02 * text.length;
  const hits = new Set();
  for (const term of terms) {
    const a = align(term, text);
    if (!a) return null;
    total += a.score;
    a.hits.forEach(h => hits.add(h));
  }
  return { score: total, hits: [...hits].sort((a, b) => a - b) };
}

// Items ({ path, ... }) that match, best first; ties go to the shorter path.
function rank(query, items, limit = SHOWN) {
  const out = [];
  for (const item of items) {
    const s = score(query, item.path);
    if (s) out.push({ ...item, score: s.score + (item.boost ?? 0), hits: s.hits });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

// ---- opening (the same as a Files click: mods/ide-files openFile)

function openFile(path, on, tab, pane) {
  const groups = JSON.parse(JSON.stringify(shared(GROUPS) ?? {}));
  const here = Object.entries(groups).filter(([, g]) => g.open && g.tab === tab).sort((a, b) => (b[1].used ?? 0) - (a[1].used ?? 0));
  let gid = shared(ACTIVE);
  if (!here.some(([id]) => id === gid)) gid = here[0]?.[0];
  const fresh = !gid;
  if (fresh) gid = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const g = groups[gid] ??= { tabs: [], active: null, preview: [], open: false, tab };
  const k = `${on ?? ""}:${path}`;
  if (!g.tabs.some(t => `${t.on ?? ""}:${t.path}` === k)) {
    const i = g.tabs.findIndex(t => `${t.on ?? ""}:${t.path}` === g.active);
    g.tabs.splice(i < 0 ? g.tabs.length : i + 1, 0, { path, on: on ?? null });
  }
  g.active = k; g.used = Date.now();
  setShared(GROUPS, groups); setShared(ACTIVE, gid);
  if (fresh) run("pane.split", { direction: "right", ...(pane ? { pane } : {}), mod: "ide-editor", props: { group: gid, seed: { tabs: [{ path, on: on ?? null }], active: k } } });
  else if (groups[gid].pane) run("pane.focus", { pane: groups[gid].pane });
}

// ---- where cmd-p was pressed

function context() {
  const space = spaces().find(s => s.active), f = focused();
  const all = panes(), mine = f?.pane ? all.find(p => p.pane === f.pane) : null;
  const tab = mine?.tab ?? f?.tab;
  const terminals = all.filter(p => p.tab === tab && p.terminal);
  // The focused terminal first, then the tab's others (an editor pane has no folder).
  terminals.sort((a, b) => (b.pane === mine?.pane) - (a.pane === mine?.pane));
  const cwd = (mine?.terminal && mine.cwd) || terminals.find(p => p.cwd)?.cwd || f?.cwd || space?.folder || home();
  return { cwd, on: space?.machine ?? null, tab, pane: mine?.pane ?? null, terminals: terminals.map(p => p.terminal) };
}

export default class Open extends View {
  init(_props, cx) {
    this.ctx = context();
    this.root = null; this.files = null; this.printed = []; this.error = null; this.notice = null;
    this.query = ""; this.at = 0; this.top = 0;
    this.input = InputState.new({ placeholder: "Go to file, or type a path (/… or ~/…)" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; this.top = 0; this.notice = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.rows()[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async cx => { await this.list(); cx.notify(); });
    cx.spawn(async cx => { await this.scan(); cx.notify(); });
  }

  close() { closeOverlay(props().overlay); }

  // The root and its files: git's (tracked and untracked, not ignored), else rg's or find's.
  async list() {
    const { cwd, on } = this.ctx;
    try {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      if (top?.code === 0 && top.stdout.trim()) {
        this.root = top.stdout.trim();
        const r = await exec("git", ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: this.root, on });
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git ls-files failed");
        this.files = [...new Set(r.stdout.split("\0").filter(Boolean))].slice(0, MAX_FILES);
      } else {
        this.root = cwd;
        const script = `if command -v rg >/dev/null 2>&1; then rg --files --hidden --glob '!.git' 2>/dev/null; else find . -name .git -prune -o -name node_modules -prune -o -type f -print 2>/dev/null | sed 's|^\\./||'; fi | head -n ${MAX_FILES}`;
        const r = await exec("sh", ["-c", script], { cwd, on });
        this.files = r.stdout.split("\n").filter(Boolean);
      }
    } catch (e) {
      this.error = String(e.message ?? e); this.files ??= [];
    }
  }

  // Files the tab's terminals printed that exist, newest first (focused terminal first).
  async scan() {
    const { cwd, on, terminals } = this.ctx, h = home();
    const words = [];
    for (const t of terminals) {
      const r = await hc(["read", t, "--lines", String(HISTORY)]).catch(() => null);
      if (r?.code === 0) words.push(...pathsIn(r.stdout));
    }
    const wanted = [...new Set(words.map(w => resolve(w, cwd, h)))].slice(0, CANDIDATES);
    if (!wanted.length) return;
    const r = await exec("sh", ["-c", 'for p; do [ -f "$p" ] && printf "%s\\0" "$p"; done; true', "exists", ...wanted], { on }).catch(() => null);
    const there = new Set((r?.stdout ?? "").split("\0").filter(Boolean));
    this.printed = wanted.filter(p => there.has(p));
  }

  recent() {
    const { on } = this.ctx;
    return (shared(RECENT) ?? []).filter(x => (x.on ?? null) === on && !this.printed.includes(x.path)).map(x => x.path);
  }

  // Rows: { abs, path (as shown), hits, tag }. Ranking 50k paths is too slow for every frame.
  rows() {
    const key = JSON.stringify([this.query, this.root, this.files?.length, this.printed.length, (shared(RECENT) ?? []).length]);
    if (this.memo?.key !== key) this.memo = { key, rows: this.compute() };
    return this.memo.rows;
  }

  compute() {
    const q = this.query.trim(), h = home(), root = this.root;
    const item = (abs, tag, boost = 0) => ({ abs, path: display(abs, root, h), tag, boost });
    if (q.startsWith("/") || q.startsWith("~")) {
      const abs = resolve(q, this.ctx.cwd, h);
      return [{ abs, path: display(abs, root, h), hits: [], tag: "path", typed: true }];
    }
    const printed = this.printed.map(p => item(p, "terminal", 12));
    const recent = this.recent().map(p => item(p, "recent", 6));
    if (!q) return [...printed, ...recent].slice(0, SHOWN).map(x => ({ ...x, hits: [] }));
    const known = new Set([...printed, ...recent].map(x => x.abs));
    const files = (this.files ?? []).map(p => ({ abs: `${root}/${p}`, path: p, tag: null })).filter(x => !known.has(x.abs));
    return rank(q, [...printed, ...recent, ...files]);
  }

  pick(row, cx) {
    cx.spawn(async cx => { await this.go(row); cx.notify(); });
  }

  async go(row) {
    if (!row) return;
    const { on, tab, pane } = this.ctx;
    if (row.typed) {
      const r = await exec("sh", ["-c", 'if [ -d "$1" ]; then echo dir; elif [ -f "$1" ]; then echo file; fi', "kind", row.abs], { on }).catch(() => null);
      const kind = r?.stdout.trim();
      if (kind !== "file") { this.notice = kind === "dir" ? `${row.path} is a folder` : `No file at ${row.path}`; return; }
    }
    const recent = [{ path: row.abs, on }, ...(shared(RECENT) ?? []).filter(x => !(x.path === row.abs && (x.on ?? null) === on))].slice(0, 30);
    setShared(RECENT, recent);
    this.close();
    openFile(row.abs, on, tab, pane);
  }

  highlighted(t, text, offset, hits, color, el) {
    // Runs of matched / unmatched characters.
    let run = "", lit = false;
    const flush = () => {
      if (!run) return;
      el = el.child(div().flex_none().when(lit, d => d.text_color(t.accent).font_semibold()).when(!lit, d => d.text_color(color)).child(run));
      run = "";
    };
    for (let i = 0; i < text.length; i++) {
      const on = hits.has(offset + i);
      if (on !== lit) { flush(); lit = on; }
      run += text[i];
    }
    flush();
    return el;
  }

  row(t, r, i) {
    const cut = r.path.lastIndexOf("/") + 1, hits = new Set(r.hits ?? []);
    const name = r.path.slice(cut), dir = r.path.slice(0, Math.max(0, cut - 1));
    const sel = i === this.at;
    return h_flex()
      .id(`io-${i}`)
      .h(ROW).flex_none().mx(4).px(10).gap(8).items_center().rounded(6)
      .cursor_pointer()
      .when(sel, el => el.bg(t.hover))
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; this.pick(r, cx); })
      .child(svg(r.typed ? "mods/ide-pane/search.svg" : "mods/ide-files/file.svg").size(13).flex_none().text_color(t.dim))
      .child(this.highlighted(t, name, cut, hits, t.foreground, h_flex().flex_none().max_w(320).overflow_hidden()))
      .child(this.highlighted(t, dir, 0, hits, t.dim, h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(11.5)))
      .when(Boolean(r.tag) && !r.typed, el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.tag)));
  }

  status(rows) {
    const q = this.query.trim(), where = this.root ? display(this.root, null, home()) : "…";
    if (this.notice) return this.notice;
    if (this.error) return this.error;
    if (q.startsWith("/") || q.startsWith("~")) return "Enter opens this path";
    if (this.files === null) return `Listing ${where}…`;
    if (!q) return rows.length ? `${this.files.length.toLocaleString()} files in ${where}` : `Type to search ${this.files.length.toLocaleString()} files in ${where}`;
    return rows.length ? `${where}` : `No files match in ${where}`;
  }

  render() {
    const t = theme(), rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    if (this.at < this.top) this.top = this.at;
    if (this.at >= this.top + ROWS) this.top = this.at - ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - ROWS)));
    const shown = rows.slice(this.top, this.top + ROWS);
    const q = this.query.trim();
    const section = !q && rows.length ? (rows[this.top]?.tag === "terminal" ? "Printed in this tab's terminals" : "Recently opened") : null;
    return v_flex()
      .id("ide-open")
      .w_full().min_h(0).p(12).gap(8)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "down" && rows.length) this.at = (this.at + 1) % rows.length;
        else if (e.key === "up" && rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/ide-pane/search.svg").size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(section), el => el.child(div().px(10).text_size(11).font_semibold().text_color(t.dim).child(section)))
      .child(v_flex()
        .id("io-list")
        .h(Math.max(ROW, Math.min(ROWS, rows.length) * ROW))
        .flex_none()
        .overflow_hidden()
        .on_scroll_wheel((e, cx) => {
          const step = e.delta.y < 0 ? 1 : e.delta.y > 0 ? -1 : 0;
          this.at = Math.max(0, Math.min(rows.length - 1, this.at + step));
          cx.notify();
        })
        .children(shown.map((r, i) => this.row(t, r, this.top + i))))
      .child(h_flex().px(10).gap(8).text_size(11).text_color(this.notice || this.error ? t.ansi1 : t.dim)
        .child(div().flex_1().truncate().child(this.status(rows)))
        .child(div().flex_none().text_color(t.dim).child("↑↓  Enter  Esc")));
  }
}
