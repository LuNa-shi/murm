# Agent Core uses local NuRouter and Pi

Status: accepted. Every real MVP Agent Core runs Pi through the local NuRouter entry point. NuRouter owns provider, account, group, and model routing; Pi owns the model and tool loop; Runtime owns the process, lease, workspace, checkpoint, and fencing lifecycle. A deterministic ScriptExecutor may replace the Agent Core only in protocol tests so model quality does not obscure lifecycle verification.

## Decision

The adapter always starts Pi through the local NuRouter entry point, with Pi session storage and session ID bound to the Execution. NuRouter 0.2.12 accepts managed Kimi selection as `nurouter pi --provider kimi --model <model> --account <account> --group <group> -- --mode rpc`; its OpenAI route accepts `nurouter pi --account <account> --group <group> -- --mode rpc --provider openai --model <model>`, with account and group omitted when the local route supplies defaults. The adapter selects the provider-specific form and forwards only configured account/group selectors, so the Agent Core cannot bypass NuRouter. Credentials and routing configuration remain local Runtime configuration and never enter Task, Material, CheckResult, or public checkpoint content.

The Pi package is `@earendil-works/pi-coding-agent`. Each MVP build or release resolves the stable npm `latest` tag to an exact version and records that `pi_version`, the NuRouter version, the Node version, and the launch arguments in the runtime manifest. A running Execution never upgrades its Pi process. A Pi session is a recovery aid only; after fencing or takeover, the new Agent Core follows the persisted Task specification, input snapshot, checkpoint lineage, and steer Materials.

## Consequences

The Agent Core Adapter is the seam between Runtime and Pi. It translates an Execution into a local NuRouter/Pi process and translates Pi output into the public operations for Task Flow and Context Store. Pi session files are replaceable execution artifacts, while the four core objects remain authoritative. The MVP must test both the deterministic protocol adapter and the real NuRouter/Pi startup path.
