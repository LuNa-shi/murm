# Trace Viewer replay from real Runs

[murm-real-runs.zip](murm-real-runs.zip) contains two replay exports made from completed hosted Runs. It is 3.42 MiB. SHA-256 `824780ac30a3f99fba81ebfdddb5806542d102c829da5b433a80fa3715c1c2c3`.

| Run | Work window | Agents | Model intervals | Service intervals | Archived tool results |
| --- | --- | ---: | ---: | ---: | ---: |
| `subagents-fd` | 43m 54s to Root settlement | 3 | 200 | 49 | 224 |
| `substrate-fate-x31` | 30m | 4 | 418 | 399 | 241 |

The fd Run was recorded under `EXP-20261125-10`, source `67c21218`, Runtime `85da5bf3-5185-4c68-9431-cc0488bc48d6`. The archived tool count includes inherited records in forked Sessions. The Viewer reconstructs 19 collaboration links. [Experiment report](https://github.com/LuNa-shi/murm/blob/b2076df0/docs/experiments/EXP-20261125-10-issue199-fd.md).

The FATE-X #31 Run is registered as `EXP-20261125-26`, source `2a3ed11c`, Runtime `36d331a9-0de4-45a3-8a40-ae3b8f800ef9`. It was recorded by the Substrate Harness under its historical ScaleMAS name. Two of the 418 model intervals ended in interruption. [Experiment report](https://github.com/LuNa-shi/murm/blob/b2076df0/docs/experiments/EXP-20261125-20-scalemas-fatex-verified.md).

## Replay

From the repository root of this branch on Linux or WSL with Node.js 22.19 or later, extract the archive and start the Viewer.

```bash
python3 -m zipfile -e trace-samples/murm-real-runs.zip experiments/trace-viewer-real
node trace-viewer/murm.mjs trace --root experiments/trace-viewer-real/runs --port 8787
```

Open [Subagents · fd](http://127.0.0.1:8787/#run=subagents-fd) or [Substrate · FATE-X #31](http://127.0.0.1:8787/#run=substrate-fate-x31). Set the **Event** filter to **Tool** and select a row to inspect its Session record. The archive predates Worker start and end trace records. The Viewer shows model and Service intervals on the chart and archived tool calls and results in the ledger.

## Evidence and export

The replay export keeps original event order, timestamps, lane assignments, tool names, request status, usage and collaboration structure. Non-UUID identifiers are consistently hashed to preserve equality across records. Two display labels were added. Agent dialogue, prompt text, source code, tool arguments and outputs, private paths, model databases, and artifacts were omitted. Model response files retain selected original SSE frame types and structural fields. Session manifest hashes identify the exported files.

The Viewer API reproduced the original Agent listings, event counts, timed spans and handoff relations. The fd collaboration links still resolve to the same model request times. Chromium opened both charts at 1440 px and 390 px, rendered all three and four 82 px lanes, and opened tool records. At 1440 px in the full-Run view, 164 adjacent model bar pairs overlap in the fd chart and 372 in FATE-X, measured by their rendered bounds on each lane. The original same-lane model intervals are disjoint in both Runs. The timeline has no time-zoom controls in this Viewer revision.
