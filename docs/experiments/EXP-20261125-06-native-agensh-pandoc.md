# EXP-20261125-06 · Upstream Agensh Pandoc comparison

## Registration

The owner authorized one comparison run for [Issue #201](https://github.com/LuNa-shi/SwarmEnv/issues/201) on 2026-11-25 UTC. Run the same ProgramBench Pandoc task in Microsoft Agensh with Kimi K3, four peers and a one-hour budget to compare the actual collaboration with [the SwarmEnv run](EXP-20261125-05-agensh-pandoc.md). Observe peer work selection, Git branches and PR roles, delivery into `main`, how peers receive and use messages or each other's work, and the archived state. The operator observes without assigning work, sending in-run input or merging. The native task pack retains its own scheduled reminders.

| Setting | Frozen value |
| --- | --- |
| Upstream system | [microsoft/Agensh at `2dae4e14a653da48549fd9aa093f834841475d6c`](https://github.com/microsoft/Agensh/tree/2dae4e14a653da48549fd9aa093f834841475d6c) |
| Task | `jgm__pandoc.5caad90`, official cleanroom image ID `sha256:02add2de637e9b5f42ecb3600944a15f7a6311107a872f2a95b31eb97c279681`; offline task pack |
| Native images | Worker `sha256:f8f8ad00be2cd705d1629cddea518274a11b7e7fad78bd05d5afc83d7756910d`; Router `sha256:871cfb987930ca2bf1ac9f99b6dde1d2f96f8d7809ad7bbe08405cde6ba6ebf7`; Board `sha256:4dd0d15e6909eafdd79ce0762f4b56b5a7b9b5b7a0b9a72554ce282d638281ea`. |
| Model | Same `kimi_proxy/k3` Responses route and medium reasoning effort as SwarmEnv; Pi 1.3.0; 256,000 effective input context. Native proxy generation and aggregate token caps disabled. |
| Peer resources | Four peers, one CPU and 1 GiB per worker. The native Compose workspace uses its own storage and isolation. |
| Window | One hour from the upstream driver's time anchor just before worker activation. Fixed-length profile. Native transport timeouts and retry behavior remain in effect. |
| Prompts, task policy, tools | Upstream prompt set SHA-256 `68698b3f78c4900ff7d58e82c22fe3406c428f2489cfb1f770a6405481e088f8`, pack SHA-256 `3cff84b635781fbf08ca4ccef21a6bba1c6d70dab222c2b33baa49e51f05fd70`, tool policy SHA-256 `67b8ae54ce48d8ec58ee0388ec41441f8937b705f141be549c195e820c625d16`. |
| Host adaptation | Compose overlay binds Gitea and Mattermost to local ports, SHA-256 `61fbd21413c284fe6beffc294b289facb16461cde9b9f67080d7376ca174e120`. Original preflight and chain run phase. Host lacks the optional reboot guard. Launcher SHA-256 `4c6656dc58a047727638ab38fcef85e7df1baa5f8d6d62e34ea9fbc6166fccc3`. |
| Comparison | SwarmEnv `ce7b0d6`, EXP-20261125-05. Compare observed collaboration paths and result at cutoff. Native task instructions and lifecycle remain part of the comparison. |
| Archive check | Pin the actual final `main` commit, inspect its Git history and candidate source, and check buildability independently where possible. ProgramBench tooling is pinned to `27f02157c785f8da3647aa6dbbe6b9137f99f10e`. No task-score threshold. Raw logs, sessions, source and facility data stay local. |

## Results

Pending.

## Analysis

Pending.

## Next steps

Run the registered native team and preserve its evidence for side-by-side analysis.
