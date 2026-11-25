"""Tests for mods/ide-editor/xlsx_read.py: number formats, and the fixture workbook end to end."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "mods", "ide-editor"))
import xlsx_read  # noqa: E402

BOOK = os.path.join(HERE, "fixtures", "book.xlsx")


def fmt(v, code):
    return xlsx_read.format_value(v, code, False)[0]


class Formats(unittest.TestCase):
    def test_general(self):
        self.assertEqual(fmt(42, "General"), "42")
        self.assertEqual(fmt(0.1 + 0.2, "General"), "0.3")
        self.assertEqual(fmt(1234567890123456, "General"), "1.23457E+15")

    def test_numbers(self):
        self.assertEqual(fmt(1234567.891, "#,##0.00"), "1,234,567.89")
        self.assertEqual(fmt(1234.5, "0"), "1235")
        self.assertEqual(fmt(0.5, "0.00"), "0.50")
        self.assertEqual(fmt(0.4567, "0.0%"), "45.7%")
        self.assertEqual(fmt(12345, "0.00E+00"), "1.23E+04")
        self.assertEqual(fmt(1500000, '#,##0.0,,"M"'), "1.5M")

    def test_sections_and_colors(self):
        code = '"$"#,##0.00;[Red]-"$"#,##0.00'
        self.assertEqual(xlsx_read.format_value(-9876.5, code, False), ("-$9,876.50", "#FF0000"))
        self.assertEqual(fmt(-5, "#,##0 ;(#,##0)"), "(5)")
        self.assertEqual(fmt(0, '0;-0;"zero"'), "zero")
        self.assertEqual(fmt(-3, "0.00"), "-3.00")

    def test_dates(self):
        self.assertEqual(fmt(45366, "yyyy-mm-dd"), "2024-03-15")
        self.assertEqual(fmt(45366, "m/d/yyyy"), "3/15/2024")
        self.assertEqual(fmt(45366, "dddd, mmmm d"), "Friday, March 15")
        self.assertEqual(fmt(45659.5729166, "h:mm AM/PM"), "1:45 PM")
        self.assertEqual(fmt(45659.5729166, "hh:mm:ss"), "13:45:00")
        self.assertEqual(fmt(1.5, "[h]:mm"), "36:00")
        self.assertEqual(xlsx_read.format_value(0, "yyyy-mm-dd", True)[0], "1904-01-01")


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.run([sys.executable, os.path.join(HERE, "..", "mods", "ide-editor", "xlsx_read.py"), BOOK],
                             capture_output=True, text=True, check=True)
        cls.book = json.loads(out.stdout)
        cls.summary = cls.book["sheets"][0]
        cls.cells = {(c[0], c[1]): c for c in cls.summary["cells"]}

    def test_sheets(self):
        self.assertEqual([(s["name"], s["hidden"]) for s in self.book["sheets"]],
                         [("Summary", False), ("Data", False), ("Hidden", True)])
        self.assertEqual(self.summary["tab"], "#1F7A1F")
        self.assertEqual(len(self.book["sheets"][1]["cells"]), 120)

    def test_layout(self):
        self.assertEqual(self.summary["freeze"], [2, 1])
        self.assertEqual(self.summary["merges"], [[0, 0, 0, 3]])
        self.assertEqual(self.summary["colw"]["5"], 0)  # hidden column F
        self.assertEqual(self.summary["rowh"]["0"], 40)  # 30pt

    def test_values(self):
        self.assertEqual(self.cells[(2, 0)][2], "North")  # shared string with rich-text runs
        self.assertEqual(self.cells[(2, 1)][2:], ["1,234,567.89", 3, None, "n"])
        self.assertEqual(self.cells[(2, 4)][2], "TRUE")
        self.assertEqual(self.cells[(3, 3)][2], "2 Jan 2025 1:45 PM")
        self.assertEqual(self.cells[(4, 1)][2], "1,224,691.39")
        self.assertEqual(self.cells[(4, 1)][4], "=SUM(B3:B4)")

    def test_styles(self):
        styles = self.book["styles"]
        title = styles[self.cells[(0, 0)][3]]
        self.assertEqual((title["b"], title["fg"], title["bg"], title["pt"]), (True, "#FFFFFF", "#217346", 14.0))
        self.assertEqual(styles[self.cells[(1, 0)][3]]["bb"], "#000000")
        self.assertEqual(styles[self.cells[(3, 1)][3]]["fg"], "#FF0000")  # [Red] negative
        self.assertTrue(styles[self.cells[(4, 0)][3]]["i"])
        self.assertEqual(styles[self.cells[(7, 2)][3]]["h"], "center")

    def test_not_a_workbook(self):
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as f:
            f.write(b"not a zip")
            f.flush()
            out = subprocess.run([sys.executable, os.path.join(HERE, "..", "mods", "ide-editor", "xlsx_read.py"), f.name],
                                 capture_output=True, text=True, check=True)
        self.assertIn("Not an .xlsx workbook", json.loads(out.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
