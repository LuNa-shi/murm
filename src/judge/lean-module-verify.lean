/-
The import/replay sequence follows LeanChecker.replayFromImports, distributed
with Lean under Apache 2.0, copyright 2023 Kim Morrison and Sebastian Ullrich.

Recheck a locally elaborated module in a fresh process. Imported extensions and
initializers are disabled. Only this module's safe declarations are replayed.
Lean.Environment.replay checks safe declarations. Its documented treatment of
unsafe and partial declarations and ordinary diagnostic axioms is retained.
The source binding records trusted frontend completion under Lean's ordinary
metaprogram trust assumptions. It is not a hostile native-code attestation.
-/
import Lean
import Lean.Replay
open Lean

-- Keep the replay API available on older toolchains without compiler deprecation
-- warnings prefixing this driver's strict JSON output on newer toolchains.
set_option linter.deprecated false in
unsafe def main (args : List String) : IO UInt32 := do
  initSearchPath (← findSysroot)
  let [target, moduleName, binding] := args | throw <| IO.userError "Invalid module verification arguments"
  let file : System.FilePath := ⟨target⟩
  let mut paths := #[file]
  for level in #[OLeanLevel.server, OLeanLevel.private] do
    let part := level.adjustFileName file
    if ← part.pathExists then paths := paths.push part
  let parts ← readModuleDataParts paths
  if h : parts.size = 0 then throw <| IO.userError "Missing module data" else
  let (header, _) := parts[0]
  let (_, state) ← importModulesCore header.imports |>.run
  let env ← finalizeImport state header.imports {} 0 false false (isModule := true)
  let mut constants : Std.HashMap Name ConstantInfo := {}
  for name in parts[parts.size - 1].1.constNames, ci in parts[parts.size - 1].1.constants do
    constants := constants.insert name ci
  let bindingName := moduleName.toName ++ `_swarmenvModuleCompletion
  let some (.defnInfo info) := constants[bindingName]? | throw <| IO.userError "Missing frontend completion binding"
  unless info.value == mkStrLit binding && info.type == mkConst ``String && info.safety == .safe do
    throw <| IO.userError "Module completion binding differs from fixed input"
  discard <| env.replay constants
  let axioms := constants.toList.filterMap fun (name, info) =>
    if info.isAxiom && name != ``sorryAx then some name.toString else none
  IO.println <| Json.compress <| Json.mkObj [
    ("status", toJson "verified"), ("axioms", toJson axioms)]
  return 0
