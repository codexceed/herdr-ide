// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.
// ide-agents: Claude Code / Codex in-process subagents (swarm.py) show as children too.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, appHome, hc, commands, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
// Where a space is now (as the spaces mod decides): its first terminal's live folder, else where it was made.
function placeOf(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return JSON.stringify([s.machine ?? null, ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null]);
}
const baseName = (path) => path.replace(/\/+$/, "").split("/").pop();

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const SWARM = { working: "working", waiting: "idle", error: "blocked", stopped: "idle", done: "idle" };
const kidStatus = (k, listed) => {
  if (k.swarm) return SWARM[k.status] ?? "idle";
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

// Agent colors picked from a row's right-click menu, one per agent session (so agents sharing
// a tab can differ), kept as a herdr-core label on its terminal: `herdr-ide.color=#rrggbb`.
// Like Herdr's own pins (`herdr.pinned`), the label follows the session across pane moves and
// Herdr clients and ends with it. The pane's header (ide-pane) shows the same color. Every row
// has a border: soft white, or its color at half strength. The focused row stands out from all of them: full-strength border, a tinted
// fill and a halo (two soft rings of the same color). Each swatch stands out on a dark
// sidebar (>= 3:1) and keeps white and gray text readable on its tint
// (tests/agents.test.cjs checks both).
export const LABEL = "herdr-ide.color";
const LEGACY = ["ide-agents.tab-colors", "ide-agents.pane-colors"]; // shared state before labels

// An agent's color from its terminal's labels: a swatch, else null (a hand-set label that isn't
// one of SWATCHES is ignored, so every color shown keeps the contrast the tests promise).
export function colorFrom(labels) {
  const hex = labels?.[LABEL];
  return SWATCHES.some(s => s.hex === hex) ? hex : null;
}

// Labels to write for colors kept in shared state before (v0.7: by tab; then by pane):
// [[terminal, hex]] for agents that have none yet. A pane's color beats its tab's.
export function legacyLabels(agents, tabColors, paneColors, labelsOf) {
  return agents.filter(a => !colorFrom(labelsOf(a.address)))
    .map(a => [a.address, paneColors?.[a.pane] ?? tabColors?.[a.tab]])
    .filter(([, hex]) => SWATCHES.some(s => s.hex === hex));
}

// The shared-state colors still to move: an entry goes only once at least one of its agents is
// listed and every listed one has its label (`labeled(agent)`). A failed write, or an agent not
// listed yet (its machine away), keeps the entry for the next try. Returns [tabColors, paneColors],
// null when empty. Tab and pane ids aren't reused, so an entry for a closed one is inert.
export function unmovedLegacy(tabColors, paneColors, agents, labeled) {
  const keep = (colors, key) => {
    const left = Object.fromEntries(Object.entries(colors ?? {}).filter(([id]) => {
      const mine = agents.filter(a => a[key] === id);
      return !mine.length || !mine.every(labeled);
    }));
    return Object.keys(left).length ? left : null;
  };
  return [keep(tabColors, "tab"), keep(paneColors, "pane")];
}
const RETRY = 30000; // ms between tries to move colors that didn't make it

export const SWATCHES = [
  { name: "Red", hex: "#e06c75" }, { name: "Orange", hex: "#e5904f" }, { name: "Amber", hex: "#d9b44a" },
  { name: "Green", hex: "#5fb878" }, { name: "Teal", hex: "#3fb5a8" }, { name: "Blue", hex: "#5b9cf0" },
  { name: "Violet", hex: "#9a86f0" }, { name: "Pink", hex: "#d97bb0" }, { name: "Slate", hex: "#8b95a5" },
];
export const TINT = "24"; // the focused row's tint: the color at 0x24 / 255 ≈ 14%
const PLAIN = "#ffffff"; // a row without a color
const QUIET = { [PLAIN]: "4d", other: "80" }; // an unfocused row's border alpha: 30% white, 50% color
const HALO = ["40", "1a"]; // the focused row's rings, inner then outer: 25% and 10%
const GAP = 2; // px above and below each row
const quiet = hex => hex + (QUIET[hex] ?? QUIET.other);

// `a` and `b` (#rrggbb) mixed: t = 0 is a, 1 is b. Opaque, so a halo behind it can't show through.
export function mix(a, b, t) {
  const c = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [c(a), c(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

// The colors map with `tab` set to `hex` (null clears it), keeping only live tabs and swatch colors.
// Agents that share one screen: runs of neighbours in the same tab (agents() lists them in
// space, tab, pane order). A run of two or more is drawn inside one dashed box.
export function byTab(members) {
  const runs = [];
  for (const a of members) {
    if (runs.length && a.tab && runs.at(-1)[0].tab === a.tab) runs.at(-1).push(a);
    else runs.push([a]);
  }
  return runs;
}
// The list's right padding: the scrollbar is drawn over the content, so rows end before it.
const SCROLLBAR = 18;


function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu || props()?.tabMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // Subagents running inside Claude Code / Codex sessions: { address: [child] }.
    this.swarm = {};
    this.swarmJson = "{}";
    this.pollSwarm(cx);
    cx.timer.every(3000, (cx) => this.pollSwarm(cx));
    // Each place's repo, to nest worktree spaces under their repo: { place: {repo, name, linked} | null }.
    this.repos = {};
    this.asking = new Set();
    cx.timer.every(30000, (cx) => { this.repos = {}; cx.notify(); });
  }

  // A space's repo (the git common dir) and whether it's a linked worktree, asked once per place.
  repoOf(space, ps, cx) {
    const key = placeOf(space, ps);
    if (key in this.repos) return this.repos[key];
    if (!this.asking.has(key)) {
      this.asking.add(key);
      const [on, cwd] = JSON.parse(key);
      cx.spawn(async (cx) => {
        try {
          if (!cwd) throw new Error("no folder");
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
          if (top.code !== 0 || common.code !== 0) throw new Error("not a repo");
          // The checked-out branch, or the short commit when detached.
          const ref = await exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, on });
          const sha = ref.code === 0 ? null : await exec("git", ["rev-parse", "--short", "HEAD"], { cwd, on });
          const branch = ref.code === 0 ? ref.stdout.trim() : sha?.code === 0 ? sha.stdout.trim() : null;
          const repo = common.stdout.trim();
          const name = repo.endsWith("/.git") ? baseName(repo.slice(0, -5)) : baseName(repo).replace(/\.git$/, "");
          this.repos[key] = { repo: JSON.stringify([on, repo]), name, linked: repo !== `${top.stdout.trim()}/.git`,
            dir: baseName(top.stdout.trim()), branch };
        } catch { this.repos[key] = null; }
        finally { this.asking.delete(key); cx.notify(); }
      });
    }
    return undefined;
  }

  // Grouped by space: a repo with worktree spaces gets a header named after the repo, and
  // every checkout under it (the main one first, then each worktree, even a lone one) is a
  // labeled subgroup with a branch icon. A repo without worktrees stays one plain group.
  nestWorktrees(groups, cx) {
    const ps = panes(), byId = new Map(spaces().map((s) => [s.id, s]));
    const info = (g) => (g.space && byId.has(g.space) ? this.repoOf(byId.get(g.space), ps, cx) : null);
    for (const g of groups) g.git = info(g);
    const mains = new Map(groups.filter((g) => g.git && !g.git.linked).map((g) => [g.git.repo, g]));
    const kidsOf = (repo) => groups.filter((g) => g.git?.linked && g.git.repo === repo);
    const out = [], placed = new Set();
    const place = (repo, parent) => {
      if (placed.has(repo)) return;
      placed.add(repo);
      const kids = kidsOf(repo);
      kids.forEach((k, n) => out.push({ ...k, sub: true, under: parent.id, last: n === kids.length - 1 }));
    };
    for (const g of groups) {
      if (g.git?.linked) {
        if (mains.has(g.git.repo) || placed.has(g.git.repo)) continue;
        const head = { id: `repo-${g.git.repo}`, label: g.git.name, status: null, members: [], repoHead: true };
        out.push(head);
        place(g.git.repo, head);
        continue;
      }
      if (g.git && kidsOf(g.git.repo).length && !placed.has(g.git.repo)) {
        const head = { id: `repo-${g.git.repo}`, label: g.git.name, status: null, members: [], repoHead: true };
        out.push(head, { ...g, sub: true, under: head.id });
        place(g.git.repo, head);
        continue;
      }
      out.push(g);
    }
    // A worktree whose repo header got placed later still needs a home: anything left goes last.
    for (const g of groups) if (!out.some((o) => o.id === g.id)) out.push(g);
    return out;
  }

  pollSwarm(cx) {
    if (this.polling) return;
    const sessions = terminals().filter((t) => t.state === "live" && !t.address.includes("/") && !t.parent).map((t) => {
      const what = `${t.agent ?? ""} ${t.program?.key ?? ""} ${t.app ?? ""}`;
      const kind = /claude/i.test(what) ? "claude" : /codex/i.test(what) ? "codex" : null;
      // The pane's live folder first: core's cwd can be where the shell started.
      const live = panes().find((p) => p.terminal === t.address)?.cwd;
      return kind && { address: t.address, kind, cwd: live ?? t.cwd ?? null, cwds: [...new Set([live, t.cwd].filter(Boolean))] };
    }).filter(Boolean);
    if (!sessions.length && this.swarmJson === "{}") return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/ide-agents/swarm.py`, JSON.stringify(sessions)]);
        const out = r.code === 0 ? r.stdout.trim() || "{}" : this.swarmJson;
        if (out !== this.swarmJson) { this.swarmJson = out; this.swarm = JSON.parse(out); cx.notify(); }
      } catch { /* keep the last list */ }
      finally { this.polling = false; }
    });
  }

  // A session's subagents as tree rows, after its hc sub-agents.
  swarmKids(addr, lead, after) {
    const kids = this.swarm?.[addr] ?? [];
    return kids.map((c, i) => {
      const last = i === kids.length - 1;
      const pad = Array.from({ length: c.depth ?? 0 }, () => "");
      return { t: { ...c, swarm: true, address: `sw-${addr}-${c.id}`, parent: addr }, lines: [...lead, ...pad, last ? "└" : "├"] };
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  openTabMenu(a, name) {
    if (!a.tab) return;
    openOverlay({ mod: "ide-agents", kind: "popup", width: 220, height: 172, props: { tabMenu: { tab: a.tab, pane: a.pane, terminal: a.address, name } } });
  }

  // Rename asks the person for the name. With Herdr's pane.rename (after 0.1.16) it names this
  // agent's pane alone; before that, tab.rename names the tab, every agent in it included.
  renameTab(tab, pane) {
    closeOverlay(props().overlay);
    if (pane && commands().some(c => c.name === "pane.rename")) run("pane.rename", { pane });
    else run("tab.rename", { id: tab });
  }

  colorAgent(terminal, hex) {
    closeOverlay(props().overlay);
    hc(["label", terminal, `${LABEL}=${hex ?? ""}`]).then(r => {
      if (r.code !== 0) notify({ title: "Couldn't set the color", body: r.stderr.trim(), level: "error" });
    });
  }

  tabMenu(t) {
    const { tab, pane, terminal, name } = props().tabMenu;
    const on = colorFrom(terminals().find(x => x.address === terminal)?.labels);
    const perPane = Boolean(pane) && commands().some(c => c.name === "pane.rename");
    const swatch = (id, hex, label, el) => div()
      .id(`tab-color-${id}`)
      .size(20)
      .flex_none()
      .rounded(10)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .tooltip(label)
      .when(on === hex, s => s.border_2().border_color(t.foreground))
      .on_click(() => this.colorAgent(terminal, hex))
      .child(el);
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(name || "Tab"))
      .child(h_flex()
        .id("tab-rename")
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => this.renameTab(tab, pane))
        .child(svg("mods/workspace-chrome/square-pen.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(perPane ? "Rename" : "Rename tab")))
      .child(div().px(8).pt(6).pb(6).text_size(11).text_color(t.dim).child("Color"))
      .child(h_flex().flex_wrap().gap(7).px(8)
        .children(SWATCHES.map(s => swatch(s.name.toLowerCase(), s.hex, s.name,
          div().size(on === s.hex ? 12 : 16).rounded(8).bg(s.hex))))
        .child(swatch("none", null, "No color",
          div().size(16).rounded(8).border_1().border_color(t.dim).flex().items_center().justify_center()
            .child(svg("mods/workspace-chrome/x.svg").size(10).text_color(t.dim)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    const swarm = lead.length ? [] : this.swarmKids(addr, lead);
    return [...kids.flatMap((k, i) => {
      const last = i === kids.length - 1 && !swarm.length;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    }), ...swarm];
  }

  // A Claude/Codex subagent: its task, how long it ran, and its state. Click: its parent's pane.
  // A sub-agent row wears its parent tab's color: a thin border and tree lines, both quiet.
  kin(el, hex = PLAIN) {
    return el.border(1.5).border_color(quiet(hex)).my(GAP);
  }

  swarmRow(t, s, compact, hex = PLAIN) {
    const k = s.t, end = k.ended ? k.ended * 1000 : Date.now();
    const parent = agents().find((a) => a.address === k.parent);
    const look = k.status === "done" ? { status: "done" } : { status: kidStatus(k, this.listed) };
    return h_flex()
      .id(`sub-${k.address}`)
      .map(el => this.kin(el, hex))
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .hover((s) => s.bg(t.hover))
      .tooltip(`${k.name}${k.detail ? ` · ${k.detail}` : ""} · ${k.status}`)
      .on_click(() => parent?.pane && run("pane.focus", { pane: parent.pane }))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(quiet(hex)))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .child(div().flex_1().min_w(0).truncate().text_color(k.status === "working" ? t.foreground : t.muted).child(k.name))
      .child(div().flex_none().ml(6).mr(6).text_size(11).text_color(t.dim).child(duration(end - k.started * 1000)))
      .child(this.status(t, look, compact));
  }

  subRow(t, s, shown, compact, hex = PLAIN) {
    if (s.t.swarm) return this.swarmRow(t, s, compact, hex);
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .map(el => this.kin(el, hex))
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(quiet(hex)))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.tabMenu) return this.tabMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority, colorOf(a)))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const labelsOf = address => all.find(x => x.address === address)?.labels;
    // Colors kept in shared state before labels move onto their terminals. Only entries whose
    // labels were written leave shared state; the rest are tried again after RETRY.
    if (!this.moving && list.length && LEGACY.some(k => shared(k)) && Date.now() - (this.movedAt ?? 0) > RETRY) {
      this.moving = true;
      this.movedAt = Date.now();
      const agentsNow = list;
      Promise.all(legacyLabels(agentsNow, shared(LEGACY[0]), shared(LEGACY[1]), labelsOf)
        .map(([address, hex]) => hc(["label", address, `${LABEL}=${hex}`]).then(r => (r.code === 0 ? address : null), () => null)))
        .then(done => {
          const written = new Set(done.filter(Boolean));
          const labeled = a => written.has(a.address) || Boolean(colorFrom(labelsOf(a.address)));
          unmovedLegacy(shared(LEGACY[0]), shared(LEGACY[1]), agentsNow, labeled).forEach((left, i) => setShared(LEGACY[i], left));
        })
        .finally(() => { this.moving = false; });
    }
    // A row's border: its agent's color (else white), full strength only on the focused row.
    const colorOf = a => colorFrom(labelsOf(a.address)) ?? PLAIN;
    const colored = (el, a) => {
      const hex = colorOf(a);
      return el.on_mouse_down("right", () => this.openTabMenu(a, label(a)))
        .rounded(8).border_color(a.focused ? hex : quiet(hex))
        .when(a.focused, el => el.border_2()).when(!a.focused, el => el.border(1.5))
        // A small gap between rows; the focused row's halo takes it up instead.
        .when(!a.focused || collapsed, el => el.my(GAP));
    };
    // The focused row lights up: opaque tinted fill (set on the row) inside two soft rings.
    // The negative margin keeps the rows around it where they are.
    const fillOf = (a, more = 0) => mix(t.chrome.slice(0, 7), colorOf(a), more + (colorOf(a) === PLAIN ? 0.09 : parseInt(TINT, 16) / 255));
    const halo = (a, el) => !a.focused ? el : div().mx(-4).my(GAP - 4).p(2).rounded(12).bg(colorOf(a) + HALO[1])
      .child(div().p(2).rounded(10).bg(colorOf(a) + HALO[0]).child(el));
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    // `rail`: the collapsed sidebar's cell. `id`: the row's id prefix (a hover card's copy differs).
    const row = (a, i, subs = [], rail = collapsed, id = "ag") => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (rail) {
        // The agent's icon and status; resting the pointer on it opens the full row (and its
        // sub-agents) in a card beside the rail, clickable like the list itself.
        const cell = h_flex()
          .id(`ag-${a.address}`)
          .map(el => colored(el, a))
          .h(30)
          .px(6)
          .flex_none()
          .items_center()
          .justify_center()
          .gap(6)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(pic ?? div().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
        const kids = this.tree(all, a.address);
        const card = v_flex()
          .w(280)
          .p(6)
          .rounded(10)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_md()
          .text_size(13)
          .child(row(a, i, kids, false, "card"))
          .children(kids.map((s) => this.subRow(t, s, shown, false, colorOf(a))));
        return HoverCard.new(`ag-card-${a.address}`).anchor("left_center").open_delay(250).trigger(cell).content(card);
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      // A row always has a name; with none at all, its machine stands in.
      // A pane someone named (pane.rename, after Herdr 0.1.16) reads as that name.
      const name = a.pane_name || (full ? a.space_name || label(a) : more || (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a)))
        || machine || a.program?.name || "";
      // An agent on another machine: a second line under the name says which.
      const remote = Boolean(machine) && name !== machine;
      return halo(a, h_flex()
        .id(`${id}-${a.address}`)
        .map(el => colored(el, a))
        .px(8)
        .h(remote ? 42 : 30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(fillOf(a)))
        .cursor_pointer()
        // The focused row stays opaque on hover, or its halo would show through the text.
        .hover((s) => s.bg(a.focused ? fillOf(a, 0.06) : t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(v_flex().flex_1().min_w(0).justify_center()
          .child(h_flex().min_w(0).gap(5).items_center()
            .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
            .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
          .when(remote, el => el.child(h_flex().min_w(0).gap(4).items_center().text_size(10.5).text_color(t.dim)
            .child(svg("mods/workspace-chrome/monitor.svg").size(11).flex_none())
            .child(div().min_w(0).truncate().child(machine)))))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned)));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a], space: byPriority ? null : a.space });
    }
    const shownGroups = byPriority ? groups : this.nestWorktrees(groups, cx);

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const all = [...g.members, ...shownGroups.filter((k) => k.under === g.id).flatMap((k) => k.members)];
      const top = all.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .when(Boolean(g.sub), (el) => el.pl(18))
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        // A checkout under its repo: worktree folder (blue) and branch (magenta), each with its icon.
        .when(Boolean(g.sub), (el) => el
          .tooltip([g.git?.dir, g.git?.branch].filter(Boolean).join(" · "))
          .child(svg("mods/ide-agents/worktree.svg").size(12).flex_none().text_color(t.ansi4))
          .child(div().flex_shrink_1().min_w(0).truncate().text_color(t.ansi4).child(g.git?.dir ?? g.label))
          .when(Boolean(g.git?.branch), (el) => el
            .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none().ml(4).text_color(t.ansi5))
            .child(div().flex_shrink_1().min_w(0).truncate().text_color(t.ansi5).child(g.git.branch))))
        .when(!g.sub, (el) => el.child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label)))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(all.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    // Agents in one tab (a split view): a soft white dashed box around their rows (each keeps its own color), headed
    // by a split-panes icon and how many share the screen. Sub-agents keep their tree lines.
    const tabBox = (run) => v_flex()
      .id(`tab-box-${run[0].tab}`)
      .flex_none()
      .my(GAP)
      .px(5)
      .pb(3)
      .rounded(12)
      .border(1)
      .border_dashed()
      .border_color(quiet(PLAIN))
      .child(h_flex().h(20).px(3).gap(5).items_center().text_size(10.5).text_color(t.dim)
        .child(svg("mods/workspace-chrome/panel-right.svg").size(11).flex_none())
        .child(div().child(`${run.length} panes, one view`)))
      .children(run.flatMap(withKids));
    const boxed = (members) => byTab(members).flatMap(run => run.length > 1 ? [tabBox(run)] : run.flatMap(withKids));
    const rows = collapsed
      ? list.flatMap(withKids)
      : shownGroups.filter((g) => !(g.sub && this.folded.has(g.under)))
          .flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : boxed(g.members)
            .map((r) => (g.sub ? h_flex().w_full().flex_none().pl(14).child(r.flex_1().min_w(0)) : r)))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "ide-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).pl(collapsed ? 0 : 8).pr(collapsed ? 0 : SCROLLBAR).overflow_y_scrollbar().mode("always").children(rows));
      // ide-agents: no » here; the sidebar toggle stays at the top (ide-chrome).
  }
}
