#!/usr/bin/env python3
"""Claude Code SessionStart hook: remember which session runs in which Herdr terminal.

Writes ~/.config/herdr-app/data/swarm/claude-<HC_TERMINAL_ID>.json so the ide-agents
sidebar can list that session's subagents. Does nothing outside a Herdr terminal.
"""
import json
import os
import sys

terminal = os.environ.get("HC_TERMINAL_ID")
if terminal:
    try:
        event = json.load(sys.stdin)
        folder = os.path.expanduser("~/.config/herdr-app/data/swarm")
        os.makedirs(folder, exist_ok=True)
        tmp = os.path.join(folder, f".claude-{terminal}.json.tmp")
        with open(tmp, "w") as f:
            json.dump({k: event.get(k) for k in ("session_id", "transcript_path", "cwd")}, f)
        os.replace(tmp, os.path.join(folder, f"claude-{terminal}.json"))
    except Exception:
        pass  # never block a session start
