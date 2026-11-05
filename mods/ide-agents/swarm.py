#!/usr/bin/env python3
"""Subagents of Claude Code and Codex sessions, per Herdr terminal.

argv[1]: JSON list of {"address", "kind": "claude"|"codex", "cwd"}.
stdout:  JSON {address: [{id, name, detail, status, started, ended, depth}]}
         Only running or waiting subagents are listed: finished ones disappear.

Folders: the agent's own process folder (`hc get`) first, then the ones passed in. The shell
can start in one repo and the agent run in another, so the first folder with a session wins.
Claude: the terminal's session comes from data/swarm/claude-<terminal>.json, written by
claude_hook.py (SessionStart); else from ~/.claude/sessions/<pid>.json, which Claude Code keeps
for each running process (pid from `hc get`); else the newest transcript, not already shown
under another terminal, in the first folder that has one.
Each subagent has <session>/subagents/agent-<id>.meta.json + .jsonl. It runs while its log
ends mid tool call (a long command writes nothing until it returns) or was written in the last
STALE seconds; it waits while its parent's latest notification about it says it is waiting on
its own background work. `finished` in the meta is set at every turn end, even before a revive.
Codex: the newest top-level thread in the cwd (state_5.sqlite); children from
thread_spawn_edges, status from the last turn in thread_history_1.sqlite.
"""
import glob
import json
import mmap
import os
import re
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
APP = os.path.join(HOME, ".config", "herdr-app")
STALE = 120  # a Claude subagent silent this long (s), outside a tool call, counts as stopped
ORPHAN = 6 * 3600  # running a tool or waiting this long without a word counts as stopped
WAITING = b"is waiting on its own background work"
now = time.time()


_foreground = {}


def foreground(address):
    """The terminal's foreground program (the agent) per `hc get`: {"pid", "cwd", ...}, or {}."""
    if address not in _foreground:
        try:
            r = subprocess.run(["hc", "get", address, "--json"], capture_output=True, text=True, timeout=2)
            fg = json.loads(r.stdout).get("foreground") if r.returncode == 0 else None
        except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
            fg = None
        _foreground[address] = fg if isinstance(fg, dict) else {}
    return _foreground[address]


def agent_cwd(address):
    """Where the terminal's foreground program (the agent) runs; None if unknown."""
    return foreground(address).get("cwd")


def agent_pid(address):
    """The terminal's foreground program's pid; None if unknown."""
    return foreground(address).get("pid")


def folders(t):
    """The terminal's candidate folders, most telling first, without repeats."""
    given = t.get("cwds") or [t.get("cwd")]
    return list(dict.fromkeys(c for c in [agent_cwd(t["address"]), t.get("cwd"), *given] if c))


def project(cwd):
    return os.path.join(HOME, ".claude", "projects", re.sub(r"[^A-Za-z0-9-]", "-", cwd))


def hooked_session(address):
    """The transcript claude_hook.py recorded for this terminal; None without the hook."""
    try:
        with open(os.path.join(APP, "data", "swarm", f"claude-{address}.json")) as f:
            path = json.load(f).get("transcript_path")
        return path if path and os.path.exists(path) else None
    except (OSError, ValueError, AttributeError):
        return None


def pid_session(address):
    """The transcript of the Claude process running in this terminal, from the record Claude Code
    keeps per process in ~/.claude/sessions/<pid>.json; None if there is none."""
    pid = agent_pid(address)
    if not pid:
        return None
    try:
        with open(os.path.join(HOME, ".claude", "sessions", f"{pid}.json")) as f:
            record = json.load(f)
        sid, cwd = record.get("sessionId"), record.get("cwd")
    except (OSError, ValueError, AttributeError):
        return None
    if not sid or record.get("pid", pid) != pid:
        return None
    path = os.path.join(project(cwd), f"{sid}.jsonl") if cwd else ""
    if os.path.exists(path):
        return path
    found = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{glob.escape(sid)}.jsonl"))
    return found[0] if found else None


def claude_session(address, cwds, taken=()):
    """The terminal's Claude transcript: exactly (hook, then pid), else a guess by folder that
    skips transcripts in `taken`, so two terminals in one folder never share a session."""
    exact = hooked_session(address) or pid_session(address)
    if exact:
        return exact
    # Newest transcript in the first folder that has one: newest across all of them would hand
    # this terminal a busier session that only shares the folder its shell started in.
    for cwd in cwds:
        sessions = [s for s in glob.glob(os.path.join(project(cwd), "*.jsonl")) if s not in taken]
        if sessions:
            return max(sessions, key=os.path.getmtime)
    return None


def last_turn(log):
    """How a subagent log ends: "tool" (mid tool call), "end" (turn over), "busy" or None."""
    with open(log, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 65536))
        lines = f.read().splitlines()
    for line in reversed(lines):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("type") == "assistant":
            return "end" if (r.get("message") or {}).get("stop_reason") == "end_turn" else "tool"
        if r.get("type") == "user":
            return "busy"
    return None


def waiting(transcript, agent):
    """True when the parent's latest notification about `agent` says it waits on background work."""
    try:
        with open(transcript, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as m:
            at = m.rfind(f"<task-id>{agent}</task-id>".encode())
            end = m.find(b"</summary>", at) if at >= 0 else -1
            return end > 0 and m.find(WAITING, at, end) >= 0
    except (OSError, ValueError):
        return False


def claude_children(address, cwds, transcript=None):
    transcript = transcript or claude_session(address, cwds)
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
        started, age, agent = getattr(st, "st_birthtime", st.st_ctime), now - st.st_mtime, os.path.basename(log)[6:-6]
        if meta.get("finished") and age > ORPHAN:
            continue
        try:
            turn = last_turn(log)
        except OSError:
            continue
        if turn == "end" and age < ORPHAN and waiting(transcript, agent):
            status = "waiting"
        elif turn == "end" and meta.get("finished"):
            continue  # done
        elif (turn == "tool" and age < ORPHAN) or age < STALE:
            status = "working"
        else:
            continue  # stopped
        out.append({
            "id": agent,
            "name": meta.get("description") or meta.get("agentType") or "subagent",
            "detail": meta.get("agentType", ""),
            "status": status, "started": started, "ended": None,
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
    for t in terminals:
        t["cwds"] = folders(t)
        t["cwd"] = t["cwds"][0] if t["cwds"] else None
    result = {}
    claude = [t for t in terminals if t.get("kind") == "claude"]
    # Exact matches claim their sessions first; folder guesses then take what is left.
    for t in claude:
        t["transcript"] = hooked_session(t["address"]) or pid_session(t["address"])
    taken = {t["transcript"] for t in claude if t["transcript"]}
    for t in claude:
        if not t["transcript"]:
            t["transcript"] = claude_session(t["address"], t["cwds"], taken)
            taken.add(t["transcript"])
        kids = claude_children(t["address"], t["cwds"], t["transcript"]) if t["transcript"] else []
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
