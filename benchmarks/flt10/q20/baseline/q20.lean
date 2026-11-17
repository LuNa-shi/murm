import FLT10.DAG_q20
open WeierstrassCurve WeierstrassCurve.Affine WeierstrassCurve.Affine.Point
open CuspForm ModularFormClass UpperHalfPlane

set_option autoImplicit false

theorem FLT10Bench.q20_frey_reducible_hasCofixedLine (P : FreyPackage) (hred : ¬ GaloisRepIsIrreducible (K := AlgebraicClosure ℚ) ℚ P.freyCurve P.p) : HasGaloisStableCofixedLine (K := AlgebraicClosure ℚ) ℚ P.freyCurve P.p := by
  sorry
