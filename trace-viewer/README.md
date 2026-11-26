# murm Trace Viewer

Open a saved or active Core Run in a local browser.

## Try the offline demo

From the repository root on Linux, WSL, or macOS with Node.js 22.19 or later, start the Viewer with the [included synthetic Run](../test/fixtures/trace-viewer/runs/release-notes/).

```bash
node trace-viewer/murm.mjs trace --root test/fixtures/trace-viewer/runs --port 8787 --open
```

Open [the demo Run](http://127.0.0.1:8787/#run=release-notes). The [replay guide](../docs/operations/trace-viewer.md#replay-the-included-demo) shows how to follow the handoff into the Root's model request and final file.

## Install the package

```bash
npm pack ./trace-viewer
npm install --prefix /path/to/consumer ./murm-trace-viewer-0.2.0.tgz
/path/to/consumer/node_modules/.bin/murm trace /path/to/runs --port 8787 --open
```

Open `http://127.0.0.1:8787`. Run the viewer on Linux, WSL, or macOS with Node.js 22.19 or later. A Run root can be passed via `--root <dir>` or as a positional argument, and may be a single Run directory or a parent directory containing Runs. Live viewing tails new complete records and keeps the original Run files read-only.

## Remote server viewing

The HTTP listener always binds `127.0.0.1` loopback only. When `murm trace` starts inside an SSH session, it automatically prints the matching `ssh -N -L` forwarding command. You can also launch the remote viewer and local SSH tunnel in one command from your laptop:

```bash
murm trace --ssh user@server --root /path/to/remote/runs --port 8787 --open
```

Or forward a running server manually:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@server
```
