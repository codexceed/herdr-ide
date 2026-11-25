// The spreadsheet view: a workbook from xlsx_read.py drawn like Excel. A formula bar on top,
// column letters and row numbers that stay put, frozen panes, merged cells, text that spills
// into empty neighbours, and the sheet tabs along the bottom.
//
// No virtual list: cells need their own click handlers, and frozen rows and columns need to
// know the scroll position. So the view keeps its own scroll (`view.sx`, `view.sy`, pixels
// past the frozen panes), draws only the cells on screen, absolutely placed, and moves on the
// wheel. Colors are Excel's light ones whatever the theme: fills and font colors in a workbook
// are picked against white.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const isSheet = path => /\.(xlsx|xlsm|gsheet)$/i.test(path ?? "");

const C = {
  cell: "#FFFFFF", text: "#000000", grid: "#E1E1E1", head: "#F3F3F3", headText: "#5E5E5E",
  headLine: "#D1D1D1", headSel: "#D9D9D9", sel: "#217346", bar: "#FFFFFF", tabs: "#F0F0F0",
};
const HEAD_H = 20, BAR_H = 28, TABS_H = 30, SPILL_MAX = 30;
// Excel's column widths assume Calibri 11 (7px digits); the UI font's digits are wider, so
// text is drawn at 85% of its point size to keep a sheet's columns fitting what they did.
const FONT_SCALE = 0.85;
export const fontPx = pt => (pt * 4 / 3) * FONT_SCALE;

// Excel shows ##### for a number or date too wide for its cell instead of cutting digits off.
// The width is estimated (digits ~0.6em, separators ~0.3em): a little cautious, never misleading.
export function fitNumber(text, px, room) {
  let w = 0;
  for (const ch of text) w += /[.,:\s'()]/.test(ch) ? 0.3 * px : 0.6 * px;
  return w <= room ? text : "#".repeat(Math.max(1, Math.floor(room / (0.6 * px))));
}

export function colName(c) {
  let s = "";
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
  return s;
}

// Excel auto-fits a row of wrapped text that has no height of its own; estimate the same
// (characters ~0.55em, lines 1.25em), capped at Excel's 409pt.
function autoHeights(sheet, styles) {
  const heights = { ...(sheet.rowh ?? {}) }, base = styles[0]?.pt ?? 11, dflt = sheet.drh ?? 20;
  for (const [r, c, text, s] of sheet.cells) {
    const st = styles[s];
    if (!st?.wrap || !text || r in (sheet.rowh ?? {})) continue;
    const px = fontPx(st.pt ?? base), room = Math.max(10, (sheet.colw?.[c] ?? sheet.dcw ?? 64) - 7);
    const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length * 0.55 * px / room)), 0);
    if (lines > 1) heights[r] = Math.max(heights[r] ?? dflt, Math.min(545, Math.ceil(lines * px * 1.25 + 5)));
  }
  return heights;
}

// Geometry and lookups for one sheet, built once per load (the sheet object is replaced on reload).
export function prepare(sheet, styles = []) {
  if (sheet.prep) return sheet.prep;
  const cells = new Map(), covered = new Map();
  let lastR = 0, lastC = 0;
  for (const cell of sheet.cells) {
    cells.set(`${cell[0]},${cell[1]}`, cell);
    if (cell[2] || cell[4]) { lastR = Math.max(lastR, cell[0]); lastC = Math.max(lastC, cell[1]); }
  }
  const merges = new Map();
  let budget = 200000;
  for (const [r1, c1, r2, c2] of sheet.merges) {
    merges.set(`${r1},${c1}`, [r1, c1, r2, c2]);
    lastR = Math.max(lastR, r2); lastC = Math.max(lastC, c2);
    for (let r = r1; r <= r2 && budget > 0; r++) for (let c = c1; c <= c2 && budget-- > 0; c++)
      if (r !== r1 || c !== c1) covered.set(`${r},${c}`, `${r1},${c1}`);
  }
  const [fr, fc] = sheet.freeze ?? [0, 0];
  const rows = Math.max(lastR + 1 + 50, fr + 1, 100), cols = Math.max(lastC + 1 + 10, fc + 1, 26);
  const axis = (n, sizes, dflt) => {
    const at = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) at[i + 1] = at[i] + (sizes[i] ?? dflt);
    return {
      n,
      size: i => sizes[i] ?? dflt,
      // Offset of index i from the sheet's top/left edge, past the table with the default size.
      pos: i => i <= n ? at[i] : at[n] + (i - n) * dflt,
      // The index whose span holds offset y.
      find: y => {
        if (y >= at[n]) return n + Math.floor((y - at[n]) / dflt);
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at[mid] <= y) lo = mid; else hi = mid - 1; }
        return lo;
      },
    };
  };
  sheet.prep = { cells, covered, merges, fr, fc, R: axis(rows, autoHeights(sheet, styles), sheet.drh ?? 20), Co: axis(cols, sheet.colw ?? {}, sheet.dcw ?? 64) };
  return sheet.prep;
}

