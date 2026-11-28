# Research context

murm studies how groups of Agents turn additional computation into useful, accumulated work. Its engineering goal is a reusable SDK for changing collaboration mechanisms while keeping Agent execution, isolation, Service access and Run records on a common foundation.

## What the toolkit contributes

A Harness composes Agent Profiles, Services and a control loop. The Runtime supplies the execution primitives. A Service can hold a task pool, a mailbox, a shared knowledge store, a Board or access to an existing application. This makes coordination explicit and changeable without rebuilding the Agent loop.

The five included Harnesses make different choices about responsibility and sharing. TaskPool uses exclusive task ownership and a shared Workspace; Subagents gives a parent scoped control over children; PeerMesh uses peer communication and Git; Substrate organizes reusable contributions; Lead-Worker combines direction, a Board and fixed or dynamically added helpers. These mechanisms are applications of the Core, not universal requirements for every multi-agent system.

## Questions to investigate

- When do Agents choose useful complementary work instead of repeatedly exploring the same objective?
- When does a published contribution become an actual input to another Agent's work?
- When does feedback change the approach rather than produce another iteration of the same attempt?
- How do extra time and parallel capacity affect accumulated results, integration delay and total cost?
- Can later Agents continue useful work through explicit artifacts, and what context reconstruction does this require?
- Which task structures benefit from a leader, exclusive ownership or peer coordination?

The SDK exposes operations needed to investigate these questions. Successful execution or a high message count does not answer them. Comparisons need fixed task inputs, model and resource settings, explicit result checks and observations of actual collaboration.

## Current evaluation and documentation

The repository includes [ProgramBench Pastel](../benchmarks/programbench-pastel/README.md), [PutnamBench TaskPool](../benchmarks/putnambench-taskpool/README.md), and [Substrate FATE configurations](../examples/substrate/README.md). These are opt-in evaluation paths with their own inputs, limits and result checks. Earlier embedded datasets and dedicated mathematical runners remain in the [fixed research revision](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9).

Use the [Runtime](en/runtime.md) and [Swarm Harness](en/build-your-harness.md) guides to build a Harness and the [architecture manual](architecture/INDEX.md) to inspect the implementation. Proposed research and engineering work belongs in the relevant human-approved Issue. [Historical experiment reports](https://github.com/LuNa-shi/murm/blob/207be6356c16e5fb60c4b3c5b236d7a98383f991/docs/experiments/INDEX.md) preserve version-specific observations; the [experiment workflow](workflows/experiment.md) defines their evidence and resource requirements.
