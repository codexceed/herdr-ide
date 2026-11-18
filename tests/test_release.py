"""Tests for release.py: the next version and its notes from commit subjects."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import release  # noqa: E402


class BumpTest(unittest.TestCase):
    def test_no_commits_no_release(self):
        self.assertIsNone(release.bump("0.6.0", []))

    def test_a_feature_bumps_the_minor(self):
        self.assertEqual(release.bump("0.6.3", ["fix(x): y", "feat(find): z"]), "0.7.0")

    def test_breaking_is_capped_at_minor(self):
        self.assertEqual(release.bump("0.6.3", ["fix!: drop old keys"]), "0.7.0")

    def test_anything_else_bumps_the_patch(self):
        self.assertEqual(release.bump("0.6.0", ["ci: release tags", "Editor pane fixes (#5)"]), "0.6.1")


class NotesTest(unittest.TestCase):
    def test_grouped_like_the_dev_tools_changelog(self):
        text = release.notes("0.7.0", [("feat(find): ⌘F `search`", "852e20d"), ("fix: a_b", "0356271"),
                                       ("Plain subject", "8fa6555")], today=datetime.date(2026, 11, 18))
        self.assertEqual(text.splitlines(), [
            "## [0.7.0] - 2026-11-18", "",
            "### Features", "", r"- **find**: ⌘F \`search\` (`852e20d`)", "",
            "### Bug Fixes", "", r"- a\_b (`0356271`)", "",
            "### Other", "", "- Plain subject (`8fa6555`)",
        ])


if __name__ == "__main__":
    unittest.main()