// The visible sheets (hidden ones keep their place in `book.sheets`).
export const shownSheets = book => book.sheets.map((s, i) => [s, i]).filter(([s]) => !s.hidden);

export function initialView(book) {
  const first = book.sheets[book.active] && !book.sheets[book.active].hidden ? book.active : shownSheets(book)[0]?.[1] ?? 0;
  return { sheet: first, sx: 0, sy: 0, sel: { r: 0, c: 0 } };
}

// The furthest the scrolled panes can move, given the viewport.
function limits(p, w, h) {
  const frozenW = p.Co.pos(p.fc), frozenH = p.R.pos(p.fr);
  return { x: Math.max(0, p.Co.pos(p.Co.n) - frozenW - (w - frozenW)), y: Math.max(0, p.R.pos(p.R.n) - frozenH - (h - frozenH)) };
}

export function scrollBy(view, book, dx, dy, size) {
  const sheet = book.sheets[view.sheet];
  if (!sheet || !size) return;
  const p = prepare(sheet, book.styles), { gw, gh } = gridSize(sheet, size), lim = limits(p, gw, gh);
  view.sx = Math.min(lim.x, Math.max(0, view.sx + dx));
  view.sy = Math.min(lim.y, Math.max(0, view.sy + dy));
}

// Wide enough for the longest row number the sheet scrolls to.
const rowHeadW = p => Math.max(32, String(p.R.n).length * 8 + 14);

// Callers prepare the sheet first (prepare needs the book's styles; this is handed the sheet).
function gridSize(sheet, size) {
  const p = sheet.prep;
  return { gw: Math.max(0, size.width - rowHeadW(p)), gh: Math.max(0, size.height - BAR_H - HEAD_H - TABS_H) };
}

// Moves the selection and scrolls it into view.
export function moveSel(view, book, dr, dc, size) {
  const sheet = book.sheets[view.sheet];
  if (!sheet) return;
  const p = prepare(sheet, book.styles);
  let { r, c } = view.sel;
  // Leave a merge from its far edge: from its top-left, one step right or down lands back in it.
  const own = p.merges.get(`${r},${c}`);
  if (own && dr > 0) r = own[2];
  if (own && dc > 0) c = own[3];
  const step = (v, d, sizeOf) => { do v += d; while (v > 0 && sizeOf(v) === 0); return Math.max(0, v); };
  if (dr) r = step(r, Math.sign(dr), p.R.size) + (Math.abs(dr) > 1 ? dr - Math.sign(dr) : 0);
  if (dc) c = step(c, Math.sign(dc), p.Co.size);
  const m = p.covered.get(`${r},${c}`);
  if (m) [r, c] = m.split(",").map(Number);
  view.sel = { r: Math.max(0, r), c: Math.max(0, c) };
  if (!size) return;
  const { gw, gh } = gridSize(sheet, size), frozenW = p.Co.pos(p.fc), frozenH = p.R.pos(p.fr);
  if (view.sel.r >= p.fr) {
    const top = p.R.pos(view.sel.r) - frozenH, bottom = p.R.pos(view.sel.r + 1) - frozenH, room = gh - frozenH;
    if (top < view.sy) view.sy = top; else if (bottom > view.sy + room) view.sy = bottom - room;
  }
  if (view.sel.c >= p.fc) {
    const left = p.Co.pos(view.sel.c) - frozenW, right = p.Co.pos(view.sel.c + 1) - frozenW, room = gw - frozenW;
    if (left < view.sx) view.sx = left; else if (right > view.sx + room) view.sx = right - room;
  }
  scrollBy(view, book, 0, 0, size);
}

