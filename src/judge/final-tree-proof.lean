import Comparator
import Export.Parse
import Lean.Replay

open Lean

private def parseExport (path : String) : IO Export.ExportedEnv := do
  let handle ← IO.FS.Handle.mk path .read
  Export.parseStream (IO.FS.Stream.ofHandle handle)

private def requireTheorem (environment : Export.ExportedEnv) (name : Name) : IO Unit :=
  match environment.constMap[name]? with
  | some (.thmInfo _) => pure ()
  | _ => throw (IO.userError "Missing named theorem")

-- Retain compatibility with older replay APIs without prefixing the exact
-- success marker with compiler deprecation diagnostics on newer toolchains.
set_option linter.deprecated false in
def main (args : List String) : IO UInt32 := do
  let [target, originalPath, candidatePath] := args
    | throw (IO.userError "Invalid verifier arguments")
  let target := target.toName
  let original ← parseExport originalPath
  requireTheorem original target
  -- Deserialization and replay resource failures propagate as operational
  -- failures. Only explicit theorem/statement/axiom rejection is conclusive.
  let candidate ← parseExport candidatePath
  unless (match candidate.constMap[target]? with | some (.thmInfo _) => true | _ => false) do
    return 42
  let axioms := #[`propext, `Quot.sound, `Classical.choice]
  -- These declarations have special meaning in the kernel. Their definitions
  -- must agree with the trusted export, as must the theorem statement graph.
  let primitives := #[`Nat.add, `Nat.sub, `Nat.mul, `Nat.pow, `Nat.gcd, `Nat.div,
    `Nat.mod, `Nat.beq, `Nat.ble, `Nat.land, `Nat.lor, `Nat.xor, `Nat.shiftLeft,
    `Nat.shiftRight, `String.ofList, `Char.ofNat, `List, `eagerReduce]
  if (Comparator.compareAt original candidate (#[target] ++ axioms) #[] primitives).isOk &&
      (Comparator.checkAxioms candidate #[target] #[] axioms).isOk then
    let constants := candidate.constMap.erase `Quot.mk |>.erase `Quot.lift |>.erase `Quot.ind
    let replayed ← (← mkEmptyEnvironment).replay constants
    unless (match replayed.toKernelEnv.find? target with | some (.thmInfo _) => true | _ => false) do
      return 42
    IO.println "SWARMENV_FINAL_TREE_VERIFIED"
    return 0
  else
    return 42
