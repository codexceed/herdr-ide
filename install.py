#!/usr/bin/env python3
"""Install (or remove) the herdr-ide layout into the Herdr app's home.

    python3 install.py                 # install or update, then switch to it
    python3 install.py --uninstall     # remove the layout, its mods and its keys

Installing copies layouts/herdr-ide.json (+ its preview) and mods/ide-* into
~/.config/herdr-app (or $HERDR_APP_HOME / --home), merges keys.json into the
person's keys, installs mermaid-cli for diagrams when it's missing, checks each
mod with `herdr-app check` and switches the window to the layout.

Older copies of the layout or mods are moved to <home>/backups/herdr-ide-<time>/
first, never overwritten. A key the person already uses for something else is
kept and reported; pass --replace-keys to take it.
"""
import argparse
import datetime
import filecmp
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUT = "herdr-ide"
PREVIEW = "preview.png"
SKIP = {"__pycache__", ".DS_Store", "gpui-kit.d.ts", "jsconfig.json"}


def say(msg):
    print(f"herdr-ide: {msg}")


def default_home():
    return os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")


def mods():
    return sorted(m for m in os.listdir(os.path.join(HERE, "mods")) if not m.startswith("."))


def same_tree(a, b):
    """True when folder b holds exactly a's files (ignoring files the app writes)."""
    cmp = filecmp.dircmp(a, b, ignore=list(SKIP))
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    _, mismatch, errors = filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)
    return not mismatch and not errors and all(same_tree(os.path.join(a, d), os.path.join(b, d)) for d in cmp.common_dirs)


class Backup:
    def __init__(self, home):
        self.home, self.dir = home, None

    def move(self, path):
        if not os.path.lexists(path):
            return
        if not self.dir:
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            self.dir = os.path.join(self.home, "backups", f"{LAYOUT}-{stamp}")
            os.makedirs(self.dir)
        shutil.move(path, os.path.join(self.dir, os.path.relpath(path, self.home).replace(os.sep, "__")))


def copy_files(home):
    backup = Backup(home)
    os.makedirs(os.path.join(home, "layouts"), exist_ok=True)
    os.makedirs(os.path.join(home, "mods"), exist_ok=True)
    changed = []
    pairs = [(os.path.join(HERE, "layouts", f"{LAYOUT}.json"), os.path.join(home, "layouts", f"{LAYOUT}.json"))]
    if os.path.exists(os.path.join(HERE, PREVIEW)):
        pairs.append((os.path.join(HERE, PREVIEW), os.path.join(home, "layouts", f"{LAYOUT}.png")))
    for src, dst in pairs:
        if os.path.exists(dst) and filecmp.cmp(src, dst, shallow=False):
            continue
        backup.move(dst)
        shutil.copy2(src, dst)
        changed.append(os.path.relpath(dst, home))
    for mod in mods():
        src, dst = os.path.join(HERE, "mods", mod), os.path.join(home, "mods", mod)
        if os.path.isdir(dst) and same_tree(src, dst):
            continue
        backup.move(dst)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns(*SKIP))
        changed.append(f"mods/{mod}/")
    say(f"copied {', '.join(changed)}" if changed else "layout and mods already up to date")
    if backup.dir:
        say(f"older copies moved to {backup.dir}")