// What the formula bar shows for the selected cell: its formula, else its value.
export function cellContent(book, view) {
  const sheet = book.sheets[view.sheet], p = sheet && prepare(sheet, book.styles);
  const cell = p?.cells.get(`${view.sel.r},${view.sel.c}`);
  return cell ? (cell[4] ?? cell[2]) : "";
}

// How far a left-aligned text cell's text runs right: over empty neighbours, as in Excel.
function spillWidth(p, r, c, own) {
  let w = own;
  for (let k = c + 1; k < c + SPILL_MAX; k++) {
    const next = p.cells.get(`${r},${k}`);
    if ((next && (next[2] || next[4])) || p.covered.has(`${r},${k}`) || p.merges.has(`${r},${k}`)) break;
    w += p.Co.size(k);
  }
  return w;
}

// The cells of one pane (frozen corner, frozen rows, frozen columns or the scrolled body).
// rows/cols: [first, last] indices drawn; ox/oy: sheet offset of the pane's top-left corner.
function paneCells(book, sheet, p, view, rows, cols, ox, oy, font, onPick) {
  const boxes = [], labels = [], styles = book.styles, base = styles[0]?.pt ?? 11;
  const drawn = new Set();
  const place = (r, c) => {
    let key = `${r},${c}`;
    const owner = p.covered.get(key);
    if (owner) { if (drawn.has(owner)) return; key = owner; [r, c] = owner.split(",").map(Number); }
    if (drawn.has(key)) return;
    drawn.add(key);
    const m = p.merges.get(key), r2 = m ? m[2] : r, c2 = m ? m[3] : c;
    const x = p.Co.pos(c) - ox, y = p.R.pos(r) - oy, w = p.Co.pos(c2 + 1) - p.Co.pos(c), h = p.R.pos(r2 + 1) - p.R.pos(r);
    if (w <= 0 || h <= 0) return;
    const cell = p.cells.get(key), st = cell ? styles[cell[3]] ?? {} : {};
    // A border drawn on the neighbour's facing side counts too (Excel draws either).
    const below = p.cells.get(`${r2 + 1},${c}`), right = p.cells.get(`${r},${c2 + 1}`);
    const bb = st.bb ?? (below && styles[below[3]]?.bt), br = st.br ?? (right && styles[right[3]]?.bl);
    boxes.push(div().id(`sc-${key}`).absolute().left(x).top(y).w(w).h(h)
      .bg(st.bg ?? C.cell)
      .border_r(1).border_b(1).border_color(br || bb ? (br ?? bb) : st.bg ? st.bg : C.grid)
      .when(Boolean(bb && br && bb !== br), el => el.border_color(bb))
      .when(Boolean(st.bt && r === 0), el => el.border_t(1))
      .when(Boolean(st.bl && c === 0), el => el.border_l(1))
      .on_mouse_down("left", (_e, cx) => onPick(r, c, cx)));
    if (!cell?.[2]) return;
    const kind = cell[5], align = st.h ?? (kind === "n" ? "right" : kind === "b" || kind === "e" ? "center" : "left");
    const spill = align === "left" && !st.wrap && !m ? spillWidth(p, r, c, w) : w, px = fontPx(st.pt ?? base);
    const text = kind === "n" ? fitNumber(cell[2], px, w - 7) : cell[2];
    labels.push(h_flex().absolute().left(x).top(y).w(spill - 1).h(h - 1).px(3).overflow_hidden()
      .when(spill > w, el => el.bg(st.bg ?? C.cell))
      .when(st.v === "top", el => el.items_start()).when(st.v === "center", el => el.items_center()).when(!st.v, el => el.items_end().pb(1))
      .when(align === "right", el => el.justify_end()).when(align === "center", el => el.justify_center())
      .text_size(px).font_family(font).text_color(st.fg ?? C.text)
      .when(Boolean(st.b), el => el.font_weight(700)).when(Boolean(st.i), el => el.italic())
      .when(Boolean(st.u), el => el.underline()).when(Boolean(st.s), el => el.line_through())
      .child(st.wrap ? div().w_full().child(text) : div().flex_none().whitespace_nowrap().child(text)));
  };
  for (let r = rows[0]; r <= rows[1]; r++) {
    if (p.R.size(r) === 0) continue;
    for (let c = cols[0]; c <= cols[1]; c++) if (p.Co.size(c) !== 0) place(r, c);
  }
  // Merges that start above or left of the pane but reach into it.
  for (const [r1, c1, r2, c2] of p.merges.values())
    if (r1 < rows[0] && r2 >= rows[0] && c2 >= cols[0] && c1 <= cols[1] || c1 < cols[0] && c2 >= cols[0] && r2 >= rows[0] && r1 <= rows[1]) place(r1, c1);
  // The selection outline, where the selected cell (or its merge) reaches into this pane.
  const { r, c } = view.sel, m = p.merges.get(`${r},${c}`), r2 = m ? m[2] : r, c2 = m ? m[3] : c;
  if (r2 >= rows[0] && r <= rows[1] && c2 >= cols[0] && c <= cols[1]) {
    const x = p.Co.pos(c) - ox, y = p.R.pos(r) - oy;
    const w = p.Co.pos((m ? m[3] : c) + 1) - p.Co.pos(c), h = p.R.pos((m ? m[2] : r) + 1) - p.R.pos(r);
    labels.push(div().absolute().left(x - 1).top(y - 1).w(w + 1).h(h + 1).border_2().border_color(C.sel));
  }
  return [...boxes, ...labels];
}

