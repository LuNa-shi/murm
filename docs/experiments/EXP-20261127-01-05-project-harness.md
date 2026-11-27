# Issue #257 project Harness live acceptance

Runs `EXP-20261127-01` through `EXP-20261127-05` verify the ordinary project entry and the five collaboration paths in [Issue #257](https://github.com/LuNa-shi/murm/issues/257).

## Registration

- Source `0c203ba0db9378588cfdf3b69f51d7c9506b4227` incorporates the final Core merge `5bb024e6073c1b692fea4fe5960424cc1f6bdea6`. The installed archive SHA-256 is `27f6617c39559f86fe509789e24a727392a89914b56f027692612a3bcda33a65`.
- Real OpenSandbox Worker `sha256:69456d8d45ae136ac5faf7538a798834e170ad4a1eafe70a12a885c46724c8d0`, `file-tree-v1`, Pi, authenticated `gpt_proxy/gpt-6.1-sol`, host Node 24.21.0 and Python 3. The model relay preserves Requests and Responses bytes and records request and response metadata.
- Workload is a small Python warehouse-ledger project with input data and a fresh policy. The independent host oracle checks validation, station totals, ordering, thresholds, and use from outside the project directory. The installed CLI receives the project and prompt in a v1 stdio run request. Per-Harness role cues ask for the existing collaboration path.
- Subagents permits one child. TaskPool permits two Workers. PeerMesh and Substrate use two peers each. Static Lead–Worker uses one Lead and two Workers. No more than three Harnesses run models concurrently.
- Each process gets a 900-second model window from CLI launch, after external facility setup. Within that window each Harness uses its native end condition and may settle early. The host refuses new upstream dispatches at the window boundary and preserves bounded closeout, exported bytes, and ownership receipts. No source or working files from the host checkout are supplied to model Agents.
