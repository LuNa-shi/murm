import FLT10.DAG_q60
open WeierstrassCurve WeierstrassCurve.Affine WeierstrassCurve.Affine.Point
open CuspForm ModularFormClass UpperHalfPlane

set_option autoImplicit false

theorem FLT10Bench.q60_frey_no_cofixed_large (P : FreyPackage) (hp : 17 ≤ P.p) : ¬ HasGaloisStableCofixedLine (K := AlgebraicClosure ℚ) ℚ P.freyCurve P.p := by
  sorry
