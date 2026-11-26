# Core OpenSandbox capacity baseline for Issue #231

This bounded local engineering probe used [Issue #231](https://github.com/LuNa-shi/murm/issues/231), baseline `ffe2d9c8399f64bb0048cb5942c121b79cb3fc8b`, and polling candidate `81a19346e7b9607ef9cf7e8b47f6257640dbf82b`. Both runs used one Sandbox and one Pi session per Agent on the same rootful Linux Docker 29.8.2 host with cgroup v2, kernel `7.0.0-38-generic`, Node 24.21.0 and 250 schedulable CPUs. The image was pinned to `sha256:f56633a7aee93cb31699f8eb1fc6f3b78af321bf22ae1b7ec857a204e01db659`.

## Results

Each row is one observation. Each Agent had one CPU, 1 GiB of memory, and a 64 MiB tmpfs workspace with 4,096 inodes. The probe started up to four Agents at once, waited three seconds after the pool became ready, then sampled roughly ten seconds of idle time. Every Agent then ran the same task at once through ordinary Core input. The controlled local Responses server issued a Bash tool call to write 4 MiB, wait three seconds and check the byte count, then confirmed the result on the next model request. Each tier began after the previous tier had been cleaned up. No hosted model was used.

| Agents | Runtime | All ready (s) | Idle reads/s | Idle Sandbox CPU (cores) | Idle Sandbox memory (MiB) | Work (s) | Tasks/s | Sampled execution peak (MiB) | Close (s) |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Baseline | 4.00 | 9.63 | 0.034 | 104.1 | 3.21 | 0.31 | 112.6 | 0.59 |
| 1 | Backoff | 4.26 | 0.97 | 0.019 | 80.0 | 3.25 | 0.31 | 94.2 | 0.56 |
| 8 | Baseline | 8.96 | 77.63 | 0.334 | 774.1 | 3.49 | 2.29 | 971.1 | 1.94 |
| 8 | Backoff | 8.81 | 8.01 | 0.119 | 673.8 | 3.43 | 2.33 | 906.7 | 1.88 |
| 32 | Baseline | 36.55 | 309.07 | 1.119 | 2,949.3 | 4.14 | 7.72 | 3,660.0 | 6.54 |
| 32 | Backoff | 36.60 | 32.02 | 0.253 | 2,664.2 | 4.20 | 7.62 | 3,506.7 | 6.76 |

Idle reads fell by 89.6–89.9% across the three tiers. The nearest-rank P95 from the Worker prompt RPC dispatch to the first returned `agent_start` record changed from 82.5 to 124.9 ms at 1 Agent, 131.9 to 178.4 ms at 8, and 182.3 to 57.0 ms at 32. The largest observed increase was 46.5 ms. This timing includes event observation and excludes time in application code before Worker dispatch. In one test per runtime at 1 Agent, the interval from the host initiating an unexpected Pi exit to Core observing it was 122.6 ms on baseline and 372.4 ms with backoff. All six runs produced a complete Runtime cleanup receipt, with zero remaining owned Docker containers and zero remaining sampled Sandbox cgroups.

| Agents | Idle Pi PSS, baseline / backoff (MiB) | Idle Worker PSS, baseline / backoff (MiB) | Idle other process PSS, baseline / backoff (MiB) | Workspace tmpfs, idle → after work (MiB in both runs) |
|---:|---:|---:|---:|---:|
| 1 | 73.6 / 65.8 | 27.7 / 23.6 | 17.2 / 14.1 | 0.02 → 4.02 |
| 8 | 448.1 / 429.6 | 125.5 / 102.9 | 138.1 / 112.5 | 0.12 → 32.19 |
| 32 | 1,664.1 / 1,627.5 | 520.3 / 402.0 | 559.9 / 461.8 | 0.50 → 128.75 |

Memory and CPU in the first table sum the Sandbox cgroups. Idle memory is the last idle `memory.current` sample and idle CPU is the change in `usage_usec` divided by elapsed time. Execution peak is the largest aggregate sample taken roughly once per second. Process proportional set size (PSS) and cgroup accounting answer different questions and should be compared independently. `memory.stat` includes shared-memory bytes in its file counter. At 32 Agents the candidate's last idle sample had 2,193 MiB anonymous memory, 277 MiB file memory including 0.5 MiB shared memory, and 126 MiB kernel memory. The separately sampled host Docker daemon and OpenSandbox provider PSS were 282 and 151 MiB before that tier and 281 and 152 MiB during idle. Those host processes can also serve other workloads.

### Linux setup smoke

The supported checkout entry point `./scripts/setup` passed from a source-only archive of `ffe2d9c8` with empty npm and Docker image caches. Docker and containerd used private data roots in an isolated mount and network namespace on the same supported Linux kernel. The freshly started daemon listed zero images and containers. Setup completed in 173.01 s, including 4.22 s for npm dependencies, 1.55 s for the checkout build, 139.28 s for the Worker image, 21.46 s to pull and start OpenSandbox and Execd, and 5.50 s for smoke. A following `murm doctor --smoke` completed in 5.54 s including 4.84 s of smoke. Both ran real OpenSandbox and Pi, authenticated the Bridge Service hop, wrote and read exact file bytes, exported after stop, and confirmed Sandbox deletion with zero pending resources. The test provider was then removed and the private daemon stopped. This exercise began with Docker, Node and the required Linux host privileges already installed.

A separate fresh-checkout run with the base, provider and Execd images cached also passed setup and doctor. An external project created by `murm init` passed `doctor --smoke` in the same local environment.

## Analysis

The fixed workload met the request-rate, start-observation and reachable-Worker exit targets in Issue #231. At 32 Agents, cgroup CPU during idle fell from about 1.12 cores to 0.25. Per-Agent startup took roughly 4–5 seconds. At the fixed startup concurrency of four, 32 Agents took about 37 seconds to become ready.

Pi was the largest measured process category in this small-workspace workload. Identical task files occupied about 128 MiB of tmpfs at 32 Agents. Real checkouts and build caches can change that split. A single observation per version and tier does not establish a hosting limit, a lasting memory reduction from the polling change, or an execution-throughput trend. The task contains an intentional three-second wait and uses scripted local Responses.

## Next steps

For a deployment sizing decision, rerun the same measurements with representative workspaces and multiple matched trials. The current measurements retain independent Sandboxes and provide a starting point for deciding which component to investigate under a real workload.

### Reproduce

Build the repository with `npm ci` and `npm run build` on a Linux host prepared according to [the setup and runtime documentation](../architecture/16-pi-opensandbox-backend.md). Set `MURM_CORE_TEST_IMAGE` to the pinned image ID above, `MURM_CORE_TEST_LIFECYCLE_URL` to the local provider's `/v1` endpoint, and `MURM_CAPACITY_PROVIDER_CONTAINER` to that provider's Docker container for the host PSS sample. If the Docker bridge uses a different gateway, set `MURM_CORE_TEST_ADVERTISE_HOST` to that address. Run `node dist/test/probes/core-capacity.js 1 8 32`. For the baseline, copy only the same [probe source](../../test/probes/core-capacity.ts) into a clean checkout of the pinned baseline before building. The probe writes its manifest and per-tier aggregate samples under ignored `experiments/`, requires sufficient available memory before each tier, and stops on failed work or unconfirmed recovery.