// Visible index range along one axis for a scrolled pane: from offset `from`, `room` pixels.
const span = (ax, start, from, room) => [Math.max(start, ax.find(from)), ax.find(from + Math.max(0, room - 1))];

export function sheetView({ book, view, size, font, t, onPick, onSheet, onScroll }) {
  const sheet = book.sheets[view.sheet] ?? book.sheets[0];
  const tabs = shownSheets(book);
  const bar = h_flex().h(BAR_H).flex_none().bg(C.bar).border_b(1).border_color(C.headLine).items_center().text_color(C.text).text_size(12.5)
    .child(div().w(72).h_full().flex_none().flex().items_center().px(8).border_r(1).border_color(C.headLine).child(`${colName(view.sel.c)}${view.sel.r + 1}`))
    .child(div().px(10).flex_none().italic().text_color(C.headText).child("fx"))
    .child(div().flex_1().min_w(0).truncate().pr(8).font_family(font).child(cellContent(book, view)));
  const tabBar = h_flex().id("sheet-tabs").h(TABS_H).flex_none().bg(C.tabs).border_t(1).border_color(C.headLine).items_end().overflow_x_scroll().pl(8).gap(1)
    .children(tabs.map(([s, i]) => {
      const on = i === view.sheet;
      return v_flex().id(`sheet-tab-${i}`).h(TABS_H - 4).flex_none().px(14).justify_center().cursor_pointer().text_size(12.5)
        .bg(on ? C.cell : C.tabs).text_color(on ? C.sel : C.headText).when(on, el => el.font_weight(600))
        .border_b(on ? 2 : 0).border_color(on ? C.sel : C.tabs)
        .hover(el => el.bg(on ? C.cell : C.headSel))
        .on_click((_e, cx) => onSheet(i, cx))
        .child(h_flex().gap(6).items_center()
          .when(Boolean(s.tab), el => el.child(div().size(8).rounded(2).bg(s.tab)))
          .child(div().whitespace_nowrap().child(s.name)));
    }));
  const root = v_flex().id("sheet").flex_1().min_h(0).bg(C.cell).text_color(C.text);
  if (!sheet) return root.child(div().p(12).text_color(t.dim).child("This workbook has no sheets"));
  if (!size) return root.child(bar).child(div().flex_1()).child(tabBar);

  const p = prepare(sheet, book.styles), rw = rowHeadW(p), { gw, gh } = gridSize(sheet, size);
  const frozenW = p.Co.pos(p.fc), frozenH = p.R.pos(p.fr);
  const roomW = Math.max(0, gw - frozenW), roomH = Math.max(0, gh - frozenH);
  const rowsF = [0, p.fr - 1], colsF = [0, p.fc - 1];
  const rowsS = span(p.R, p.fr, frozenH + view.sy, roomH), colsS = span(p.Co, p.fc, frozenW + view.sx, roomW);
  const pane = (left, top, w, h, rows, cols, px, py) => div().absolute().left(left).top(top).w(w).h(h).overflow_hidden()
    .when(rows[1] >= rows[0] && cols[1] >= cols[0], el => el.children(paneCells(book, sheet, p, view, rows, cols, px, py, font, onPick)));
  const grid = div().absolute().left(rw).top(HEAD_H).w(gw).h(gh).overflow_hidden()
    .child(pane(frozenW, frozenH, roomW, roomH, rowsS, colsS, frozenW + view.sx, frozenH + view.sy))
    .child(pane(frozenW, 0, roomW, frozenH, rowsF, colsS, frozenW + view.sx, 0))
    .child(pane(0, frozenH, frozenW, roomH, rowsS, colsF, 0, frozenH + view.sy))
    .child(pane(0, 0, frozenW, frozenH, rowsF, colsF, 0, 0))
    .when(p.fr > 0, el => el.child(div().absolute().left(0).top(frozenH - 1).w(gw).h(1).bg("#9B9B9B")))
    .when(p.fc > 0, el => el.child(div().absolute().left(frozenW - 1).top(0).w(1).h(gh).bg("#9B9B9B")));

  // Column letters and row numbers, following the scroll past the frozen panes.
  const colHeads = [], rowHeads = [], colHeadsF = [], rowHeadsF = [];
  const headCols = [...(p.fc ? [[colsF, 0]] : []), [colsS, view.sx]];
  for (const [[a, b], shift] of headCols) for (let c = a; c <= b; c++) {
    const w = p.Co.size(c);
    if (!w) continue;
    const x = c < p.fc ? p.Co.pos(c) : p.Co.pos(c) - shift - frozenW, on = c === view.sel.c;
    (c < p.fc ? colHeadsF : colHeads).push(div().absolute().left(x).top(0).w(w).h(HEAD_H).flex().items_center().justify_center()
      .bg(on ? C.headSel : C.head).border_r(1).border_b(on ? 2 : 1).border_color(on ? C.sel : C.headLine)
      .text_size(11.5).text_color(on ? C.sel : C.headText).child(colName(c)));
  }
  const headRows = [...(p.fr ? [[rowsF, 0]] : []), [rowsS, view.sy]];
  for (const [[a, b], shift] of headRows) for (let r = a; r <= b; r++) {
    const h = p.R.size(r);
    if (!h) continue;
    const y = r < p.fr ? p.R.pos(r) : p.R.pos(r) - shift - frozenH, on = r === view.sel.r;
    (r < p.fr ? rowHeadsF : rowHeads).push(div().absolute().left(0).top(y).w(rw).h(h).flex().items_center().justify_end().pr(6)
      .bg(on ? C.headSel : C.head).border_b(1).border_r(on ? 2 : 1).border_color(on ? C.sel : C.headLine)
      .text_size(11.5).text_color(on ? C.sel : C.headText).child(String(r + 1)));
  }
  // Scroll position as thin thumbs (the wheel and the arrow keys move it).
  const lim = limits(p, gw, gh), thumbs = [];
  if (lim.y > 0) {
    const th = Math.max(24, roomH * roomH / (roomH + lim.y));
    thumbs.push(div().absolute().right(2).top(HEAD_H + frozenH + (roomH - th) * view.sy / lim.y).w(6).h(th).rounded(3).bg("#00000033"));
  }
  if (lim.x > 0) {
    const tw = Math.max(24, roomW * roomW / (roomW + lim.x));
    thumbs.push(div().absolute().bottom(2).left(rw + frozenW + (roomW - tw) * view.sx / lim.x).h(6).w(tw).rounded(3).bg("#00000033"));
  }
  const body = div().id("sheet-body").relative().flex_1().min_h(0).overflow_hidden().bg(C.cell)
    .on_scroll_wheel((e, cx) => onScroll(e, cx))
    .child(grid)
    .child(div().absolute().left(0).top(0).w(rw).h(HEAD_H).bg(C.head).border_r(1).border_b(1).border_color(C.headLine))
    .child(div().absolute().left(rw).top(0).w(frozenW).h(HEAD_H).overflow_hidden().children(colHeadsF))
    .child(div().absolute().left(rw + frozenW).top(0).w(roomW).h(HEAD_H).overflow_hidden().children(colHeads))
    .child(div().absolute().left(0).top(HEAD_H).w(rw).h(frozenH).overflow_hidden().children(rowHeadsF))
    .child(div().absolute().left(0).top(HEAD_H + frozenH).w(rw).h(roomH).overflow_hidden().children(rowHeads))
    .children(thumbs);
  return root.child(bar).child(body).child(tabBar);
}
