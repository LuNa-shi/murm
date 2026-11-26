# murm Trace Viewer

Open a saved or active Core Run in a local browser.

```bash
npm pack ./trace-viewer
npm install --prefix /path/to/consumer ./murm-trace-viewer-0.2.0.tgz
/path/to/consumer/node_modules/.bin/murm trace --root /path/to/runs --port 8787
```

Open `http://127.0.0.1:8787`. Node.js 22.19 or later is required. A Run root can be the Run directory itself or an output directory containing Runs. Live viewing tails new complete records and keeps the original Run files read-only.

For a Viewer running on a server, forward the loopback listener from your local machine.

```bash
ssh -N -L 8787:127.0.0.1:8787 user@server
```
