import FLT10.DAG_q50
open WeierstrassCurve WeierstrassCurve.Affine

set_option autoImplicit false

theorem FLT10Bench.q50_mazurStepThree_not_inZeroComponentAt
    {p : ℕ} (hp : p.Prime) (hp' : p ∉ ({2, 3, 5, 7, 13} : Finset ℕ))
    (W : WeierstrassCurve ℤ) (hΔ : W.Δ ≠ 0)
    (Q : ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point)
    (hQfix : ∀ σ : AlgebraicClosure ℚ ≃ₐ[ℚ] AlgebraicClosure ℚ, σ • Q = Q)
    (hQord : addOrderOf Q = p)
    (h2Δ : (2 : ℤ) ∣ W.Δ) (h2c₄ : ¬ (2 : ℤ) ∣ W.c₄)
    (h2 : ∀ A : ValuationSubring (AlgebraicClosure ℚ), A.LiesOverPrime 2 → ¬ W.InZeroComponentAt A Q)
    (h3Δ : (3 : ℤ) ∣ W.Δ) (h3c₄ : ¬ (3 : ℤ) ∣ W.c₄)
    (h3 : ∀ A : ValuationSubring (AlgebraicClosure ℚ), A.LiesOverPrime 3 → ¬ W.InZeroComponentAt A Q)
    {ℓ : ℕ} (hℓ : ℓ.Prime) (hℓp : ℓ ≠ p) (hℓΔ : (ℓ : ℤ) ∣ W.Δ) (hℓc₄ : ¬ (ℓ : ℤ) ∣ W.c₄)
    (A : ValuationSubring (AlgebraicClosure ℚ)) (hA : A.LiesOverPrime ℓ) :
    ¬ W.InZeroComponentAt A Q := by
  sorry
