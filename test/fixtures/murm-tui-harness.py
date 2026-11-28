"""Drive installed built-in Harnesses through the same terminal entry."""

import argparse
import os
from pathlib import Path
import time
import urllib.request

from murm_terminal import ENTER, F1, F2, F5, F6, F7, INTERRUPT, Terminal, install_interrupt_handler


def control(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        assert response.status == 200
        return int(response.read())


def peer_flow(term, url):
    def wait_batches(count):
        deadline = time.monotonic() + 30
        while control(url + '/count') < count:
            assert time.monotonic() < deadline, f'Missing native PeerMesh batch {count}'
            term.pump()

    def target(index, text):
        term.key(F1 + F5)
        term.wait('Next directed user batch')
        term.menu(index)
        term.wait('Next directed user batch')
        term.paste(text)
        term.key(ENTER)
        term.wait('accepted')

    wait_batches(2)
    target(0, 'H6_TARGETED_USER_A')
    assert control(url + '/release') == 2
    wait_batches(3)
    term.key(F2)
    term.wait('H6_BATCH_3_DONE')
    term.key(F6)
    term.wait('Select Agent')
    term.menu(0)
    term.key(F7)
    term.wait('Agent controls')
    term.menu(9)
    term.wait('Stop Agent')
    term.menu(1)
    term.wait('router stopped · source stopped')
    target(1, 'H6_TARGETED_USER_B')
    wait_batches(4)
    term.key(INTERRUPT)
    term.wait('Cleanup     complete', timeout=85)
    term.key(INTERRUPT)
    term.finish(1)


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("harness")
    parser.add_argument("cwd")
    parser.add_argument("config")
    parser.add_argument("output")
    parser.add_argument("prompt")
    parser.add_argument("observation")
    parser.add_argument("timeout", type=int)
    parser.add_argument("--task-feedback")
    parser.add_argument("--release")
    parser.add_argument("--peer-control")
    options = parser.parse_args()
    env = {**os.environ, "TERM": "xterm-256color"}
    args = ["murm", "--mode", "tui", "--harness", options.harness, "--lifetime", "task",
            "--interaction", "none", "--cwd", options.cwd, "--config", options.config,
            "--output-dir", options.output, "--prompt", options.prompt]
    with Terminal(args, Path.cwd(), env, rows=48, columns=144) as term:
        term.wait("Ready. F5 edits the initial prompt.")
        term.key(F5 + ENTER)
        term.wait("Run admitted")
        if options.peer_control:
            peer_flow(term, options.peer_control)
            return
        if options.task_feedback:
            term.wait('"state": "RUNNING"', timeout=45)
            term.key(F5)
            term.wait("Task feedback for the active Execution")
            term.menu(0)
            term.wait("Task feedback for the active Execution")
            term.paste(options.task_feedback)
            term.key(ENTER)
            term.wait("accepted", timeout=16)
            with urllib.request.urlopen(options.release, timeout=5) as response:
                assert response.status == 200
        else:
            term.wait(options.observation, timeout=min(options.timeout, 85))
        term.wait("Outcome     completed", timeout=options.timeout)
        term.wait("Cleanup     complete")
        term.key(INTERRUPT)
        term.finish(0)


if __name__ == "__main__":
    install_interrupt_handler()
    run()
