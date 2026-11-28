"""User actions for the native Subagents CLI using only PTY input."""

import json
import os
import time
from pathlib import Path
import sys
import urllib.request

from murm_terminal import ENTER, F1, F2, F4, F5, F6, F7, INTERRUPT, Terminal, install_interrupt_handler


def control(path):
    with urllib.request.urlopen(os.environ["MURM_TUI_CONTROL_URL"] + path, timeout=5) as response:
        assert response.status == 200
        return json.load(response)


def wait_stage(stage, timeout=18):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = control("status")
        assert not status.get("failure"), status["failure"]
        if any(item["stage"] == stage for item in status["requests"]):
            return
        time.sleep(0.05)
    raise AssertionError("Missing actual upstream stage " + stage)


def send(terminal, prompt, key=F5):
    terminal.key(F1 + key)
    terminal.paste(prompt)
    terminal.key(ENTER)


def agent_action(terminal, operation):
    terminal.key(F2 + F7)
    terminal.wait("Agent controls")
    terminal.menu(operation)


def run():
    base = Path(sys.argv[1])
    cwd = base / "project"
    env = {**os.environ, "TERM": "xterm-256color"}
    with Terminal(["murm"], cwd, env, rows=28, columns=120) as term:
        term.wait("Set MURM_MODEL_URL")
        term.key(F6)
        term.wait("Select trusted configuration path")
        term.key(ENTER)
        term.wait("Trusted .js or .mjs path")
        term.paste(str(base / "configuration.mjs"))
        term.key(ENTER)
        term.wait("Configuration checked.")
        assert not (base / "state" / "murm" / "runs").exists()
        send(term, "SESSION_READ the captured project")
        term.wait("Run admitted", timeout=15)
        term.key(F2)
        term.wait("NATIVE_STREAM_START", timeout=25)
        assert b"SEED_READ_OK" not in term.output
        term.key(F5)
        term.wait("Run input to Root (steer)")
        term.paste("SESSION_SECOND second turn · 草稿 👩‍💻 é")
        term.resize(18, 60)
        term.key(F2)
        control("stream")
        term.wait("SEED_READ_OK")
        term.resize(32, 128)

        agent_action(term, 3)
        term.wait("Send to")
        term.menu(3)  # Append hidden context without starting a new model turn.
        term.wait("Structured context")
        term.paste("APPENDED_CONTEXT_VALUE")
        term.key(ENTER)
        term.wait("appended")
        term.key(F1 + F5 + ENTER)
        term.key(F2)
        term.wait("SECOND_TURN_OK")

        send(term, "SESSION_CONTEXT_STEER extra context prompt", F7)
        term.key(F2)
        term.wait("CONTEXT_STEER_OK")

        send(term, "SESSION_INTERRUPT delegate and wait")
        term.key(F2)
        wait_stage("root-wait")
        term.wait("tool_execution_start bash", timeout=25)
        agent_action(term, 8)
        term.wait("Interrupt Agent")
        term.menu(1)
        term.wait("interrupted", timeout=15)
        control("child")

        # The child finishes while Root remains paused. Inspect the child observation
        # before the next Root input so this step cannot be satisfied by implicit wake.
        term.key(F6)
        term.wait("Select Agent")
        term.menu(1)
        term.wait("LATE_CHILD_RESULT", timeout=20)
        term.key(F6)
        term.wait("Select Agent")
        term.menu(0)
        send(term, "SESSION_RESUME explicit new work")
        term.key(F2)
        term.wait("SAME_ROOT_RESUMED", timeout=20)

        send(term, "SESSION_QUESTIONS ask concurrent questions")
        term.key(F4)
        term.wait("Which Root value?", timeout=25)
        control("child-question")
        term.wait("Which child value?", timeout=20)
        term.key(F6)
        term.wait("Select question")
        term.menu(0)
        term.wait("Yes")
        term.menu(0)
        term.wait("answered")
        term.key(F6)
        term.wait("Select question")
        term.menu(1)
        term.wait("Child value")
        term.menu(0)
        term.wait("answered")
        term.key(F2)
        term.wait("ROOT_ANSWER_OK", timeout=20)

        send(term, "SESSION_QOLD interrupt the old question")
        term.key(F4)
        term.wait("Old Root execution question", timeout=20)
        agent_action(term, 8)
        term.wait("Interrupt Agent")
        term.menu(1)
        term.wait("interrupted")
        term.key(F4)
        term.wait("cancelled")
        send(term, "SESSION_QNEW answer the new question")
        term.key(F4)
        term.wait("New Root execution question", timeout=20)
        term.key(F6)
        term.wait("Select question")
        term.menu(2)
        term.wait("no longer actionable")
        term.key(F6)
        term.wait("Select question")
        term.menu(3)
        term.wait("JSON bytes")
        term.paste("NEW_EXECUTION_ANSWER")
        term.key(ENTER)
        term.wait("answered")
        term.key(F2)
        term.wait("NEW_EXECUTION_ANSWER_OK", timeout=20)
        term.key(INTERRUPT)
        term.wait("Cleanup     complete", timeout=35)
        term.key(INTERRUPT)
        term.finish(1)


if __name__ == "__main__":
    install_interrupt_handler()
    run()
