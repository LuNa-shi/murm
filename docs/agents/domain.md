# Domain documentation configuration

This is a single-context repository. Use the current [architecture manual](../architecture/INDEX.md), [SDK guides](../INDEX.md) and root [GLOSSARY.md](../../GLOSSARY.md) when describing murm.

- Core terms apply to every Harness. Mission, Task, Execution, Material and Workspace are TaskPool domain terms; do not require them in another Harness.
- Architecture describes implemented behavior, including retained compatibility paths. The [Phase 0005 design](../designs/core-harness/README.md) governs target behavior for Core / Harness. In other stages, the approved Issue defines the next change.
- Reviewed designs describe target behavior. See the [dynamic Lead-Worker extension](../designs/dynamic-lead-worker.md) for an approved extension awaiting implementation.
- The English and Chinese user guides are also the website source. Keep their public API examples aligned with package exports and runnable examples.
- [AGENTS.md](../../AGENTS.md) defines autonomy, permissions and required implementation documentation. The [development workflow](../workflows/development.md) gives the build and validation procedure.

Use these terms when applying installed engineering skills. Do not create a competing `CONTEXT.md` or a local progress ledger. Record decisions and acceptance evidence in the originating Issue/PR.
