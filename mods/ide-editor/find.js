// Find (⌘F) in the rendered Markdown preview.
// - blocks(md): the page cut into top-level blocks, each drawn by its own TextView, so the
//   preview can scroll to the block holding a hit (ScrollHandle reveals direct children).
// - hits(md, query): every match in the text a block shows, as [start, end) offsets into its
//   Markdown source, the coordinates TextView.highlight_range takes.

// CommonMark fences: up to 3 spaces in; a ``` opener's info has no backtick; the closer is the
// same mark, at least as long, with nothing after it.
const opens = line => {
  const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  return f && !(f[1][0] === "`" && f[2].includes("`")) ? f[1] : null;
};
const closes = (line, fence) => {
  const f = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(f && f[1][0] === fence[0] && f[1].length >= fence.length);
};

// Cuts at blank lines that start a new top-level block. Never inside a fence or an HTML
// comment / <pre> / <script> / <style> block, before an indented line (a list item's
// continuation, indented code), or between items of one list. A page with reference links
// or footnotes stays whole: their definitions must share a TextView with their uses.
export function blocks(md) {
  if (/^ {0,3}\[\^?[^\]\n]+\]:/m.test(md)) return [{ md, start: 0 }];
  const out = [], lines = md.split("\n");
  let start = 0, pos = 0, fence = null, raw = null, blank = false, first = null;
  const item = line => /^ {0,3}(?:[-*+]|\d+[.)])\s/.test(line);
  for (const line of lines) {
    const here = pos;
    pos += line.length + 1;
    if (fence) { if (closes(line, fence)) fence = null; blank = false; continue; }
    if (raw) { if (raw.test(line)) raw = null; blank = false; continue; }
    if (!line.trim()) { blank = true; continue; }
    if (blank && here > start && !/^\s/.test(line) && !(item(line) && item(first ?? ""))) {
      out.push({ md: md.slice(start, here), start });
      start = here; first = null;
    }
    blank = false;
    first ??= line;
    const f = opens(line);
    if (f) { fence = f; continue; }
    if (/^ {0,3}<!--/.test(line) && !/-->/.test(line)) raw = /-->/;
    else {
      const tag = line.match(/^ {0,3}<(pre|script|style|textarea)\b/i);
      if (tag && !new RegExp(`</${tag[1]}>`, "i").test(line)) raw = new RegExp(`</${tag[1]}>`, "i");
    }
  }
  if (start < md.length) out.push({ md: md.slice(start), start });
  return out.filter(b => b.md.trim());
}

const DEFINITION = /^ {0,3}\[([^\]^][^\]]*)\]:\s*\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const label = text => text.trim().replace(/\s+/g, " ").toLowerCase();
const AUTOLINK = "(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\\s]*|[^<>\\s@]+@[^<>\\s]+)";

