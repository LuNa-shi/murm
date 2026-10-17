# Agent Core uses local NuRouter and Pi

Status: accepted. Every real MVP Agent Core runs Pi through the local NuRouter entry point. NuRouter owns provider, account, group, and model routing; Pi owns the model and tool loop; Runtime owns the process, lease, workspace, checkpoint, and fencing lifecycle. A deterministic ScriptExecutor may replace the Agent Core only in protocol tests so model quality does not obscure lifecycle verification.

## Decision

The standard launch shape is `nurouter pi --provider <provider> --model <model> --account <account> --group <group> -- --mode rpc`, with Pi session storage and session ID bound to the Execution. The exact arguments are runtime configuration, but the Agent Core cannot call a provider directly or bypass NuRouter. Credentials and routing configuration remain local Runtime configuration and never enter Task, Material, CheckResult, or public checkpoint content.

The Pi package is `@earendil-works/pi-coding-agent`. Each MVP build or release resolves the stable npm `latest` tag to an exact version and records that `pi_version`, the NuRouter version, the Node version, and the launch arguments in the runtime manifest. A running Execution never upgrades its Pi process. A Pi session is a recovery aid only; after fencing or takeover, the new Agent Core follows the persisted Task specification, input snapshot, checkpoint lineage, and steer Materials.

## Consequences

The Agent Core Adapter is the seam between Runtime and Pi. It translates an Execution into a local NuRouter/Pi process and translates Pi output into the public operations for Task Flow and Context Store. Pi session files are replaceable execution artifacts, while the four core objects remain authoritative. The MVP must test both the deterministic protocol adapter and the real NuRouter/Pi startup path.
