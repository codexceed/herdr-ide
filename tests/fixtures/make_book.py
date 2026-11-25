"""Builds tests/fixtures/book.xlsx, the workbook the sheet tests read.

Needs openpyxl (dev only: `pip install openpyxl`); the parser itself is stdlib-only, and
the built file is committed so the tests don't need openpyxl. openpyxl writes no cached
formula results, so this patches one in, as Excel would have saved it.
"""
import datetime
import os
import re
import shutil
import zipfile

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "book.xlsx")

wb = Workbook()
ws = wb.active
ws.title = "Summary"
ws.sheet_properties.tabColor = "1F7A1F"
ws["A1"] = "Quarterly report"
ws["A1"].font = Font(bold=True, size=14, color="FFFFFF")
ws["A1"].fill = PatternFill("solid", fgColor="217346")
ws.merge_cells("A1:D1")
ws.append(["Region", "Revenue", "Share", "Since"])
for cell in ws[2]:
    cell.font = Font(bold=True)
    cell.border = Border(bottom=Side(style="thin", color="000000"))
ws.append(["North", 1234567.891, 0.4567, datetime.date(2024, 3, 15)])
ws.append(["South", -9876.5, 0.12, datetime.datetime(2025, 1, 2, 13, 45)])
ws["B3"].number_format = "#,##0.00"
ws["B4"].number_format = '"$"#,##0.00;[Red]-"$"#,##0.00'
ws["C3"].number_format = "0.0%"
ws["C4"].number_format = "0%"
ws["D3"].number_format = "yyyy-mm-dd"
ws["D4"].number_format = "d mmm yyyy h:mm AM/PM"
ws["A5"] = "Total"
ws["A5"].font = Font(italic=True)
ws["B5"] = "=SUM(B3:B4)"
ws["B5"].number_format = "#,##0.00"
ws["E3"] = True
ws["A7"] = "A long note that spills into the empty cells to its right"
ws["C8"] = "centered"
ws["C8"].alignment = Alignment(horizontal="center")
ws.column_dimensions["A"].width = 18
ws.column_dimensions["B"].width = 14  # Excel widens columns as you type; openpyxl doesn't
ws.column_dimensions["D"].width = 22
ws.column_dimensions["F"].hidden = True
ws.row_dimensions[1].height = 30
ws.freeze_panes = "B3"

data = wb.create_sheet("Data")
for r in range(1, 41):
    data.append([r, f"item {r}", r * 1.5])

hidden = wb.create_sheet("Hidden")
hidden.sheet_state = "hidden"
hidden["A1"] = "secret"

wb.save(OUT)

# Patch the cached result of B5 (=SUM(B3:B4)) into the saved sheet, and store A3 as a shared
# string with rich-text runs, as Excel does (openpyxl writes inline strings).
SST = (b'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">'
       b'<si><r><t>Nor</t></r><r><rPr><b/></rPr><t>th</t></r></si></sst>')
tmp = OUT + ".part"  # beside OUT, so the move is a rename
with zipfile.ZipFile(OUT) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
    for item in src.infolist():
        data_ = src.read(item.filename)
        if item.filename == "xl/worksheets/sheet1.xml":
            data_ = re.sub(rb"(<c r=\"B5\"[^>]*><f>SUM\(B3:B4\)</f>)(<v>\s*</v>|<v\s*/>)?", rb"\1<v>1224691.391</v>", data_)
            data_ = data_.replace(b'<c r="A3" t="inlineStr"><is><t>North</t></is></c>', b'<c r="A3" t="s"><v>0</v></c>')
        elif item.filename == "[Content_Types].xml":
            data_ = data_.replace(b"</Types>", b'<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
        elif item.filename == "xl/_rels/workbook.xml.rels":
            data_ = data_.replace(b"</Relationships>", b'<Relationship Id="rIdSST" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
        dst.writestr(item, data_)
    dst.writestr("xl/sharedStrings.xml", SST)
shutil.move(tmp, OUT)
print(OUT)
