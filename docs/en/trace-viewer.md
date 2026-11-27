---
title: Trace Viewer
description: Inspect saved or live multi-agent Runs in a zero-dependency browser UI — zoomable swimlanes, Service handoffs, model contexts, and exported files.
section: CORE BUILDING BLOCKS
order: 8
---

Every `murm` Run writes structured evidence under `outputDir/<runtimeId>/`. The built-in **Trace Viewer** (`murm trace`) lets you inspect completed or live Runs right in your browser with **zero extra frontend dependencies**.

The widget above is a **real, live Trace Viewer swimlane** backed by the bundled `release-notes` (`Subagents`) Run — try it right here without nested scrolling:

- **Switch panels cleanly**: use the outer bar above to switch between **Swimlane Timeline**, **Collaboration**, and **Files & Results**, or click **Open full viewer ↗** for the full Run sidebar and raw event ledger.
- **Zoom & pan**: scroll your mouse wheel over the swimlanes to zoom around your cursor, drag the swimlanes or overview minimap to pan, or press `W`/`S` (zoom), `A`/`D` (pan), and `0` (fit).
- **Hover & inspect**: hover any span for live timing and metadata; click any bar to open the slide-over **Evidence Inspector** (**Structured** or **Raw JSON**).

## 1. Launch `murm trace` locally

Point `murm trace` at a parent output directory (auto-discovers all Runs, including new ones) or a single Run folder:

```bash
# Inspect all Runs under ./runs
murm trace --root ./runs --port 8787 --open

# Or pass the directory as a positional argument
murm trace ./runs --port 8787
```

Open `http://127.0.0.1:8787`. Trace Viewer reads only saved files — **no Docker, OpenSandbox, or model keys required** — and live-streams active Runs over SSE.

## 2. Viewing runs on a remote Linux server (SSH)

Because sandboxes run on a Linux host while your browser is usually on a laptop, bind to loopback (`127.0.0.1`) and forward over SSH:

```bash
# On the Linux host (automatically prints the matching ssh -L command inside SSH)
murm trace --root /path/to/runs --port 8787

# On your laptop
ssh -N -L 8787:127.0.0.1:8787 user@your-linux-host
```

Then open `http://127.0.0.1:8787` locally. Keep Run traces private behind SSH — they contain prompts, code, and full transcripts.

## 3. What lives inside `outputDir/<runtimeId>/`

| Path | Contents |
| --- | --- |
| `runtime.json` | Effective configuration, Agent summary, and final `CloseReceipt` (`cleanup: complete \| pending`) |
| `evidence.jsonl` | Ordered host lifecycle ledger (spawn, input, settled, interrupt, stop, management) |
| `service-calls.jsonl` | Every Bridge-authenticated Service call with validated input, reply, timing, and errors |
| `service-state.<id>.json` | Optional domain state snapshots returned by `exportState()` on close |
| `model-trace/` | Raw forwarded `/v1/responses` requests and streamed responses from Model Gateway |
| `<agentId>/session/` & `artifacts/` | Archived Pi / Codex native sessions and files collected via `Profile.collect` |
| `harness-report.json` | Business outcome and verification report written by built-in Harness launchers |

---

**Next:** bring all six building blocks together by building a real **[Multi-Agent Swarm Harness](build-your-harness.md)**!
