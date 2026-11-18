#!/usr/bin/env python3
"""Works out herdr-ide's next release from the commits since the last tag.

Same rules as dev-tools' release workflow, but the version lives only in tags
(vX.Y.Z), because main is protected and a bot can't push a release commit:

- feat, or a breaking change (type!:), bumps the minor (no majors yet);
- anything else bumps the patch;
- no commits since the last tag: no release.

    python3 release.py --notes NOTES.md   # prints the next version (empty: none), writes its notes
"""

import argparse
import re
import subprocess
from datetime import date

CONVENTIONAL = re.compile(r"^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$")
SECTIONS = [
    ("breaking", "Breaking Changes"), ("feat", "Features"), ("fix", "Bug Fixes"), ("perf", "Performance"),
    ("refactor", "Refactoring"), ("docs", "Documentation"), ("style", "Styling"), ("test", "Tests"),
    ("build", "Build"), ("ci", "CI"), ("chore", "Chores"), ("other", "Other"),
]


def bump(version, subjects):
    """The version after `subjects` (commit subject lines), or None when there are none."""
    if not subjects:
        return None
    major, minor, patch = (int(x) for x in version.split("."))
    minor_bump = any((m := CONVENTIONAL.match(s)) and (m.group(3) or m.group(1) == "feat") for s in subjects)
    return f"{major}.{minor + 1}.0" if minor_bump else f"{major}.{minor}.{patch + 1}"


def notes(version, commits, today=None):
    """Release notes for `commits` ([(subject, short hash)]), grouped like dev-tools' CHANGELOG."""
    groups = {key: [] for key, _ in SECTIONS}
    for subject, sha in commits:
        m = CONVENTIONAL.match(subject)
        kind, scope, breaking, desc = m.groups() if m else ("other", None, None, subject)
        desc = desc.replace("`", r"\`").replace("*", r"\*").replace("_", r"\_")
        entry = f"- **{scope}**: {desc} (`{sha}`)" if scope else f"- {desc} (`{sha}`)"
        groups["breaking" if breaking else kind if kind in groups else "other"].append(entry)
    lines = [f"## [{version}] - {(today or date.today()).isoformat()}", ""]
    for key, title in SECTIONS:
        if groups[key]:
            lines += [f"### {title}", "", *groups[key], ""]
    return "\n".join(lines)


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--notes", required=True, help="file to write the release notes to")
    args = p.parse_args(argv)
    last = git("describe", "--tags", "--abbrev=0", "--match", "v*")
    if last.returncode != 0:
        raise SystemExit("no v* tag yet: tag the first release by hand")
    tag = last.stdout.strip()
    log = git("log", f"{tag}..HEAD", "--no-merges", "--pretty=format:%s|%h").stdout
    commits = [tuple(line.rsplit("|", 1)) for line in log.splitlines() if "|" in line]
    version = bump(tag.removeprefix("v"), [s for s, _ in commits])
    if version:
        with open(args.notes, "w") as f:
            f.write(notes(version, commits) + "\n")
    print(version or "")


if __name__ == "__main__":
    main()