def load_keys(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def merge_keys(home, replace):
    ours = load_keys(os.path.join(HERE, "keys.json"))
    path = os.path.join(home, "keys.json")
    theirs = load_keys(path)
    added, kept = [], []
    for section, keys in ours.items():
        target = theirs.setdefault(section, {})
        for key, action in keys.items():
            if target.get(key) == action:
                continue
            if key in target and not replace:
                kept.append(f"{section} {key} (yours: {target[key]}; ours: {action})")
                continue
            target[key] = action
            added.append(f"{key} -> {action}")
    if added:
        write_json(path, theirs)
        say(f"keys added: {', '.join(added)}")
    for k in kept:
        say(f"kept your key {k}; rerun with --replace-keys to use ours")


def remove_keys(home):
    ours = load_keys(os.path.join(HERE, "keys.json"))
    path = os.path.join(home, "keys.json")
    theirs = load_keys(path)
    removed = 0
    for section, keys in ours.items():
        for key, action in keys.items():
            if theirs.get(section, {}).get(key) == action:
                del theirs[section][key]
                removed += 1
        if section in theirs and not theirs[section]:
            del theirs[section]
    if removed:
        write_json(path, theirs)
    say(f"removed {removed} key binding(s)")


def ensure_mermaid():
    if shutil.which("mmdc"):
        say("mermaid-cli already installed")
        return
    if not shutil.which("npm"):
        say("npm not found: skipped mermaid-cli (diagrams will show an install hint). Install Node, then rerun.")
        return
    say("installing mermaid-cli (npm i -g @mermaid-js/mermaid-cli) and its headless Chrome")
    if subprocess.run(["npm", "i", "-g", "@mermaid-js/mermaid-cli"]).returncode != 0:
        say("mermaid-cli install failed; diagrams will show an install hint")
        return
    # npm may block puppeteer's postinstall, which downloads the browser; fetch it explicitly.
    root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
    subprocess.run(["npx", "--yes", "puppeteer", "browsers", "install", "chrome-headless-shell"],
                   cwd=os.path.join(root, "@mermaid-js", "mermaid-cli") if root else None)


def herdr_app():
    """The herdr-app CLI. Herdr links it into ~/.local/bin on its first start; before that,
    the app's own binary takes the same arguments."""
    return shutil.which("herdr-app") or next((p for p in [
        os.path.expanduser("~/.local/bin/herdr-app"),
        "/Applications/Herdr.app/Contents/MacOS/Herdr",
        os.path.expanduser("~/Applications/Herdr.app/Contents/MacOS/Herdr"),
    ] if os.path.exists(p)), None)


def open_on_start(home):
    """Herdr isn't running for `home`: make it start on the layout. It reads the shown layout
    from shared.json at start, after installing its own mods."""
    path = os.path.join(home, "shared.json")
    try:
        shared = load_keys(path)
    except ValueError:
        say("shared.json is unreadable: open Herdr and press ctrl-shift-l (or Settings > Look) to pick herdr-ide")
        return
    shared["layout"] = LAYOUT
    write_json(path, shared)
    say("Herdr isn't running: it will open on herdr-ide next time it starts")


def run_app(app, home, *args):
    """Runs herdr-app against `home`'s window only: without HERDR_APP_HOME it would reach the
    window of ~/.config/herdr-app, whatever --home says (tests install into a temp home)."""
    return subprocess.run([app, *args], capture_output=True, text=True, env={**os.environ, "HERDR_APP_HOME": home})


def check_and_switch(home, switch):
    app = herdr_app()
    if not app:
        say("herdr-app not found: skipped mod checks")
        if switch:
            open_on_start(home)
        return True
    ok = True
    for mod in mods():
        r = run_app(app, home, "check", os.path.join(home, "mods", mod))
        if r.returncode != 0:
            ok = False
            say(f"check failed for {mod}:\n{(r.stdout + r.stderr).strip()}")
    say("all mods pass herdr-app check" if ok else "some mods failed their check; the layout may not work")
    if switch and ok:
        r = run_app(app, home, "do", "layout.switch", "--name", LAYOUT)
        if r.returncode == 0:
            say("switched to the herdr-ide layout")
        else:
            open_on_start(home)
    return ok


def uninstall(home):
    app = herdr_app()
    if app:  # leave the layout first, so Herdr doesn't keep showing it
        run_app(app, home, "do", "layout.switch", "--name", "main")
    backup = Backup(home)
    for name in [f"layouts/{LAYOUT}.json", f"layouts/{LAYOUT}.png"] + [f"mods/{m}" for m in mods()]:
        backup.move(os.path.join(home, name))
    remove_keys(home)
    say(f"removed; files kept in {backup.dir}" if backup.dir else "nothing to remove")


def main(argv=None):
    p = argparse.ArgumentParser(description="Install the herdr-ide Herdr layout.")
    p.add_argument("--home", default=default_home(), help="Herdr app home (default: ~/.config/herdr-app)")
    p.add_argument("--uninstall", action="store_true", help="remove the layout, its mods and its keys")
    p.add_argument("--replace-keys", action="store_true", help="take keys you already bound to something else")
    p.add_argument("--no-mermaid", action="store_true", help="don't install mermaid-cli")
    p.add_argument("--no-switch", action="store_true", help="don't switch the window to the layout")
    p.add_argument("--no-check", action="store_true", help="don't run herdr-app check (and don't switch)")
    args = p.parse_args(argv)
    home = os.path.abspath(os.path.expanduser(args.home))
    if args.uninstall:
        uninstall(home)
        return 0
    copy_files(home)
    merge_keys(home, args.replace_keys)
    if not args.no_mermaid:
        ensure_mermaid()
    ok = True if args.no_check else check_and_switch(home, not args.no_switch)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
