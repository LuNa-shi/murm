# Security Policy

## Trust model

The trusted Controller runs the Harness, holds model upstream and external Service credentials, and binds each Bridge and Gateway request to its Agent. Each Agent runs in a separate Linux Sandbox under an unprivileged UID with no new privileges and a cleared capability set. Deploy OpenSandbox with an authenticated Lifecycle API and a trusted Worker image. Use TLS for connections across untrusted networks.

The default API policy checks management authentication on controller routes and from the Agent UID in the sandbox. The Controller keeps per-Sandbox Execd and Worker control credentials outside the Agent environment. Deployment-level network policy governs general egress. For explicitly administered local deployments, the strict Docker policy additionally uses a UID-based nftables allowlist, a bounded tmpfs, shared mount checks and Landlock ABI 5+.

Run output directories (`outputDir/<runtimeId>/`) contain prompts, model traces, Service call logs, native Sessions, and collected workspace artifacts — treat them as private operational data and never publish them publicly.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `< 0.2.0` | No |

## Reporting a vulnerability

Please **do not** open a public GitHub Issue for security vulnerabilities (such as sandbox escape, credential leakage across the Bridge/Model Gateway, or privilege escalation in host mount/network helpers).

Instead, report vulnerabilities privately through [GitHub Security Advisories](https://github.com/LuNa-shi/murm/security/advisories/new) on `LuNa-shi/murm`. Include:

- Affected `murm` version or commit SHA
- Minimal reproduction steps and host configuration
- Potential security impact and any suggested mitigation
