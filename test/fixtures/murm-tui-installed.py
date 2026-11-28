"""Acceptance through an exact installed murm bin and real PTY slave."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import termios

from murm_terminal import ENTER, F1, F2, F4, F5, F6, INTERRUPT, Terminal, install_interrupt_handler


def external_fixture(base):
    fixture = base / "external.mjs"
    fixture.write_text("""
import { ProjectPreflightError } from '@luna-shi/murm';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  id: 'external-terminal-harness', apiVersion: 1, input: true, questions: true,
  inputDescriptor: { description: 'Provide a text annotation', schema: { type: 'string', minLength: 2 } },
  async run(context) {
    if (context.input.prompt === 'invalidate-start') {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid external launch fixture');
    }
    const evidence = { prompt: context.input.prompt, received: [], answers: [] };
    const changed = () => context.updateStatus({ business: { annotationCount: evidence.received.length,
      ready: 'EXTERNAL_READY', answerCount: evidence.answers.filter(value => value !== undefined).length, configuration: context.configuration?.label } });
    context.registerInput(value => { evidence.received.push(value); changed(); return { status: 'queued' }; });
    context.markRunning();
    changed();
    if (process.env.TUI_FIXTURE_FAULT === 'render') {
      Object.defineProperty(process.stdout, 'columns', { get() { throw new Error('render test fault'); } });
    }
    if (process.env.TUI_FIXTURE_QUESTIONS === '1' && context.clientCapabilities.questions) {
      const ask = (questionId, kind, text, options) => context.askUser({ requestId: questionId, kind, text, options },
        { id: questionId, signal: context.signal });
      const answers = [ask('text-test', 'text', 'Type the text answer'),
        ask('choice-test', 'choice', 'Choose an option', [{id: 'blue', label: 'Blue'}, {id: 'green', label: 'Green'}]),
        ask('confirm-test', 'confirm', 'Confirm choice')];
      for (const [index, answer] of answers.entries()) {
        void answer.then(value => { evidence.answers[index] = value; changed(); }).catch(() => {});
      }
    }
    if (!context.signal.aborted) await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    const path = join(context.outputDir, 'evidence.json');
    await writeFile(path, JSON.stringify(evidence));
    return { outcome: 'cancelled', reason: 'stopped', result: evidence,
      artifacts: [{ path }], cleanup: { status: 'complete' } };
  }
};
""", encoding="utf8")
    return fixture


def run():
    base = Path(sys.argv[1])
    project = base / "ordinary-project"
    project.mkdir()
    (project / "package.json").write_text('{"name":"regular-app","version":"1.0.0"}\n')
    (project / "data.txt").write_text("ordinary project input\n")
    original = {path.name: path.read_bytes() for path in project.iterdir()}
    env = {**os.environ, "XDG_CONFIG_HOME": str(base / "configuration"),
           "XDG_STATE_HOME": str(base / "state"), "TERM": "xterm-256color"}
    for key in ("NODE_PATH", "NODE_OPTIONS", "MURM_MODEL_URL", "MURM_SUBAGENTS_MODEL_URL"):
        env.pop(key, None)

    for is_stdin, is_stdout in [(False, False), (True, False), (False, True), (True, True)]:
        terminal_env = {**env, "TERM": "dumb"} if is_stdin and is_stdout else env
        with Terminal(["murm"], project, terminal_env, tty_in=is_stdin, tty_out=is_stdout) as term:
            term.wait("needs an interactive terminal")
            term.finish(2, restored=False)
            assert termios.tcgetattr(term.slave) == term.before
            assert b"\x1b[?1049h" not in term.output

    with Terminal(["murm"], project, env, rows=18, columns=60) as term:
        term.wait("Set MURM_MODEL_URL")
        term.key(F5)
        term.wait("Initial prompt")
        term.paste("草稿 👩‍💻 é\n" + "日本語" * 4000)
        term.resize(24, 80)
        term.key(F2 + F1 + F5)
        term.resize(28, 112)
        term.key(INTERRUPT)
        term.finish(0)
    assert not (base / "state").exists()
    assert {path.name: path.read_bytes() for path in project.iterdir()} == original

    fixture = external_fixture(base)
    config = base / "configuration.mjs"
    config.write_text("export default { label: 'EXPLICIT_CONFIGURATION' };\n")
    launches = base / "launches"
    common = ["murm", "--harness", "./external.mjs", "--cwd", "ordinary-project", "--output-dir", "./launches"]

    with Terminal(common + ["--config", "./configuration.mjs"], base, env, rows=30, columns=112) as term:
        term.wait("Ready. F5 edits the initial prompt.")
        term.key(F6)
        term.wait("Remember current configuration")
        term.menu(2)
        term.wait("Configuration checked.")
        term.key(INTERRUPT)
        term.finish(0)
    pref = base / "configuration" / "murm" / "launcher.json"
    assert json.loads(pref.read_text()) == {
        "version": 1, "harness": "external-terminal-harness", "configPath": str(config)}
    assert pref.stat().st_mode & 0o777 == 0o600
    assert not launches.exists()

    env_with_questions = {**env, "TUI_FIXTURE_QUESTIONS": "1"}
    draft = "全角 👩‍💻 é\n" + ("0123456789\n" * 3200) + "LAST-DRAFT-LINE"
    with Terminal(common, base, env_with_questions, rows=32, columns=120) as term:
        term.wait("remembered")
        term.key(F5)
        term.wait("Initial prompt")
        term.paste(draft)
        term.resize(18, 60)
        term.key(F2 + F1 + F5)
        term.resize(28, 120)
        term.key(ENTER)
        term.wait("EXTERNAL_READY")
        term.key(F5)
        term.wait("Provide a text annotation")
        term.paste("独立注释")
        term.key(ENTER)
        term.wait("accepted")
        term.key(F4)
        term.wait("Confirm choice")
        term.key(F6)
        term.wait("Select question")
        term.menu(0)
        term.wait("JSON bytes")
        term.paste("文字")
        term.key(ENTER)
        term.wait("answered")
        term.key(F6)
        term.wait("Select question")
        term.menu(1)
        term.wait("Green")
        term.menu(1)
        term.wait("answered")
        term.key(F6)
        term.wait("Select question")
        term.menu(2)
        term.wait("Yes")
        term.menu(0)
        term.key(F1)
        term.wait('"answerCount": 3')
        term.key(INTERRUPT)
        term.wait("Cleanup")
        term.key(INTERRUPT)
        term.finish(1)
    evidence = [json.loads(path.read_text()) for path in launches.glob("*/evidence.json")]
    assert len(evidence) == 1
    actual = evidence[0]["prompt"]
    mismatch = next((i for i, (left, right) in enumerate(zip(actual, draft)) if left != right), None)
    assert actual == draft, (len(actual), len(draft), mismatch, actual[:25], actual[-25:])
    assert evidence[0]["received"] == ["独立注释"], evidence[0]["received"]
    assert evidence[0]["answers"] == ["文字", "green", True], evidence[0]["answers"]

    for mode, expected in [("SIGINT", 130), ("SIGTERM", 143), ("render", 1), ("disconnect", 1), ("preflight", 2)]:
        outputs = base / mode.lower()
        launch_env = {**env, "TUI_FIXTURE_FAULT": mode}
        arguments = [*common[:-1], str(outputs)]
        with Terminal(arguments, base, launch_env, rows=30, columns=112) as term:
            term.wait("Ready. F5 edits the initial prompt.")
            term.key(F5)
            term.paste("invalidate-start" if mode == "preflight" else "Controlled terminal failure")
            term.key(ENTER)
            if mode not in ("render", "preflight"):
                term.wait("EXTERNAL_READY")
                if mode == "disconnect":
                    term.disconnect()
                else:
                    term.process.send_signal(getattr(signal, mode))
            if mode == "preflight":
                term.wait("INVALID_RUN_CONFIGURATION")
                term.key(INTERRUPT)
            term.finish(expected, restored=mode != "disconnect")
        assert len(list(outputs.glob("*/evidence.json"))) == (0 if mode == "preflight" else 1)

    foreground = subprocess.run(
        ["murm", "--harness", str(fixture), "--prompt", "invalidate-start", "--output-dir", str(base / "foreground")],
        cwd=project, env=env, capture_output=True, timeout=20, check=False)
    assert foreground.returncode == 2
    assert json.loads(foreground.stdout)["result"]["reason"] == "INVALID_RUN_CONFIGURATION"
    config.unlink()
    with Terminal(common, base, env) as term:
        term.wait("Could not load the trusted module")
        term.key(INTERRUPT)
        term.finish(0)
    assert {path.name: path.read_bytes() for path in project.iterdir()} == original


if __name__ == "__main__":
    install_interrupt_handler()
    run()
