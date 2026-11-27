# Issue #257 project Harness live acceptance

Five Harness workloads and their setup or input retries (`EXP-20261127-01` through `EXP-20261127-12`) verify the ordinary project entry and the five collaboration paths in [Issue #257](https://github.com/LuNa-shi/murm/issues/257).

## Registration

- Source `0c203ba0db9378588cfdf3b69f51d7c9506b4227` incorporates the final Core merge `5bb024e6073c1b692fea4fe5960424cc1f6bdea6`. The installed archive SHA-256 is `27f6617c39559f86fe509789e24a727392a89914b56f027692612a3bcda33a65`.
- Real OpenSandbox Worker `sha256:69456d8d45ae136ac5faf7538a798834e170ad4a1eafe70a12a885c46724c8d0`, `file-tree-v1`, Pi, authenticated `gpt_proxy/gpt-6.1-sol`, host Node 24.21.0 and Python 3. The relay forwards model request and response bytes and records request and response metadata.
- Workload is a small Python warehouse-ledger project with input data and a fresh policy. The independent host oracle checks validation, station totals, ordering, thresholds, and use from outside the project directory. The installed CLI receives the project and prompt in a v1 stdio run request. Per-Harness role cues ask for the existing collaboration path.
- Subagents permits one child. TaskPool permits two Workers. PeerMesh uses two peers and Substrate uses its supported minimum of three. Static Lead–Worker uses one Lead and two Workers. No more than three Harnesses run models concurrently.
- Each process gets a 900-second model window from CLI launch, after external facility setup. Within that window each Harness uses its native end condition and may settle early. The host refuses new upstream dispatches at the window boundary and preserves bounded closeout, exported bytes, and ownership receipts. No source or working files from the host checkout are supplied to model Agents.

## Results

The initial project path was inside a Git-ignored checkout directory. The captured manifest had zero files. Two setup attempts failed before dispatch: the PeerMesh fixture's Board launcher required an ownership callback, and Substrate requires at least three peers. Corrected attempts use byte-identical input copied outside the checkout, verify the four manifest hashes before forwarding the first model request, and subtract the elapsed prior attempt from the 900-second budget for that Harness. Raw results and model traces remain in the local evidence directory.

| Run | Harness | CLI wall time through close | Hosted completions | Independent output | Collaboration |
|---|---|---:|---:|---|---|
| `EXP-20261127-08` | Subagents | 124.1 s | 19 | 3/3 | Root delegated the tests, received the child's test design and fixes, and exported the integrated CLI and test file. |
| `EXP-20261127-09` | TaskPool | 124.6 s | 36 | 3/3 | Two Workers took Tasks and merged separate contributions. Workspace main 0.9 at `33950311` contained the implementation and tests. |
| `EXP-20261127-12` | PeerMesh | 163.8 s | 34 | 3/3 | Two peers exchanged direct messages, read the Board and each merged a pull request. The final stable archive was pinned at `697c402d` and matched the independently retrieved main commit. |
| `EXP-20261127-11` | Substrate | 131.6 s | 41 | 3/3 | Three authors made nine publications. Six cross-peer citations had matching visits to the cited originals. Each of the three private exports passed the oracle. |
| `EXP-20261127-10` | Lead–Worker | 180.6 s | 29 | 3/3 | Two Workers delivered verified code and tests. The Lead cited both Workers' Board notes, incorporated both contributions and submitted `76c06c34`. The exported Git tree and verified submission bytes agreed. |

All five corrected attempts captured exactly four files with project digest `complete:sha256:951e4f1d337826e92fbbad0e2dd59a15c22e8f05b78f460ae1d5ff8eb23fbda5`. The host source bytes stayed unchanged. All five reported Core cleanup complete, and no Worker containers remained for their Runtime IDs. The run-owned PeerMesh and Lead–Worker facility containers and networks were removed. The earlier attempts also confirmed cleanup, including early failures with zero model requests.

The host ran the oracle from a separate working directory in a network-disabled container. It rejected changes to either seed policy and exercised an exact threshold, a station override, missing and malformed data, boolean and non-integer units, and empty input.

## Analysis

The evidence covers A11 on the project entry. TaskPool and PeerMesh were stopped after the host independently checked the committed product. TaskPool recorded `TASKPOOL_BUSINESS_FAILED` because the stop did not wait for closure of every Task. The final Workspace main also passed the oracle after close. PeerMesh recorded `RUN_STOPPING` and independently exported the same pinned main with a complete delivery receipt. Subagents, Substrate and static Lead–Worker settled normally. In all cases the host product verdict is distinct from the Harness's own status.

The early failures were experiment setup errors. The later runs used the remaining budget and retained the same installed tarball, model, Worker, project bytes, and acceptance checks. This matrix demonstrates that the five paths operate on supplied project bytes and can produce independently usable output. It gives no estimate of relative Harness performance.

## Next steps

Use the PR's final CI for the integrated tree and retain the archive and receipts as the candidate's A11 evidence.
