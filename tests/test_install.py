"""Tests for install.py: copying, key merging, updates and uninstall, in a temp Herdr home."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import install  # noqa: E402

QUIET = ["--no-mermaid", "--no-check"]


def run(home, *extra):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        code = install.main(["--home", home, *QUIET, *extra])
    return code, out.getvalue()


def read(path):
    with open(path) as f:
        return f.read()


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def keys(self):
        return json.loads(read(os.path.join(self.home, "keys.json")))

    def test_fresh_install_copies_layout_mods_and_keys(self):
        code, _ = run(self.home)
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(os.path.join(self.home, "layouts", "herdr-ide.json")))
        for mod in install.mods():
            self.assertTrue(os.path.exists(os.path.join(self.home, "mods", mod, "main.js")), mod)
        self.assertEqual(self.keys(), json.loads(read(os.path.join(install.HERE, "keys.json"))))

    def test_layout_only_references_shipped_or_packaged_mods(self):
        layout = read(os.path.join(install.HERE, "layouts", "herdr-ide.json"))
        shipped = {"spaces", "tabs", "changes", "pane", "workspace-status", "new-menu"}
        mods = set(json.loads('["' + '","'.join(
            part.split('"')[0] for part in layout.split('"mod": "')[1:]) + '"]'))
        self.assertTrue(mods <= shipped | set(install.mods()), mods - shipped - set(install.mods()))

    def test_reinstall_is_a_no_op(self):
        run(self.home)
        _, out = run(self.home)
        self.assertIn("already up to date", out)
        self.assertFalse(os.path.exists(os.path.join(self.home, "backups")))

    def test_changed_mod_is_backed_up_then_replaced(self):
        run(self.home)
        main = os.path.join(self.home, "mods", "ide-files", "main.js")
        with open(main, "w") as f:
            f.write("// local edit")
        _, out = run(self.home)
        self.assertIn("older copies moved", out)
        self.assertNotEqual(read(main), "// local edit")
        backups = os.listdir(os.path.join(self.home, "backups"))
        self.assertEqual(len(backups), 1)

    def test_existing_conflicting_key_is_kept(self):
        with open(os.path.join(self.home, "keys.json"), "w") as f:
            json.dump({"global": {"cmd-t": "tab.new"}, "mod:ide-editor": {"cmd-w": "mine"}}, f)
        _, out = run(self.home)
        keys = self.keys()
        self.assertEqual(keys["mod:ide-editor"]["cmd-w"], "mine")
        self.assertEqual(keys["global"], {"cmd-t": "tab.new"})
        self.assertIn("kept your key", out)
        run(self.home, "--replace-keys")
        self.assertEqual(self.keys()["mod:ide-editor"]["cmd-w"], "ide-editor.close")

    def test_herdr_app_only_reaches_the_installed_homes_window(self):
        calls = []
        real = (install.herdr_app, install.subprocess.run)
        install.herdr_app = lambda: "herdr-app"
        install.subprocess.run = lambda args, **kw: calls.append((args, kw.get("env", {}).get("HERDR_APP_HOME"))) or \
            type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                install.main(["--home", self.home, "--no-mermaid"])
                install.main(["--home", self.home, "--uninstall"])
        finally:
            install.herdr_app, install.subprocess.run = real
        app_calls = [c for c in calls if c[0][0] == "herdr-app"]
        self.assertTrue(any("layout.switch" in args for args, _ in app_calls))
        self.assertEqual({home for _, home in app_calls}, {self.home})

    def test_uninstall_removes_only_ours(self):
        with open(os.path.join(self.home, "keys.json"), "w") as f:
            json.dump({"global": {"cmd-t": "tab.new"}}, f)
        run(self.home)
        run(self.home, "--uninstall")
        self.assertFalse(os.path.exists(os.path.join(self.home, "layouts", "herdr-ide.json")))
        for mod in install.mods():
            self.assertFalse(os.path.exists(os.path.join(self.home, "mods", mod)))
        self.assertEqual(self.keys(), {"global": {"cmd-t": "tab.new"}})


if __name__ == "__main__":
    unittest.main()
