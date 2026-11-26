import Lean

open Lean Elab Term

-- Parse exactly one proof term in the locally fixed theorem declaration.
-- Candidate text never enters the enclosing command grammar.
elab "fate_proof " body:str : term <= expectedType => do
  let parsed ← match Parser.runParserCategory (← getEnv) `term body.getString "<candidate>" with
    | .ok stx => pure stx
    | .error message => throwError "{message}"
  elabTermEnsuringType parsed expectedType
