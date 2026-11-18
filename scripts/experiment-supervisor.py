#!/usr/bin/env python3
"""Failure-isolated, read-only observer for a running benchmark process.

The observer attaches to an already-running runner PID. It never starts,
signals, or owns that process. Run it in a separate service/cgroup when a
long experiment needs supervision; an observer failure must not terminate the
research runner.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import time

STOP = False


def _signal_handler(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def fd_count() -> int:
    return len(list(Path("/proc/self/fd").iterdir()))


def process_starttime(pid: int) -> str | None:
    """Return Linux /proc starttime (field 22) for PID, or None if gone."""

    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    closing_parenthesis = stat.rfind(")")
    if closing_parenthesis < 0:
        raise ValueError("malformed process stat")
    fields = stat[closing_parenthesis + 2 :].split()
    # The suffix starts at field 3 (state); field 22 is therefore index 19.
    if len(fields) <= 19:
        raise ValueError("incomplete process stat")
    return fields[19]


def read_rows(database: Path, query: str, parameters: tuple[object, ...] = ()) -> list[tuple]:
    """Read one query and close the SQLite connection on every path.

    ``sqlite3.Connection`` is a transaction context manager; ``__exit__``
    does not close the connection. Long-running polling therefore needs an
    explicit close in ``finally``.
    """

    if not database.exists():
        return []
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=10)
    try:
        return connection.execute(query, parameters).fetchall()
    finally:
        connection.close()


def append_event(log_path: Path, event: dict[str, object]) -> bool:
    """Best-effort event persistence; logging failure never controls the runner."""

    line = json.dumps(event, ensure_ascii=False) + "\n"
    try:
        with log_path.open("a", encoding="utf-8") as output:
            output.write(line)
        return True
    except OSError as error:
        try:
            print(json.dumps({"kind": "observer_log_error", "error": type(error).__name__}), file=sys.stderr, flush=True)
        except OSError:
            pass
        return False


def snapshot(project_dir: Path) -> dict[str, object]:
    """Return a bounded, read-only snapshot of the experiment stores."""

    queries = {
        "tasks": ("project.sqlite", "select state,count(*) from tasks group by state"),
        "bots": ("project.sqlite", "select state,count(*) from bots group by state"),
        "checks": ("judge.sqlite", "select verdict,result_class,count(*) from check_results group by verdict,result_class"),
        "executions": ("project.sqlite", "select state,count(*) from executions group by state"),
        "materials": ("context.sqlite", "select count(*) from materials"),
        "diagnostic_codes": ("judge.sqlite", "select diagnostic_code,count(*) from check_results group by diagnostic_code"),
        "mission_created": ("project.sqlite", "select mission_id,created_at from missions order by created_at desc limit 1"),
        "consumptions": ("context.sqlite", "select action,count(*) from material_consumptions group by action"),
    }
    return {name: read_rows(project_dir / filename, query) for name, (filename, query) in queries.items()}


def emit(log_path: Path, kind: str, **fields: object) -> None:
    event = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "kind": kind, **fields}
    append_event(log_path, event)
    try:
        print(json.dumps(event, ensure_ascii=False), flush=True)
    except OSError:
        # A closed stdout pipe is another observer-side failure. The runner is
        # independent and must continue even if both observer sinks disappear.
        pass


def observe(*, pid: int, project_dir: Path, log_path: Path, interval: float,
            max_runtime: float | None, expected_starttime: str | None = None) -> int:
    started = time.monotonic()
    observed_starttime = process_starttime(pid)
    if observed_starttime is None:
        emit(log_path, "observer_attach_failed", observed_pid=pid, reason="process_not_found")
        return 2
    if expected_starttime is not None and observed_starttime != expected_starttime:
        emit(log_path, "observer_attach_failed", observed_pid=pid, reason="process_identity_mismatch")
        return 2
    emit(log_path, "observer_started", observed_pid=pid)
    while not STOP:
        current_starttime = process_starttime(pid)
        if current_starttime is None:
            emit(log_path, "observed_process_finished", observed_pid=pid)
            return 0
        if current_starttime != observed_starttime:
            emit(log_path, "observed_process_identity_changed", observed_pid=pid)
            return 0
        try:
            emit(log_path, "status", observed_pid=pid, snapshot=snapshot(project_dir))
        except (OSError, sqlite3.Error, ValueError) as error:
            # Observation failure is evidence, not a runner stop condition.
            emit(log_path, "observation_error", error_type=type(error).__name__)
        if max_runtime is not None and time.monotonic() - started >= max_runtime:
            emit(log_path, "observer_timebox_reached", observed_pid=pid)
            return 0
        time.sleep(max(0.05, interval))
    emit(log_path, "observer_stopped", observed_pid=pid)
    return 0


def self_test() -> int:
    """Red-capable regression probe for the connection leak."""

    with tempfile.TemporaryDirectory() as directory:
        project = Path(directory) / "project.sqlite"
        judge = Path(directory) / "judge.sqlite"
        context = Path(directory) / "context.sqlite"
        schemas = {
            project: (
                "create table tasks (state text)",
                "create table bots (state text)",
                "create table executions (state text)",
                "create table missions (mission_id text, created_at text)",
                "insert into tasks values ('DONE')",
                "insert into bots values ('ACTIVE')",
                "insert into executions values ('RUNNING')",
                "insert into missions values ('m1', '2026-01-01T00:00:00Z')",
            ),
            judge: (
                "create table check_results (verdict text, result_class text, diagnostic_code text)",
                "insert into check_results values ('PASS', 'source', 'ok')",
            ),
            context: (
                "create table materials (id text)",
                "create table material_consumptions (action text)",
                "insert into materials values ('material-1')",
                "insert into material_consumptions values ('read')",
            ),
        }
        for database, statements in schemas.items():
            connection = sqlite3.connect(database)
            try:
                for statement in statements:
                    connection.execute(statement)
                connection.commit()
            finally:
                connection.close()
        baseline = fd_count()
        for _ in range(1000):
            current = snapshot(Path(directory))
            assert current["tasks"] == [("DONE", 1)]
            assert current["checks"] == [("PASS", "source", 1)]
            assert current["materials"] == [(1,)]
        delta = fd_count() - baseline
        if delta > 8:
            raise AssertionError(f"observer leaked file descriptors: baseline={baseline} delta={delta}")
        assert process_starttime(os.getpid()) is not None
        print(json.dumps({"self_test": "PASS", "fd_baseline": baseline, "fd_delta": delta}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--print-starttime", type=int)
    parser.add_argument("--pid-starttime")
    parser.add_argument("--project-dir", type=Path)
    parser.add_argument("--log", type=Path, default=Path("supervision.ndjson"))
    parser.add_argument("--interval-seconds", type=float, default=600)
    parser.add_argument("--max-runtime-seconds", type=float)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.print_starttime is not None:
        starttime = process_starttime(args.print_starttime)
        if starttime is None:
            parser.error("process does not exist")
        print(starttime)
        return 0
    if args.pid is None or args.project_dir is None:
        parser.error("--pid and --project-dir are required unless --self-test is used")
    if not math.isfinite(args.interval_seconds) or args.interval_seconds < 0:
        parser.error("--interval-seconds must be finite and non-negative")
    if args.max_runtime_seconds is not None and (not math.isfinite(args.max_runtime_seconds) or args.max_runtime_seconds < 0):
        parser.error("--max-runtime-seconds must be finite and non-negative")
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, _signal_handler)
    return observe(pid=args.pid, project_dir=args.project_dir, log_path=args.log,
                   interval=args.interval_seconds, max_runtime=args.max_runtime_seconds,
                   expected_starttime=args.pid_starttime)


if __name__ == "__main__":
    raise SystemExit(main())
