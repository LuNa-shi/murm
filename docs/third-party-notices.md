# Third-party notices

The terms in [LICENSE](../LICENSE) cover murm's original code and documentation. The following incorporated materials carry their own notices and terms.

| Material | License and provenance |
| --- | --- |
| Codex CLI in the Worker image | Apache-2.0. The image installs `@openai/codex` 0.172.0 from OpenAI. [Upstream license](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/LICENSE) at the `rust-v0.172.0` revision. |
| OpenSandbox JavaScript SDK | Apache-2.0. The Controller installs `@alibaba-group/opensandbox` 1.2.1. [Upstream license](https://github.com/opensandbox-group/OpenSandbox/blob/db708c218771a8d311356f0e96552c15df6e097a/LICENSE) |
| Lean module replay driver | Apache-2.0. The [driver notice](../examples/taskpool/services/judge/lean-module-verify.NOTICE.md) identifies the upstream source, copyright and local modifications. [Upstream license copy](../examples/taskpool/services/judge/lean-module-verify.LICENSE.txt) |
| Agensh Board schema fixture (source-checkout tests) | MIT. [Source attribution and license copy](../test/fixtures/agensh-board-schema.LICENSE.txt) |
| Agensh reference implementation | Separate Git submodule. See the [upstream license](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/LICENSE) at the recorded revision. |
| Website fonts | SIL Open Font License 1.1. [Caveat](../website/public/licenses/caveat.txt) · [Departure Mono](../website/public/licenses/departure-mono.txt) · [Inter](../website/public/licenses/inter.txt) · [JetBrains Mono](../website/public/licenses/jetbrains-mono.txt) · [Space Grotesk](../website/public/licenses/space-grotesk.txt) |
| Trace Viewer fonts | SIL Open Font License 1.1. [Departure Mono](../src/trace-viewer/public/licenses/departure-mono.txt) · [Inter](../src/trace-viewer/public/licenses/inter.txt) · [Space Grotesk](../src/trace-viewer/public/licenses/space-grotesk.txt) |

Installed dependencies and externally fetched benchmark inputs carry terms from their respective projects. Consult their accompanying notices when redistributing them.

- `@earendil-works/pi-tui@1.3.0` (MIT) supplies the foreground terminal editor, layout, lists and scroll controls.
