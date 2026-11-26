# murm Trace Viewer

Open a saved or active Core Run in a local browser.

## Try the offline demo

From the repository root on Linux or WSL with Node.js 22.19 or later, start the Viewer with the [included synthetic Run](../test/fixtures/trace-viewer/runs/release-notes/).

```bash
node trace-viewer/murm.mjs trace --root test/fixtures/trace-viewer/runs --port 8787
```

Open [the demo Run](http://127.0.0.1:8787/#run=release-notes). The [replay guide](../docs/operations/trace-viewer.md#replay-the-included-demo) shows how to follow the handoff into the Root's model request and final file.

## Install the package

```bash
npm pack ./trace-viewer
npm install --prefix /path/to/consumer ./murm-trace-viewer-0.2.0.tgz
/path/to/consumer/node_modules/.bin/murm trace --root /path/to/runs --port 8787
```

Open `http://127.0.0.1:8787`. Run the viewer on Linux with Node.js 22.19 or later. A Run root can be the Run directory itself or an output directory containing Runs. Live viewing tails new complete records and keeps the original Run files read-only.

For a Viewer running on a server, forward the loopback listener from your local machine.

```bash
ssh -N -L 8787:127.0.0.1:8787 user@server
```
