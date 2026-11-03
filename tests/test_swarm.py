"""Tests for mods/ide-agents/swarm.py: which Claude subagents count as running, in a temp home."""
import importlib.util
import json
import os
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("swarm", os.path.join(HERE, "..", "mods", "ide-agents", "swarm.py"))
swarm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(swarm)

CWD = "/work/repo"
TOOL = {"type": "assistant", "message": {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "Bash"}]}}
END = {"type": "assistant", "message": {"stop_reason": "end_turn", "content": [{"type": "text"}]}}
RESULT = {"type": "user", "message": {"content": [{"type": "tool_result"}]}}


def notification(agent, summary):
    content = f"<task-notification>\n<task-id>{agent}</task-id>\n<status>completed</status>\n<summary>{summary}</summary>\n</task-notification>"
    return {"type": "user", "message": {"role": "user", "content": content}}


class SwarmTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        swarm.HOME, swarm.APP, swarm.now = self.tmp.name, os.path.join(self.tmp.name, "app"), time.time()
        project = os.path.join(self.tmp.name, ".claude", "projects", "-work-repo")
        self.transcript = os.path.join(project, "session.jsonl")
        self.subagents = os.path.join(project, "session", "subagents")
        os.makedirs(self.subagents)
        self.parent([])

    def tearDown(self):
        self.tmp.cleanup()

    def parent(self, records):
        with open(self.transcript, "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in [{"type": "user"}, *records])

    def agent(self, agent, records, age=0, **meta):
        base = os.path.join(self.subagents, f"agent-{agent}")
        with open(base + ".meta.json", "w") as f:
            json.dump({"description": agent, "agentType": "general-purpose", **meta}, f)
        with open(base + ".jsonl", "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in records)
        t = swarm.now - age
        os.utime(base + ".jsonl", (t, t))

    def listed(self):
        return {c["id"]: c["status"] for c in swarm.claude_children("t1", [CWD])}

    def test_a_long_tool_call_keeps_running_while_silent(self):
        self.agent("tool", [RESULT, TOOL], age=600)
        self.assertEqual(self.listed(), {"tool": "working"})

    def test_silence_outside_a_tool_call_counts_as_stopped(self):
        self.agent("quiet", [TOOL, RESULT], age=600)
        self.assertEqual(self.listed(), {})

    def test_a_finished_agent_waiting_on_background_work_is_listed(self):
        self.agent("bg", [TOOL, RESULT, END], age=600, finished=True)
        self.parent([notification("bg", 'Agent "bg" is waiting on its own background work')])
        self.assertEqual(self.listed(), {"bg": "waiting"})

    def test_the_latest_notification_wins(self):
        self.agent("bg", [END], age=600, finished=True)
        self.parent([notification("bg", 'Agent "bg" is waiting on its own background work'),
                     notification("bg", 'Agent "bg" finished')])
        self.assertEqual(self.listed(), {})

    def test_a_revived_agent_runs_despite_its_finished_flag(self):
        self.agent("revived", [END, RESULT, TOOL], age=30, finished=True, revivedAt=int(swarm.now * 1000))
        self.assertEqual(self.listed(), {"revived": "working"})

    def test_a_finished_agent_is_hidden(self):
        self.agent("done", [TOOL, RESULT, END], age=5, finished=True)
        self.parent([notification("done", 'Agent "done" finished')])
        self.assertEqual(self.listed(), {})

    def test_waiting_or_running_a_tool_for_hours_counts_as_stopped(self):
        self.agent("old-tool", [TOOL], age=swarm.ORPHAN + 60)
        self.agent("old-wait", [END], age=swarm.ORPHAN + 60, finished=True)
        self.parent([notification("old-wait", 'Agent "old-wait" is waiting on its own background work')])
        self.assertEqual(self.listed(), {})


if __name__ == "__main__":
    unittest.main()


class FolderTest(unittest.TestCase):
    """A shell started in one repo running Claude in another must not show the first repo's agents."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        swarm.HOME, swarm.APP = self.tmp.name, os.path.join(self.tmp.name, "app")
        self.real_agent_cwd = swarm.agent_cwd

    def tearDown(self):
        swarm.agent_cwd = self.real_agent_cwd
        self.tmp.cleanup()

    def session(self, folder, name, age):
        project = os.path.join(self.tmp.name, ".claude", "projects", folder.replace("/", "-"))
        os.makedirs(project, exist_ok=True)
        path = os.path.join(project, f"{name}.jsonl")
        open(path, "w").close()
        t = time.time() - age
        os.utime(path, (t, t))
        return path

    def test_the_first_folder_with_a_session_wins_over_a_newer_one_elsewhere(self):
        mine = self.session("/work/tools", "mine", age=600)
        self.session("/work/busy", "busy", age=0)
        self.assertEqual(swarm.claude_session("t1", ["/work/tools", "/work/busy"]), mine)

    def test_later_folders_are_used_when_the_first_has_no_session(self):
        busy = self.session("/work/busy", "busy", age=0)
        self.assertEqual(swarm.claude_session("t1", ["/work/empty", "/work/busy"]), busy)

    def test_the_agents_own_folder_comes_first(self):
        swarm.agent_cwd = lambda address: "/work/tools"
        t = {"address": "t1", "cwd": "/work/busy", "cwds": ["/work/busy", "/work/tools"]}
        self.assertEqual(swarm.folders(t), ["/work/tools", "/work/busy"])

    def test_without_hc_the_given_folders_keep_their_order(self):
        swarm.agent_cwd = lambda address: None
        self.assertEqual(swarm.folders({"address": "t1", "cwd": "/a", "cwds": ["/a", "/b"]}), ["/a", "/b"])
