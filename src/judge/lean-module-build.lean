/-
Trusted frontend completion and module serialization for development checks.
The completion constant is added only after runFrontend returns successfully.
This follows Lean's ordinary in-process metaprogram trust assumptions. Candidate
native code can deliberately imitate this protocol, so it is not a sandbox
attestation against hostile compiler extensions.
-/
import Lean
open Lean
unsafe def main (args : List String) : IO UInt32 := do
  initSearchPath (← findSysroot)
  let [source, moduleName, target, binding] := args | throw <| IO.userError "Invalid module build arguments"
  enableInitializersExecution
  let some env ← Elab.runFrontend (← IO.FS.readFile source) {} source moduleName.toName
    (jsonOutput := true) | return 21
  let decl := Declaration.defnDecl {
    name := moduleName.toName ++ `_swarmenvModuleCompletion
    levelParams := []
    type := mkConst ``String
    value := mkStrLit binding
    hints := .opaque
    safety := .safe
  }
  let env ← match env.addDeclCore 0 0 decl none with
    | .ok env => pure env
    | .error ex => throw <| IO.userError (← ex.toMessageData {} |>.toString)
  writeModule env target (writeIR := false)
  return 0