// The text a block shows, with each character's source offset: { text, at }. Close enough to
// search: emphasis marks, link targets, images, tags, escapes, heading / quote / list marks
// and table pipes are left out; code (spans and fences) is kept as written; a line break is a
// space, and a table cell break a "\n" that no query (trimmed) can match across.
export function shown(md) {
  const refs = new Set([...md.matchAll(new RegExp(DEFINITION.source, "gm"))].map(m => label(m[1])));
  const n = md.length, drop = new Uint8Array(n), keep = new Uint8Array(n), swap = new Map();
  const mark = (arr, a, b) => { for (let i = a; i < b; i++) arr[i] = 1; };
  let pos = 0, fence = null;
  for (const line of md.split("\n")) {
    const s = pos, e = s + line.length;
    pos = e + 1;
    if (e < n) swap.set(e, " ");
    if (fence) {
      if (closes(line, fence)) { fence = null; mark(drop, s, e); }
      else mark(keep, s, e);
      continue;
    }
    const f = opens(line);
    if (f) { fence = f; mark(drop, s, e); continue; }
    if (DEFINITION.test(line)) { mark(drop, s, e); continue; } // a reference definition shows nothing
    if (/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$|^\s*:?-{3,}:?\s*\|/.test(line) || /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { mark(drop, s, e); continue; }
    const lead = line.match(/^\s*(?:(?:>\s?)|(?:#{1,6}\s+)|(?:[-*+]\s+(?:\[[ xX]\]\s+)?)|(?:\d+[.)]\s+))*/)[0].length;
    mark(drop, s, s + lead);
    const each = (re, fn) => { for (const m of line.slice(lead).matchAll(re)) fn(m, s + lead + m.index); };
    each(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, at) => {
      mark(drop, at, at + m[1].length); mark(keep, at + m[1].length, at + m[0].length - m[1].length);
      mark(drop, at + m[0].length - m[1].length, at + m[0].length);
    });
    const free = (a, b) => { for (let i = a; i < b; i++) if (keep[i]) return false; return true; };
    each(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, (m, at) => { if (free(at, at + m[0].length)) mark(drop, at, at + m[0].length); });
    each(/\[([^\]]*)\]\(([^)]*)\)/g, (m, at) => {
      if (!free(at, at + 1)) return;
      drop[at] = 1; mark(drop, at + 1 + m[1].length, at + m[0].length);
    });
    // A reference link shows its text: [text][label], [text][] and [label] (when defined).
    each(/\[([^\]]*)\]\[([^\]]*)\]/g, (m, at) => {
      if (!free(at, at + 1) || drop[at] || !refs.has(label(m[2] || m[1]))) return;
      drop[at] = 1; mark(drop, at + 1 + m[1].length, at + m[0].length);
    });
    each(/(?<![\]!])\[([^\]]+)\](?![(\[:])/g, (m, at) => {
      if (!free(at, at + 1) || drop[at] || !refs.has(label(m[1]))) return;
      drop[at] = 1; drop[at + m[0].length - 1] = 1;
    });
    // An autolink shows its address, so only its brackets go; an HTML tag goes whole.
    each(new RegExp(`<(?=${AUTOLINK}>)|(?<=<${AUTOLINK})>|<\\/?[A-Za-z][A-Za-z0-9-]*(?=[\\s/>])[^>]*>`, "g"), (m, at) => { if (free(at, at + m[0].length)) mark(drop, at, at + m[0].length); });
    each(/\\(?=[!-/:-@[-`{-~])/g, (_m, at) => { if (free(at, at + 1)) drop[at] = 1; });
    each(/\*+|~~/g, (m, at) => { if (free(at, at + m[0].length)) mark(drop, at, at + m[0].length); });
    each(/_+/g, (m, at) => {
      const before = md[at - 1] ?? " ", after = md[at + m[0].length] ?? " ";
      if (!(/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) && free(at, at + m[0].length)) mark(drop, at, at + m[0].length);
    });
    if (line.includes("|")) each(/\|/g, (_m, at) => { if (free(at, at + 1) && md[at - 1] !== "\\") swap.set(at, "\n"); });
  }
  let text = "";
  const at = [];
  for (let i = 0; i < n; i++) {
    if (drop[i] && !keep[i]) continue;
    text += keep[i] ? md[i] : swap.get(i) ?? md[i];
    at.push(i);
  }
  return { text, at };
}

// Every match of `query` (any case, trimmed) in what the block shows: [[start, end], …] in
// source offsets. Matches that only cover markup the view leaves out are skipped.
export function hits(md, query, view = shown(md)) {
  const q = query.trim();
  if (!q) return [];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), out = [];
  for (const m of view.text.matchAll(re)) {
    if (!m[0].length) continue;
    out.push([view.at[m.index], view.at[m.index + m[0].length - 1] + 1]);
  }
  return out;
}

// The space TextView puts between two blocks, which it drops once each block is its own view
// (first and last in it). Mirrors gpui-component's text/node.rs: a block leaves a paragraph gap
// below itself, a heading 0.35 of its size; a heading adds the rest of its section gap above
// (size × 1.1 for h1, 1.6 for h2, 1.4 below), a rule 1.6 × the body size on each side.
const PARAGRAPH_GAP = 10.5; // 0.75 rem; measured against the unsplit preview at 14 px text
const HEADING = { 1: [1.8, 1.1], 2: [4 / 3, 1.6], 3: [17 / 15, 1.4], 4: [1, 1.4], 5: [14 / 15, 1.4], 6: [13 / 15, 1.4] };
const kindOf = line => {
  const h = line.match(/^ {0,3}(#{1,6})(\s|$)/);
  if (h) return { heading: h[1].length };
  if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return { rule: true };
  return {};
};
// The kinds of a block's first and last elements; a setext heading (text over === or ---) counts.
const ends = md => {
  const lines = md.split("\n").filter(l => l.trim());
  const setext = lines.length === 2 && /^ {0,3}(=+|-+)\s*$/.test(lines[1]) ? { heading: lines[1].trim()[0] === "=" ? 1 : 2 } : null;
  return { first: setext ?? kindOf(lines[0] ?? ""), last: setext ?? kindOf(lines[lines.length - 1] ?? "") };
};
export function blockGap(prev, md, body = 14) {
  const p = ends(prev).last, c = ends(md).first, rule = body * 1.6;
  const size = level => body * HEADING[level][0];
  const below = p.heading ? size(p.heading) * 0.35 : p.rule ? rule : PARAGRAPH_GAP;
  let above = 0;
  if (c.heading) {
    const own = size(c.heading);
    above = p.heading ? own * 0.25 : Math.max(0, own * HEADING[c.heading][1] - (p.rule ? rule : PARAGRAPH_GAP));
  } else if (c.rule) above = Math.max(0, rule - below);
  return below + above;
}
