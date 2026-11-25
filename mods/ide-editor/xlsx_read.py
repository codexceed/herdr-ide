"""Reads an .xlsx workbook into JSON for the sheet view (mods/ide-editor/sheet.js).

Stdlib only (zipfile + ElementTree), so it runs wherever python3 does. Prints one object:

  {"sheets": [{"name", "hidden", "tab", "colw", "rowh", "dcw", "drh", "freeze": [rows, cols],
               "merges": [[r1, c1, r2, c2]], "cells": [[r, c, text, style, formula, kind]], "cut"}],
   "styles": [{"b", "i", "u", "s", "fg", "bg", "pt", "h", "v", "wrap", "bt", "bb", "bl", "br"}],
   "active": index}

Rows and columns count from 0. Widths and heights are pixels at 100% zoom. `text` is the value
as Excel would display it (number formats applied); `kind` is n(umber), s(tring), b(ool) or
e(rror), which decides the default alignment. A cell's own font color from a [Red]-style number
format comes back as a per-cell style. Anything past MAX_CELLS is left out and `cut` says so.

  python3 xlsx_read.py book.xlsx
  python3 xlsx_read.py --gsheet stub.gsheet cache.xlsx   # a Google Drive stub: export, then read
"""
import colorsys
import datetime
import decimal
import json
import math
import os
import posixpath
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
M = "{%s}" % NS["m"]
R_ID = "{%s}id" % NS["r"]
MAX_CELLS = 150_000
MAX_TEXT = 2000

BUILTIN_FORMATS = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%",
    11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm",
    17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
    22: "m/d/yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
    39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss",
    47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
}
# The legacy 64-color palette `indexed` colors point into (when the file doesn't override it).
INDEXED = ("000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " * 2 +
           "800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF "
           "660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF "
           "00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 "
           "FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333").split()
NAMED = {"black": "#000000", "blue": "#0000FF", "cyan": "#00FFFF", "green": "#00FF00",
         "magenta": "#FF00FF", "red": "#FF0000", "white": "#FFFFFF", "yellow": "#FFFF00"}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December"]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ---------------------------------------------------------------- number formats

def general(v):
    """Excel's General: integers as is, else up to 10 significant digits."""
    if v == int(v) and abs(v) < 1e11:
        return str(int(v))
    if v != 0 and (abs(v) >= 1e11 or abs(v) < 1e-9):
        mant, exp = f"{v:.5E}".split("E")
        mant = mant.rstrip("0").rstrip(".")
        return f"{mant}E{'+' if int(exp) >= 0 else '-'}{abs(int(exp)):02d}"
    out = f"{v:.10g}"
    if "e" in out:
        out = f"{v:.10f}".rstrip("0").rstrip(".")
    return out


def split_sections(code):
    out, cur, quote, i = [], "", False, 0
    while i < len(code):
        ch = code[i]
        if ch == '"':
            quote = not quote
        elif ch == "\\" and not quote and i + 1 < len(code):
            cur += code[i:i + 2]
            i += 2
            continue
        elif ch == ";" and not quote:
            out.append(cur)
            cur = ""
            i += 1
            continue
        cur += ch
        i += 1
    out.append(cur)
    return out


def tokens(section):
    """(kind, text): kind 'lit' for literal text, 'code' for format characters."""
    out, i = [], 0
    while i < len(section):
        ch = section[i]
        if ch == '"':
            j = section.find('"', i + 1)
            j = len(section) if j < 0 else j
            out.append(("lit", section[i + 1:j]))
            i = j + 1
        elif ch == "\\" and i + 1 < len(section):
            out.append(("lit", section[i + 1]))
            i += 2
        elif ch == "_" and i + 1 < len(section):
            out.append(("lit", " "))
            i += 2
        elif ch == "*" and i + 1 < len(section):
            i += 2  # fill character: drawn as nothing
        elif ch == "[":
            j = section.find("]", i)
            j = len(section) if j < 0 else j
            out.append(("br", section[i + 1:j]))
            i = j + 1
        else:
            out.append(("code", ch))
            i += 1
    return out


