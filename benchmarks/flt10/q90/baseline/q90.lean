import FLT10.DAG_q90
open WeierstrassCurve WeierstrassCurve.Affine WeierstrassCurve.Affine.Point
open CuspForm ModularFormClass UpperHalfPlane

set_option autoImplicit false

theorem FLT10Bench.q90_level_lowering_to_two (P : FreyPackage) (hmod : P.freyCurve.IsModular) (hirr : GaloisRepIsIrreducible (K := AlgebraicClosure ℚ) ℚ P.freyCurve P.p) : ∃ f : CuspForm (CongruenceSubgroup.Gamma0 2) 2, f ≠ 0 := by
  sorry
