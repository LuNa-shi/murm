# PutnamBench 4-core rerun record

This directory is the durable local record of the 12-problem rerun completed
before the Task queue and durable logging change. It is retained to preserve
its SQLite databases, execution workspaces, and Pi session records.

The shareable reports are in
[`reports/putnambench-4core-2026-10-18-rerun`](../../reports/putnambench-4core-2026-10-18-rerun/).
The exact commit, pinned PutnamBench checkout, route, protocol, migration note,
and result counts are in [`metadata/experiment.json`](metadata/experiment.json).

Raw state remains ignored by Git because it may contain candidate source,
proof text, and session content. New runs also write durable service, Runtime,
bridge, Agent, and checker logs under `logs/`.
