import FLT10.DAG_q30
open WeierstrassCurve.Affine WeierstrassCurve.Affine.Point ValuationSubring open WeierstrassCurve hiding card

set_option autoImplicit false

theorem FLT10Bench.q30_exists_atP_filtration_of_multiplicativeReduction
    (W : WeierstrassCurve ℤ) (p : ℕ) [Fact p.Prime] (hp2 : p ≠ 2) (hΔ : W.Δ ≠ 0)
    (hpΔ : (p : ℤ) ∣ W.Δ) (hpc₄ : ¬ (p : ℤ) ∣ W.c₄)
    (A : ValuationSubring (AlgebraicClosure ℚ)) (hA : A.LiesOverPrime p)
    (m : ℕ) (hm : 1 ≤ m) :
    ∃ F : AddSubgroup ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point,
      (∀ x : ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point,
        x ∈ F ↔ p ^ m • x = 0 ∧ W.InZeroComponentAt A x) ∧
      Nat.card F = p ^ m ∧
      (∀ σ ∈ A.decompositionSubgroup ℚ, ∀ x ∈ F, σ • x ∈ F) ∧
      ∀ σ ∈ A.inertiaSubgroupIn ℚ,
        ∀ y : ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point,
        p ^ m • y = 0 → σ • y - y ∈ F := by
  sorry
