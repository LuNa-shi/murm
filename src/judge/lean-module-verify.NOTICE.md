# Lean module replay driver provenance

`lean-module-verify.lean` adapts the import/module-data/replay sequence from
[`replayFromImports` in Lean v4.33.1 `src/LeanChecker.lean`](https://github.com/leanprover/lean4/blob/v4.33.1/src/LeanChecker.lean).

The upstream file identifies:

```text
Copyright (c) 2023 Kim Morrison. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Kim Morrison, Sebastian Ullrich
```

Modified in murm: the driver accepts explicit object-file, module-name and
completion-binding arguments instead of the upstream module-discovery CLI. It
loads the available object-file parts, checks the added frontend completion
binding, replays the collected declarations and returns a JSON verification
result with its diagnostic axiom list. It has a local deprecation-warning guard.
This is an adapted sequence, not an unchanged copy of the upstream CLI, and its
checks remain subject to Lean's ordinary metaprogram trust assumptions.
`lean-module-build.lean` and `final-tree-proof.lean` are separate local drivers;
this notice identifies the adapted material in `lean-module-verify.lean` only.

[`lean-module-verify.LICENSE.txt`](lean-module-verify.LICENSE.txt) is an exact copy
of [the pinned upstream LICENSE](https://github.com/leanprover/lean4/blob/v4.33.1/LICENSE)
(SHA-256 `8b28515ffffc5c0fe2807d8ae3735b00b324d9b7ce807dd63ff6ac8922fbce7e`).
The source SHA-256 at that tag is
`eb5dee411837629f09c5c18d63cc833d30335a46048bc586642742e90aa65d5f`.
The inspected upstream repository root has no `NOTICE` file. This local
provenance attachment is not presented as an upstream NOTICE.

These third-party terms apply to the identified adapted material. This attachment
does not select a license for the murm project or grant publication approval.
