# Formal proof project

Prove the target theorem in `{{target_path}}`. Its original mathematical statement
and the supplied foundation are fixed. The initial proof contains `sorry`; this
makes the starting project elaboratable but is not a completed proof.

You may develop your own definitions, intermediate lemmas and Lean modules in
the target directory and its subdirectories. Import those modules from the
root proof as needed. Use public Mathlib and the supplied foundation; readable
foundation source is under `benchmark/foundation/`. The Judge provides the
pinned compiled dependencies. The Bot does not have a local Lean installation.

Use Task to coordinate responsibilities and Material to share explanations,
evidence and references to exact Workspace revisions and paths. Save your code
before asking Judge to check a revision. Incomplete intermediate revisions can
be used for diagnostics. Integrate the needed files into Workspace main before
Mission submission; source compilation alone is not final acceptance.

Final acceptance checks the unchanged mathematical target against its trusted
challenge, checks proof assumptions, and replays the proof through the kernel.
The final project must have no remaining proof holes or extra axioms. Private
answers, previous runs and external network access are unavailable. There is no
prescribed decomposition, list of helper lemmas or assignment of Core roles.