def is_date_format(toks):
    for kind, text in toks:
        if kind == "code" and text.lower() in "ymdhs":
            return True
        if kind == "br" and re.fullmatch(r"[hms]+", text.lower()):
            return True
    return False


def serial_to_datetime(v, date1904):
    base = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30)
    if not date1904 and v < 60:
        base = datetime.datetime(1899, 12, 31)  # Excel's 1900-02-29 that never was
    return base + datetime.timedelta(days=v)


def format_date(v, toks, date1904):
    try:
        dt = serial_to_datetime(v, date1904)
    except (OverflowError, ValueError):
        return general(v)
    # Round to the shown precision: whole seconds unless the format shows fractions.
    frac = any(k == "code" and t == "0" for k, t in toks)
    if not frac:
        dt = (dt + datetime.timedelta(milliseconds=500)).replace(microsecond=0)
    ampm = any(k == "code" and t.upper() in ("A", "P") for k, t in toks)
    # Join runs of the same letter: "yyyy", "mm", "AM/PM".
    runs, i = [], 0
    flat = []
    for k, t in toks:
        flat.extend([(k, ch) for ch in t] if k == "code" else [(k, t)])
    while i < len(flat):
        k, t = flat[i]
        if k == "code" and t.lower() in "ymdhs":
            j = i
            while j < len(flat) and flat[j][0] == "code" and flat[j][1].lower() == t.lower():
                j += 1
            runs.append(("d", t.lower() * (j - i)))
            i = j
        elif k == "code" and t.upper() == "A" and "".join(x[1] for x in flat[i:i + 5]).upper() == "AM/PM":
            runs.append(("ampm", "AM/PM"))
            i += 5
        elif k == "code" and t.upper() == "A" and "".join(x[1] for x in flat[i:i + 3]).upper() == "A/P":
            runs.append(("ampm", "A/P"))
            i += 3
        elif k == "br":
            runs.append(("elapsed", t.lower()))
            i += 1
        else:
            runs.append(("lit", t))
            i += 1
    out = []
    for n, (k, t) in enumerate(runs):
        if k == "lit":
            # ".0" after seconds: tenths.
            if t == "." and n + 1 < len(runs) and runs[n + 1] == ("lit", "0"):
                out.append(f".{dt.microsecond // 100000}")
                continue
            if t == "0" and n > 0 and runs[n - 1] == ("lit", "."):
                continue
            out.append(t)
        elif k == "ampm":
            am = dt.hour < 12
            out.append(("AM" if am else "PM") if t == "AM/PM" else ("A" if am else "P"))
        elif k == "elapsed":
            total = v * 86400
            unit = {"h": 3600, "m": 60, "s": 1}[t[0]]
            out.append(str(int(total // unit)).zfill(len(t)))
        else:
            c = t[0]
            if c == "y":
                out.append(str(dt.year) if len(t) > 2 else f"{dt.year % 100:02d}")
            elif c == "d":
                out.append({1: str(dt.day), 2: f"{dt.day:02d}", 3: DAYS[dt.weekday()][:3]}.get(len(t), DAYS[dt.weekday()]))
            elif c == "h":
                h = dt.hour % 12 or 12 if ampm else dt.hour
                out.append(f"{h:02d}" if len(t) > 1 else str(h))
            elif c == "s":
                out.append(f"{dt.second:02d}" if len(t) > 1 else str(dt.second))
            elif c == "m":
                # Minutes right after hours or right before seconds; months otherwise.
                prev = next((r for r in reversed(runs[:n]) if r[0] in ("d", "elapsed")), None)
                nxt = next((r for r in runs[n + 1:] if r[0] in ("d", "elapsed")), None)
                minutes = (prev and prev[1][0] == "h") or (nxt and nxt[1][0] == "s")
                if minutes and len(t) <= 2:
                    out.append(f"{dt.minute:02d}" if len(t) == 2 else str(dt.minute))
                else:
                    out.append({1: str(dt.month), 2: f"{dt.month:02d}", 3: MONTHS[dt.month - 1][:3],
                                5: MONTHS[dt.month - 1][0]}.get(len(t), MONTHS[dt.month - 1]))
    return "".join(out)


def format_number(v, toks):
    codes = "".join(t if k == "code" else "\0" for k, t in toks)
    # The number is the span from the first to the last placeholder; the rest is literal.
    places = [i for i, (k, t) in enumerate(toks) if k == "code" and t in "0#?.,"]
    exp = next((i for i, (k, t) in enumerate(toks) if k == "code" and t in "Ee"), None)
    if not places:
        return "".join(t for k, t in toks if k == "lit" or (k == "code" and t not in "%"))
    first, last = places[0], places[-1]
    if exp is not None:
        last = max(last, exp + 1 + sum(1 for k, t in toks[exp + 1:] if k == "code" and t in "+-0#"))
    num = "".join(t for k, t in toks[first:last + 1] if k == "code")
    v = v * 100 ** codes.count("%")
    while num.endswith(","):  # trailing commas: thousands
        num = num[:-1]
        v /= 1000
    if exp is not None:
        mant_fmt = re.split(r"[Ee]", num)[0]
        dec = len(mant_fmt.split(".")[1]) if "." in mant_fmt else 0
        s = f"{abs(v):.{dec}E}"
        m, e = s.split("E")
        body = f"{m}E{'+' if int(e) >= 0 else '-'}{abs(int(e)):02d}"
    else:
        int_part, _, dec_part = num.partition(".")
        dec = sum(1 for ch in dec_part if ch in "0#?")
        min_dec = sum(1 for ch in dec_part if ch == "0")
        # Excel rounds halves away from zero; Python's format rounds them to even.
        # The default 28 digits can't hold 1e30 to two places; a double needs at most 309 + dec.
        ctx = decimal.Context(prec=330 + dec)
        s = format(decimal.Decimal(repr(abs(v))).quantize(decimal.Decimal(1).scaleb(-dec), decimal.ROUND_HALF_UP, ctx), "f")
        whole, _, frac = s.partition(".")
        frac = frac.rstrip("0").ljust(min_dec, "0") if dec > min_dec else frac
        min_int = int_part.count("0")
        whole = whole.lstrip("0").rjust(min_int, "0") if whole != "0" or min_int else ""
        if "," in int_part and whole:
            whole = f"{int(whole):,}"
        body = whole + ("." + frac if frac or "." in num and dec_part.count("0") else "")
        if body.endswith(".") and not min_dec:
            body = body[:-1]
    pre = "".join(t for k, t in toks[:first] if k == "lit" or (k == "code" and t not in "%"))
    post = "".join(t for k, t in toks[last + 1:] if k == "lit" or (k == "code" and t not in "%Ee+-"))
    post += "%" * codes[last + 1:].count("%")
    return pre + body + post


def format_value(v, code, date1904):
    """(text, color or None) for a number under a format code."""
    if code is None or code.lower() == "general":
        return general(v), None
    sections = split_sections(code)
    if v < 0 and len(sections) > 1:
        section, v, sign = sections[1], -v, ""
    elif v == 0 and len(sections) > 2:
        section, sign = sections[2], ""
    else:
        section, sign = sections[0], "-" if v < 0 else ""
    toks = tokens(section)
    color = next((NAMED[t.lower()] for k, t in toks if k == "br" and t.lower() in NAMED), None)
    toks = [(k, t) for k, t in toks if not (k == "br" and (t.lower() in NAMED or t[:1] in "<>=" or t.lower().startswith("color")))]
    # [$€-407]: a currency symbol and a locale; keep the symbol.
    toks = [("lit", t[1:].split("-")[0]) if k == "br" and t.startswith("$") else (k, t) for k, t in toks]
    if any(k == "code" and t == "@" for k, t in toks):
        return general(v), color
    if section.strip().lower() == "general":
        return sign + general(abs(v)), color
    if is_date_format(toks):
        if v < 0:
            return "#" * 8, color
        return format_date(v, toks, date1904), color
    if any(k == "code" and t == "/" for k, t in toks):  # fractions: shown as decimals
        return sign + general(abs(v)), color
    body = format_number(abs(v), toks)
    return (sign + body if sign and any(ch.isdigit() and ch != "0" for ch in body) else body), color


# ---------------------------------------------------------------- styles and colors

def tinted(hex6, tint):
    r, g, b = (int(hex6[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l * (1 + tint) if tint < 0 else l * (1 - tint) + tint
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), s)
    return "".join(f"{round(x * 255):02X}" for x in (r, g, b))


def color_of(el, theme, indexed):
    if el is None or el.get("auto") == "1":
        return None
    hex6 = None
    if el.get("rgb"):
        hex6 = el.get("rgb")[-6:]
    elif el.get("theme") is not None:
        i = int(el.get("theme"))
        i = {0: 1, 1: 0, 2: 3, 3: 2}.get(i, i)  # Excel swaps dk/lt pairs
        hex6 = theme[i] if i < len(theme) else None
    elif el.get("indexed") is not None:
        i = int(el.get("indexed"))
        hex6 = indexed[i] if i < len(indexed) else None  # 64/65: system colors, i.e. default
    if hex6 is None:
        return None
    if el.get("tint"):
        hex6 = tinted(hex6, float(el.get("tint")))
    return "#" + hex6.upper()


def read_theme(z, path):
    try:
        root = ET.fromstring(z.read(path))
    except KeyError:
        return []
    scheme = root.find(".//a:clrScheme", NS)
    out = []
    for child in list(scheme) if scheme is not None else []:
        c = child[0] if len(child) else None
        out.append(None if c is None else (c.get("lastClr") or c.get("val") or "000000"))
    return out


def read_styles(z, path, theme):
    try:
        root = ET.fromstring(z.read(path))
    except KeyError:
        return [{}], [None]
    indexed = list(INDEXED)
    custom = root.find(f"{M}colors/{M}indexedColors")
    if custom is not None:
        indexed = [c.get("rgb", "000000")[-6:] for c in custom]
    fmts = {int(f.get("numFmtId")): f.get("formatCode") for f in root.iterfind(f"{M}numFmts/{M}numFmt")}
    fonts = []
    for f in root.iterfind(f"{M}fonts/{M}font"):
        flag = lambda tag: f.find(M + tag) is not None and f.find(M + tag).get("val", "1") not in ("0", "false", "none")
        sz = f.find(f"{M}sz")
        fonts.append({"b": flag("b"), "i": flag("i"), "u": flag("u"), "s": flag("strike"),
                      "fg": color_of(f.find(f"{M}color"), theme, indexed),
                      "pt": float(sz.get("val")) if sz is not None else None})
    fills = []
    for f in root.iterfind(f"{M}fills/{M}fill"):
        p = f.find(f"{M}patternFill")
        solid = p is not None and p.get("patternType") not in (None, "none", "gray125", "gray0625")
        fills.append(color_of(p.find(f"{M}fgColor"), theme, indexed) if solid else None)
    borders = []
    for b in root.iterfind(f"{M}borders/{M}border"):
        side = {}
        for name, key in (("top", "bt"), ("bottom", "bb"), ("left", "bl"), ("right", "br")):
            e = b.find(M + name)
            if e is not None and e.get("style") not in (None, "none"):
                side[key] = color_of(e.find(f"{M}color"), theme, indexed) or "#000000"
        borders.append(side)
    styles, codes = [], []
    for xf in root.iterfind(f"{M}cellXfs/{M}xf"):
        font = fonts[int(xf.get("fontId", 0))] if fonts else {}
        st = {k: v for k, v in font.items() if v}
        fill = fills[int(xf.get("fillId", 0))] if fills else None
        if fill:
            st["bg"] = fill
        st.update(borders[int(xf.get("borderId", 0))] if borders else {})
        al = xf.find(f"{M}alignment")
        if al is not None:
            if al.get("horizontal") in ("left", "center", "right", "centerContinuous"):
                st["h"] = "center" if al.get("horizontal") == "centerContinuous" else al.get("horizontal")
            if al.get("vertical") in ("top", "center"):
                st["v"] = al.get("vertical")
            if al.get("wrapText") in ("1", "true"):
                st["wrap"] = True
        styles.append(st)
        n = int(xf.get("numFmtId", 0))
        codes.append(fmts.get(n, BUILTIN_FORMATS.get(n)))
    return styles or [{}], codes or [None]


# ---------------------------------------------------------------- cells

def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def ref(a1):
    m = re.match(r"\$?([A-Z]+)\$?(\d+)", a1)
    return int(m.group(2)) - 1, col_index(m.group(1))


def rich_text(el):
    t = el.find(f"{M}t")
    if t is not None and not el.findall(f"{M}r"):
        return t.text or ""
    return "".join(x.text or "" for x in el.iterfind(f"{M}r/{M}t"))


def width_px(chars):
    return int(round(chars * 7 + 5)) if chars > 0 else 0


def read_sheet(z, path, shared, styles, codes, date1904, budget):
    sheet = {"colw": {}, "rowh": {}, "dcw": 64, "drh": 20, "freeze": [0, 0], "merges": [],
             "cells": [], "cut": False, "tab": None}
    extra = []  # per-cell styles from [Red]-style formats: (base style, color) -> new index
    row, col = 0, -1
    for event, el in ET.iterparse(z.open(path), events=("end",)):
        tag = el.tag[len(M):] if el.tag.startswith(M) else el.tag
        if tag == "c":
            col = ref(el.get("r"))[1] if el.get("r") else col + 1
            if el.get("r"):
                row = ref(el.get("r"))[0]
            s = int(el.get("s", 0))
            s = s if s < len(styles) else 0
            t = el.get("t", "n")
            v = el.find(f"{M}v")
            f = el.find(f"{M}f")
            raw = v.text if v is not None else None
            text, kind, color = "", "s", None
            if t == "s" and raw is not None:
                text = shared[int(raw)] if int(raw) < len(shared) else ""
            elif t == "inlineStr":
                is_ = el.find(f"{M}is")
                text = rich_text(is_) if is_ is not None else ""
            elif t == "str":
                text = raw or ""
            elif t == "b" and raw is not None:
                text, kind = ("TRUE" if raw.strip() == "1" else "FALSE"), "b"
            elif t == "e" and raw is not None:
                text, kind = raw, "e"
            elif t == "d" and raw is not None:
                text = raw
            elif raw not in (None, ""):
                try:
                    num = float(raw)
                    text, color = format_value(num, codes[s], date1904)
                    kind = "n"
                except ValueError:
                    text = raw
            formula = ("=" + f.text) if f is not None and f.text else None
            st = styles[s]
            if text or formula or "bg" in st or any(k in st for k in ("bt", "bb", "bl", "br")):
                if color and styles[s].get("fg") != color:
                    styles.append({**styles[s], "fg": color})
                    extra.append(len(styles) - 1)
                    s = len(styles) - 1
                if budget[0] <= 0:
                    sheet["cut"] = True
                else:
                    budget[0] -= 1 + len(text) // 40  # long text costs more of the 8 MiB output
                    sheet["cells"].append([row, col, text[:MAX_TEXT], s, formula, kind])
            el.clear()
        elif tag == "row":
            row = int(el.get("r")) - 1 if el.get("r") else row + 1
            col = -1
            if el.get("hidden") in ("1", "true"):
                sheet["rowh"][row] = 0
            elif el.get("ht"):  # custom, or Excel's own auto-fit saved with the file
                sheet["rowh"][row] = int(round(float(el.get("ht")) * 4 / 3))
            el.clear()
        elif tag == "col":
            w = width_px(float(el.get("width", 0))) if el.get("hidden") not in ("1", "true") else 0
            if el.get("width") or el.get("hidden"):
                for c in range(int(el.get("min")) - 1, min(int(el.get("max")), 16384)):
                    if c < 1000:
                        sheet["colw"][c] = w
        elif tag == "sheetFormatPr":
            if el.get("defaultRowHeight"):
                sheet["drh"] = int(round(float(el.get("defaultRowHeight")) * 4 / 3))
            if el.get("defaultColWidth"):
                sheet["dcw"] = width_px(float(el.get("defaultColWidth")))
            elif el.get("baseColWidth"):
                sheet["dcw"] = width_px(float(el.get("baseColWidth")) + 0.71)
        elif tag == "pane" and el.get("state") in ("frozen", "frozenSplit"):
            sheet["freeze"] = [int(float(el.get("ySplit", 0))), int(float(el.get("xSplit", 0)))]
        elif tag == "mergeCell":
            a, _, b = el.get("ref").partition(":")
            (r1, c1), (r2, c2) = ref(a), ref(b or a)
            sheet["merges"].append([r1, c1, r2, c2])
        elif tag == "tabColor":
            sheet["tab"] = color_of(el, THEME, INDEXED)
    return sheet


THEME = []


def read_workbook(path):
    global THEME
    with zipfile.ZipFile(path) as z:
        rels = {}
        wb_path = "xl/workbook.xml"
        root_rels = ET.fromstring(z.read("_rels/.rels"))
        for r in root_rels.iterfind("pr:Relationship", NS):
            if r.get("Type", "").endswith("/officeDocument"):
                wb_path = r.get("Target").lstrip("/")
        base = posixpath.dirname(wb_path)
        rel_path = posixpath.join(base, "_rels", posixpath.basename(wb_path) + ".rels")
        targets = {"styles": None, "sharedStrings": None, "theme": None}
        for r in ET.fromstring(z.read(rel_path)).iterfind("pr:Relationship", NS):
            target = r.get("Target")
            full = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
            rels[r.get("Id")] = full
            kind = r.get("Type", "").rsplit("/", 1)[-1]
            if kind in targets:
                targets[kind] = full
        wb = ET.fromstring(z.read(wb_path))
        pr = wb.find(f"{M}workbookPr")
        date1904 = pr is not None and pr.get("date1904") in ("1", "true")
        THEME = read_theme(z, targets["theme"]) if targets["theme"] else []
        styles, codes = read_styles(z, targets["styles"], THEME) if targets["styles"] else ([{}], [None])
        shared = []
        if targets["sharedStrings"]:
            for event, el in ET.iterparse(z.open(targets["sharedStrings"]), events=("end",)):
                if el.tag == f"{M}si":
                    shared.append(rich_text(el))
                    el.clear()
        view = wb.find(f"{M}bookViews/{M}workbookView")
        active = int(view.get("activeTab", 0)) if view is not None else 0
        budget = [MAX_CELLS]
        sheets = []
        for s in wb.iterfind(f"{M}sheets/{M}sheet"):
            target = rels.get(s.get(R_ID))
            if not target or target not in z.namelist():
                continue  # a chart sheet or a missing part
            sheet = read_sheet(z, target, shared, styles, codes, date1904, budget)
            sheet["name"] = s.get("name")
            sheet["hidden"] = s.get("state") in ("hidden", "veryHidden")
            sheets.append(sheet)
        return {"sheets": sheets, "styles": styles, "active": min(active, max(0, len(sheets) - 1))}


def gsheet(stub, cache):
    """A Google Drive for desktop .gsheet stub: export the sheet as .xlsx (works only for
    sheets anyone with the link can view), else report the link to open in a browser."""
    info = json.load(open(stub))
    doc = info.get("doc_id") or re.search(r"[?&]id=([\w-]+)|/d/([\w-]+)", info.get("url", "")).group(1)
    url = f"https://docs.google.com/spreadsheets/d/{doc}/edit"
    try:
        req = urllib.request.Request(f"https://docs.google.com/spreadsheets/d/{doc}/export?format=xlsx",
                                     headers={"User-Agent": "herdr-ide"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001 - any failure means: open it in a browser instead
        return {"error": f"Couldn't export this Google Sheet ({e})", "url": url}
    if not data.startswith(b"PK"):
        return {"error": "This Google Sheet isn't shared by link, so it can only be viewed in Google Sheets", "url": url}
    os.makedirs(os.path.dirname(cache) or ".", exist_ok=True)  # a local stub's first export
    with open(cache, "wb") as f:
        f.write(data)
    out = read_workbook(cache)
    out["url"] = url
    return out


def main(argv):
    try:
        out = gsheet(argv[2], argv[3]) if argv[1] == "--gsheet" else read_workbook(argv[1])
    except zipfile.BadZipFile:
        out = {"error": "Not an .xlsx workbook (legacy .xls and encrypted files aren't supported)"}
    except Exception as e:  # noqa: BLE001 - shown in the pane
        out = {"error": f"Couldn't read this workbook: {e}"}
    json.dump(out, sys.stdout, separators=(",", ":"), ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv)
