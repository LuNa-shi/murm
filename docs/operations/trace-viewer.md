# Open a Run in Trace Viewer

Build the standalone candidate package from the repository root on Linux with Node.js 22.19 or later. Install the resulting tarball in a separate directory.

```bash
mkdir -p /tmp/murm-viewer-package
npm pack ./trace-viewer --pack-destination /tmp/murm-viewer-package

mkdir -p ~/murm-viewer
cd ~/murm-viewer
npm install /tmp/murm-viewer-package/murm-trace-viewer-0.2.0.tgz
./node_modules/.bin/murm trace --root /path/to/private/runs --port 8787
```

Open `http://127.0.0.1:8787`. A configured root may be a Core Run directory containing `runtime.json` or a parent output directory. The Viewer opens on an empty parent directory and discovers new Runs there. It needs the saved Run files and Node.js. Core, the executing Harness, Sandbox services and model credentials are independent.

## Server launch and local browser

Run the same `murm trace` command on the machine holding the evidence. From your local terminal forward its loopback listener over SSH.

```bash
ssh -N -L 8787:127.0.0.1:8787 user@server
```

Open the local forwarded port in the browser. Anyone with access to the loopback listener can view the selected private traces. Use a dedicated Run root and keep the listener behind the SSH connection. Stop the Viewer with Ctrl+C. The Harness continues on its own lifecycle.

## Examples

Use the example's configured `outputDir`. The default output roots are relative to the directory that launched the example.

| Example | Default root |
| --- | --- |
| [Notes](../../examples/notes/README.md) | `./notes-runs` |
| [Subagents](../../examples/subagents/README.md) | `./subagents-runs` |
| [PeerMesh](../../examples/peermesh/README.md) | `./peermesh-runs` |
| [Substrate](../../examples/substrate/README.md) | `./substrate-runs`. The FATE launcher uses `./experiments/substrate-fate` by default |
| [Lead-Worker](../../examples/lead-worker/README.md) | `./lead-worker-runs` |
| TaskPool foreground Harness | `outputDir` from the host configuration |

Service calls appear across Harnesses. Subagents adds caller and destination links backed by the saved evidence. Read the [Architecture chapter](../architecture/06-observability-experiments.md) for the timing and status semantics.

## Replay the private Pastel Run

Use the saved `output` directory for [EXP-20261125-06](../experiments/EXP-20261125-06-issue199-pastel.md). It contains the original Runtime `4ea6a746-80ee-4d24-b224-82200a55f384` recorded at `67c21218bf6faa24e5f72a5901baf3028d24414a`. Set `PASTEL_RUN_DIR` to that private directory from the experiment evidence.

```bash
./node_modules/.bin/murm trace --root "$PASTEL_RUN_DIR" --port 8787
```

This Run predates native execution tracing. Compare overlapping recorded model request intervals, then open the child handoff, corresponding Root model request, and archived result or file. The separately recorded checks concern the Pastel subtask and its seven reference cases.

The saved Core format is schema 1, Core 0.2.0, with historical `bots` and `botId` fields. The viewer recovers three Agent lanes, 35 model request intervals, two spawn links, four explicit messages, two archived result returns and three Session files. The two children's captured model intervals overlap for 102.262 seconds. The first HSL child message appears in Root model request 15. The saved export includes `delivery/pastel.js` at 4,091 bytes. The independent receipt records seven reference matches and invalid-color rejection.

To check the snapshot identity, calculate this manifest digest from the parent directory of the original Run.

```bash
cd "$(dirname "$PASTEL_RUN_DIR")"
find 4ea6a746-80ee-4d24-b224-82200a55f384 -type f -print0 |
  LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
```

The expected SHA-256 is `b70f92951a44462efcf31ddae036fe6643474a58970c5ee10fa3ffbf8f3fd355`.
