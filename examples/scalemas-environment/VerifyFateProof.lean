import Lean
import Lean.Replay

open Lean

unsafe def main (args : List String) : IO UInt32 := do
  let [target] := args | throw (IO.userError "Expected the pinned target name")
  initSearchPath (← findSysroot)
  let env ← importModules #[{ module := `FateExpected }, { module := `FateProofGuard }] {}
  let (candidate, region) ← readModuleData "/candidate/Candidate.olean"
  let mut constants : Std.HashMap Name ConstantInfo := {}
  for name in candidate.constNames, info in candidate.constants do
    if name != info.name || info.isAxiom || info.isUnsafe || (env.find? name).isSome then
      throw (IO.userError s!"Unsupported candidate declaration {name}")
    constants := constants.insert name info
  let name := target.toName
  let some (.thmInfo proof) := constants[name]? | throw (IO.userError "Original theorem missing")
  let some expected := env.find? (`FateExpected ++ name) | throw (IO.userError "Pinned target missing")
  unless proof.levelParams == expected.levelParams && proof.type == expected.type do
    throw (IO.userError "Target statement differs from the frozen declaration")
  let checked ← env.replay constants
  let (axioms, _) ← (collectAxioms name : CoreM (Array Name)).toIO
    { fileName := "<fate-verifier>", fileMap := "".toFileMap } { env := checked }
  unless axioms.all (#[`propext, `Quot.sound, `Classical.choice].contains ·) do
    throw (IO.userError s!"Unsupported axioms {axioms}")
  -- Keep the module data region alive through replay and dependency collection.
  let _ := region
  IO.println "fate-proof-verified"
  return 0
