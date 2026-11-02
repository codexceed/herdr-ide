#!/usr/bin/env python3
"""Subagents of Claude Code and Codex sessions, per Herdr terminal.

argv[1]: JSON list of {"address", "kind": "claude"|"codex", "cwd"}.
stdout:  JSON {address: [{id, name, detail, status, started, ended, depth}]}
         Only running subagents are listed: finished ones disappear.

Claude: the terminal's session comes from data/swarm/claude-<terminal>.json, written by
claude_hook.py (SessionStart); else the newest transcript in the cwd's project folder.
Each subagent has <session>/subagents/agent-<id>.meta.json + .jsonl.
Codex: the newest top-level thread in the cwd (state_5.sqlite); children from
thread_spawn_edges, status from the last turn in thread_history_1.sqlite.
"""
import glob
import json
import os
import re
import sqlite3
import sys
import time

HOME = os.path.expanduser("~")
APP = os.path.join(HOME, ".config", "herdr-app")
STALE = 120  # an unfinished Claude subagent silent this long (s) counts as stopped
now = time.time()


def claude_session(address, cwds):
    try:
        with open(os.path.join(APP, "data", "swarm", f"claude-{address}.json")) as f:
            path = json.load(f).get("transcript_path")
        if path and os.path.exists(path):
            return path
    except (OSError, ValueError):
        pass
    # Newest transcript among the candidate folders' projects.
    sessions = []
    for cwd in cwds:
        project = os.path.join(HOME, ".claude", "projects", re.sub(r"[^A-Za-z0-9-]", "-", cwd))
        sessions += glob.glob(os.path.join(project, "*.jsonl"))
    return max(sessions, key=os.path.getmtime) if sessions else None


def claude_children(address, cwds):
    transcript = claude_session(address, cwds)
    if not transcript:
        return []
    out = []
    for meta_path in glob.glob(os.path.join(transcript[:-6], "subagents", "agent-*.meta.json")):
        log = meta_path[: -len(".meta.json")] + ".jsonl"
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            st = os.stat(log)
        except (OSError, ValueError):
            continue
        started = getattr(st, "st_birthtime", st.st_ctime)
        if meta.get("finished"):
            status, ended = "done", st.st_mtime
        elif now - st.st_mtime > STALE:
            status, ended = "stopped", st.st_mtime
        else:
            status, ended = "working", None
        if status != "working":
            continue
        out.append({
            "id": os.path.basename(log)[6:-6],
            "name": meta.get("description") or meta.get("agentType") or "subagent",
            "detail": meta.get("agentType", ""),
            "status": status, "started": started, "ended": ended,
            "depth": max(0, int(meta.get("spawnDepth") or 1) - 1),
        })
    return sorted(out, key=lambda c: c["started"])


def codex_db():
    state = os.path.join(HOME, ".codex", "state_5.sqlite")
    history = os.path.join(HOME, ".codex", "thread_history_1.sqlite")
    if not os.path.exists(state):
        return None
    db = sqlite3.connect(f"file:{state}?mode=ro", uri=True, timeout=1)
    if os.path.exists(history):
        db.execute("ATTACH DATABASE ? AS h", (f"file:{history}?mode=ro",))
    return db


TURN = {"completed": "done", "failed": "error", "interrupted": "stopped"}


def codex_children(db, thread, depth=0):
    if depth > 3:
        return []
    rows = db.execute(
        """SELECT t.id, t.agent_nickname, t.agent_path, t.title, t.first_user_message,
                  t.created_at_ms, t.updated_at_ms,
                  (SELECT status FROM h.thread_turns WHERE thread_id = t.id ORDER BY rollout_ordinal DESC LIMIT 1),
                  (SELECT completed_at FROM h.thread_turns WHERE thread_id = t.id ORDER BY rollout_ordinal DESC LIMIT 1)
           FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
           WHERE e.parent_thread_id = ? ORDER BY t.created_at_ms""", (thread,)).fetchall()
    out = []
    for cid, nick, path, title, first, created, updated, turn, completed in rows:
        status = TURN.get(turn, "working") if turn else "working"
        ended = (completed or (updated or 0) / 1000) if status != "working" else None
        if status == "working" and now - (updated or 0) / 1000 > 6 * 3600:
            status, ended = "stopped", (updated or 0) / 1000  # orphaned: never finished
        kids = codex_children(db, cid, depth + 1)
        if status != "working" and not kids:
            continue  # finished; kept only while one of its own children still runs
        task = (path or "").rsplit("/", 1)[-1] or (title or first or "").strip().split("\n")[0][:80]
        out.append({"id": cid, "name": nick or task or "subagent", "detail": task if nick else "",
                    "status": status, "started": (created or 0) / 1000, "ended": ended, "depth": depth})
        out.extend(kids)
    return out


def main():
    terminals = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    result = {}
    for t in terminals:
        if t.get("kind") == "claude":
            kids = claude_children(t["address"], t.get("cwds") or [c for c in [t.get("cwd")] if c])
            if kids:
                result[t["address"]] = kids
    codex = [t for t in terminals if t.get("kind") == "codex" and t.get("cwd")]
    if codex:
        try:
            db = codex_db()
        except sqlite3.Error:
            db = None
        if db:
            taken = set()
            for t in codex:
                # Newest top-level thread in this folder not already given to another terminal.
                row = None
                for (tid,) in db.execute(
                        """SELECT id FROM threads WHERE cwd = ? AND archived = 0
                           AND COALESCE(thread_source, 'user') != 'subagent'
                           ORDER BY updated_at_ms DESC LIMIT 5""", (t["cwd"],)):
                    if tid not in taken:
                        row = tid
                        break
                if not row:
                    continue
                taken.add(row)
                try:
                    kids = codex_children(db, row)
                except sqlite3.Error:
                    kids = []
                if kids:
                    result[t["address"]] = kids
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
