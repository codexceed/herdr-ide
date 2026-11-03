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
// Milliseconds of ranking per task resumption. A path costs ~30 µs in Herdr, or much more for
// long paths and many-word queries, so batches end on time, not on a count: well under a
// task's 500 ms limit, and under a render's 50 ms too.
const BATCH_MS = 20;
// Above this many cells (query letters × path length) one alignment is a greedy match instead.
const MAX_CELLS = 32768;

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

// The file-looking words in terminal text, newest (last) first, without a sentence's period.
// Only the ones that exist survive, so loose matches cost nothing.
// - bare: letters in any script, digits, `[id]`-style brackets and shell-escaped spaces (`a\ b`);
// - quoted or backticked: the whole span, so `path with space/notes.md` stays one path.
// `:line:col` is cut by the bare pattern and by resolve() for quoted spans.
const WORD = String.raw`(?:[\p{L}\p{N}\p{M}_@+.%\[\]-]|\\ )+`;
const PATHISH = new RegExp(String.raw`(?:file://)?(?:~/|\.\.?/|/)?${WORD}(?:/${WORD})*`, "gu");
// One pattern per quote pair, so an apostrophe in prose can't swallow a backticked path.
// Each excludes only its own closer, so `John's Project/notes.md` stays whole.
const QUOTED = ["``", '""', "''", "“”", "‘’"].map(([open, close]) => new RegExp(`${open}([^${close}\\n]{1,1024})${close}`, "gu"));
const EXT = /\.[\p{L}\p{N}]{1,10}(?::\d+){0,2}$/u;
// One raw match -> the candidates to try: itself, then without wrapping brackets.
function candidates(raw) {
  let p = raw.trim();
  if (p.startsWith("file://")) { try { p = decodeURIComponent(p.slice(7)); } catch { return []; } }
  p = p.replace(/\\ /g, " ").replace(/[.,;]+$/, "");
  const out = [p];
  const bare = p.replace(/^[[(<]+/, "").replace(/[\])>]+$/, "");
  if (bare !== p) out.push(bare);
  // A path has a folder or an extension; "e.g" and "v0.1" fail the existence check later.
  return out.filter(c => c && c !== "/" && c !== "~/" && (c.includes("/") || EXT.test(c)));
}
const pathsIn = text => {
  const seen = new Set(), out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < CANDIDATES; i--) {
    const line = lines[i], found = [];
    for (const re of QUOTED) for (const m of line.matchAll(re)) found.push([m.index + m[0].length, m[1]]);
    for (const m of line.matchAll(PATHISH)) found.push([m.index + m[0].length, m[0]]);
    // The one ending rightmost first; a quoted span before the bare words inside it.
    found.sort((a, b) => b[0] - a[0] || b[1].length - a[1].length);
    for (const [, raw] of found) {
      for (const p of candidates(raw)) {
        if (seen.has(p) || out.length >= CANDIDATES) continue;
        seen.add(p); out.push(p);
      }
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

// Best alignment of one term in `text` (`t` is it lowercased): { score, hits } or null when it
// isn't a subsequence. The score table is one flat buffer reused across calls; a path costs
// ~30 µs in Herdr's QuickJS, so allocation matters.
const NEG = -1e9;
let table = new Float64Array(1024), back = new Int32Array(1024);
function align(term, text, t = text.toLowerCase()) {
  const n = t.length, m = term.length;
  // Fast reject; `first` is the leftmost greedy match.
  const first = [];
  for (let i = 0, j = 0; ; i++) {
    if (j === m) break;
    if (i === n) return null;
    if (t[i] === term[j]) { first.push(i); j++; }
  }
  if (m * n > MAX_CELLS) return greedy(text, first);
  if (table.length < m * n) { table = new Float64Array(m * n * 2); back = new Int32Array(m * n * 2); }
  const M = table;
  M.fill(NEG, 0, m * n);
  const base = text.lastIndexOf("/") + 1;
  for (let j = 0; j < m; j++) {
    const row = j * n, prev = row - n, c = term[j];
    let gap = NEG, gapAt = -1;
    for (let i = j; i < n; i++) {
      // gap: best earlier match of term[j-1] ending at k <= i-2, minus 3 to open and 1 per char.
      if (j > 0) { if (i >= 2 && M[prev + i - 2] - 3 > gap - 1) { gap = M[prev + i - 2] - 3; gapAt = i - 2; } else gap -= 1; }
      if (t[i] !== c) continue;
      const own = 16 + bonus(text, i, base);
      if (j === 0) { M[i] = own; continue; }
      const run = M[prev + i - 1] > NEG ? M[prev + i - 1] + 4 : NEG;
      if (run >= gap && run > NEG) { M[row + i] = own + run; back[row + i] = i - 1; }
      else if (gap > NEG / 2) { M[row + i] = own + gap; back[row + i] = gapAt; }
    }
  }
  const last = (m - 1) * n;
  let end = -1, score = NEG;
  for (let i = 0; i < n; i++) if (M[last + i] > score) { score = M[last + i]; end = i; }
  if (end < 0) return null;
  const hits = [];
  for (let j = m - 1, i = end; j >= 0; i = back[j * n + i], j--) hits.push(i);
  return { score, hits: hits.reverse() };
}

// A huge alignment's stand-in: the leftmost match, scored like align() without the search.
function greedy(text, hits) {
  const base = text.lastIndexOf("/") + 1;
  let score = 0;
  hits.forEach((i, k) => {
    score += 16 + bonus(text, i, base);
    if (k) score += i === hits[k - 1] + 1 ? 4 : -3 - (i - hits[k - 1] - 2);
  });
  return { score, hits };
}

const termsOf = query => query.toLowerCase().split(/\s+/).filter(Boolean);

// Space-separated terms must all match (any order), like VS Code. Shorter file names, then
// shorter paths, win ties: "main" ranks main.js over MAINTAINERS.
function scoreTerms(terms, text, lower) {
  let total = -0.3 * (text.length - text.lastIndexOf("/") - 1) - 0.02 * text.length;
  const hits = new Set();
  for (const term of terms) {
    const a = align(term, text, lower);
    if (!a) return null;
    total += a.score;
    a.hits.forEach(h => hits.add(h));
  }
  return { score: total, hits: [...hits].sort((a, b) => a - b) };
}
const score = (query, text) => scoreTerms(termsOf(query), text, text.toLowerCase());

const better = (a, b) => b.score - a.score || a.path.length - b.path.length;

// Scores items from `from` ({ path, boost? }) into `top` (best first, at most `limit`) and
// collects every match into `matched`, until the list ends or the clock passes `until`
// (at least one item either way). Returns where it stopped, for the next batch.
function rankInto(terms, items, from, top, matched = null, until = Infinity, limit = SHOWN) {
  const floor = top.length >= limit ? top[top.length - 1].score : -Infinity;
  let added = false, i = from;
  for (; i < items.length; i++) {
    if (i > from && Date.now() > until) break;
    const item = items[i];
    const s = scoreTerms(terms, item.path, item.lower ??= item.path.toLowerCase());
    if (!s) continue;
    matched?.push(item);
    const total = s.score + (item.boost ?? 0);
    if (total < floor) continue;
    top.push({ ...item, score: total, hits: s.hits });
    added = true;
  }
  if (added) { top.sort(better); top.length = Math.min(top.length, limit); }
  return i;
}

// Items that match, best first; ties go to the shorter path.
function rank(query, items, limit = SHOWN) {
  const top = [];
  rankInto(termsOf(query), items, 0, top, null, Infinity, limit);
  return top;
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
  // Each terminal keeps its own folder: a relative path it printed is relative to it.
  return { cwd, on: space?.machine ?? null, tab, pane: mine?.pane ?? null, terminals: terminals.map(p => ({ terminal: p.terminal, cwd: p.cwd || cwd })) };
}

const typed = q => q.startsWith("/") || q.startsWith("~");

export default class Open extends View {
  init(_props, cx) {
    this.ctx = context();
    this.root = null; this.files = null; this.printed = []; this.error = null; this.notice = null;
    this.query = ""; this.at = 0; this.top = 0;
    this.gen = 0; this.found = null; this.last = null; this.enter = false;
    this.input = InputState.new({ placeholder: "Go to file, or type a path (/… or ~/…)" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value(); this.at = 0; this.top = 0; this.notice = null; this.enter = false;
      this.search(cx); cx.notify();
    });
    // Enter before the ranking for this query finished: open its best file once it has.
    this.input.on("submit", (_e, cx) => { if (this.settled()) this.pick(this.rows()[this.at], cx); else this.enter = true; });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async cx => { await this.list(); this.search(cx); cx.notify(); });
    cx.spawn(async cx => { await this.scan(); this.search(cx); cx.notify(); });
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
    const { on, terminals } = this.ctx, h = home();
    const found = [];
    for (const { terminal, cwd } of terminals) {
      const r = await hc(["read", terminal, "--lines", String(HISTORY)]).catch(() => null);
      if (r?.code === 0) found.push(...pathsIn(r.stdout).map(w => resolve(w, cwd, h)));
    }
    const wanted = [...new Set(found)].slice(0, CANDIDATES);
    if (!wanted.length) return;
    const r = await exec("sh", ["-c", 'for p; do [ -f "$p" ] && printf "%s\\0" "$p"; done; true', "exists", ...wanted], { on }).catch(() => null);
    const there = new Set((r?.stdout ?? "").split("\0").filter(Boolean));
    this.printed = wanted.filter(p => there.has(p));
  }

  recent() {
    const { on } = this.ctx;
    return (shared(RECENT) ?? []).filter(x => (x.on ?? null) === on && !this.printed.includes(x.path)).map(x => x.path);
  }

  // Which listing a search ran over; it changes as the listing and the terminal scan land.
  key() { return `${this.root}|${this.files?.length}|${this.printed.length}`; }

  // Printed, then recent: at most a few hundred, cheap enough for render.
  first() {
    const key = this.key();
    if (this.firstMemo?.key !== key) {
      const h = home(), root = this.root;
      const item = (abs, tag, boost) => ({ abs, path: display(abs, root, h), tag, boost });
      this.firstMemo = { key, rows: [...this.printed.map(p => item(p, "terminal", 12)), ...this.recent().map(p => item(p, "recent", 6))] };
    }
    return this.firstMemo.rows;
  }

  // Everything a query searches: first(), then the root's other files. Built in a task only.
  pool() {
    const key = this.key();
    if (this.poolMemo?.key !== key) {
      const first = this.first(), known = new Set(first.map(x => x.abs)), all = [...first];
      for (const p of this.files ?? []) {
        const abs = `${this.root}/${p}`;
        if (!known.has(abs)) all.push({ abs, path: p, tag: null });
      }
      this.poolMemo = { key, all };
    }
    return this.poolMemo;
  }

  // Ranks the query off the render path. Herdr stops a render after 50 ms and each task
  // resumption after 500 ms, and 50,000 paths take seconds, so the work goes in batches of
  // BATCH_MS with a yield between them. Results show as they improve; a newer query abandons the old one.
  // A query that extends the last finished one only re-ranks that one's matches.
  search(cx) {
    const gen = ++this.gen, q = this.query.trim();
    if (!q || typed(q)) return;
    cx.spawn(async cx => {
      const pool = this.pool(), terms = termsOf(q);
      const narrow = this.last?.key === pool.key && q.toLowerCase().startsWith(this.last.q);
      const items = narrow ? this.last.matched : pool.all;
      const top = [], matched = [];
      let shown = 0;
      for (let i = 0; i < items.length;) {
        if (i) { await cx.sleep(0); if (gen !== this.gen) return; }
        i = rankInto(terms, items, i, top, matched, Date.now() + BATCH_MS);
        if (Date.now() - shown > 80) { this.found = { q, key: pool.key, rows: top.slice(), done: false }; shown = Date.now(); cx.notify(); }
      }
      if (gen !== this.gen) return;
      this.found = { q, key: pool.key, rows: top, done: true };
      this.last = { key: pool.key, q: q.toLowerCase(), matched };
      if (this.enter && this.settled()) { this.enter = false; this.pick(top[this.at], cx); }
      cx.notify();
    });
  }

  // Whether rows() is final for the query: ranked to the end, over the full listing.
  settled() {
    const q = this.query.trim();
    return !q || typed(q) || (this.files !== null && this.found?.q === q && this.found.done && this.found.key === this.key());
  }

  // Rows: { abs, path (as shown), hits, tag }. Cheap lists here; a query's come from search().
  rows() {
    const q = this.query.trim(), h = home(), root = this.root;
    if (typed(q)) {
      const abs = resolve(q, this.ctx.cwd, h);
      return [{ abs, path: display(abs, root, h), hits: [], tag: "path", typed: true }];
    }
    if (!q) return this.first().slice(0, SHOWN).map(x => ({ ...x, hits: [] }));
    return this.found?.rows ?? [];
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
    if (typed(q)) return "Enter opens this path";
    if (this.files === null) return `Listing ${where}…`;
    if (!q) return rows.length ? `${this.files.length.toLocaleString()} files in ${where}` : `Type to search ${this.files.length.toLocaleString()} files in ${where}`;
    if (!this.settled()) return `Searching ${where}…`;
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
