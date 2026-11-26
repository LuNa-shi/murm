# Domain documentation configuration

This is a single-context repository. Use the current [architecture manual](../architecture/INDEX.md), [SDK guides](../INDEX.md) and root [GLOSSARY.md](../../GLOSSARY.md) when describing murm.

- Core terms apply to every Harness. Mission, Task, Execution, Material and Workspace are TaskPool domain terms; do not require them in another Harness.
- Architecture describes implemented behavior, including retained compatibility paths. The approved Issue or explicit user request defines the next change.
- An active design under `docs/designs/` specifies future behavior only when accepted by its linked Issue. It must not be presented as a current API. See the [dynamic Lead-Worker target](../designs/dynamic-lead-worker.md).
- The English and Chinese user guides are also the website source. Keep their public API examples aligned with package exports and runnable examples.
- [AGENTS.md](../../AGENTS.md) defines autonomy, permissions and required implementation documentation. The [development workflow](../workflows/development.md) gives the build and validation procedure.

Use these terms when applying installed engineering skills. Do not create a competing `CONTEXT.md` or a local progress ledger. Record decisions and acceptance evidence in the originating Issue/PR.
