# Security Policy

## Trust model

`murm` enforces a strict boundary between the **trusted host** (which runs your Harness, holds upstream model credentials and external Service tokens, and enforces access control) and **isolated Agent sandboxes** (unprivileged containers bounded by Linux namespaces, `tmpfs` disk quotas, Landlock ABI 5+, and `nftables` egress rules).

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
