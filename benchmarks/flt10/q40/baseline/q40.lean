import FLT10.DAG_q40
open WeierstrassCurve.Affine WeierstrassCurve.Affine.Point ValuationSubring open WeierstrassCurve hiding card

set_option autoImplicit false

theorem FLT10Bench.q40_exists_quotientDatum_of_galois_stable_primeCard
    (W : WeierstrassCurve ℤ) (hΔ : W.Δ ≠ 0)
    {p : ℕ} (hp : p.Prime) (hp2 : p ≠ 2)
    (L : AddSubgroup ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point)
    (hLcard : Nat.card L = p)
    (hLstab : ∀ σ : AlgebraicClosure ℚ ≃ₐ[ℚ] AlgebraicClosure ℚ, ∀ x ∈ L, σ • x ∈ L) :
    ∃ (W' : WeierstrassCurve ℤ)
      (φ : ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point →+
           ((W'.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point),
      W'.Δ ≠ 0 ∧ φ.ker = L ∧
      (∀ (σ : AlgebraicClosure ℚ ≃ₐ[ℚ] AlgebraicClosure ℚ)
         (x : ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point),
        φ (σ • x) = σ • φ x) ∧
      (∀ q : ℕ, q.Prime → q ≠ p → (q : ℤ) ∣ W.Δ → ¬ (q : ℤ) ∣ W.c₄ →
        ((q : ℤ) ∣ W'.Δ ∧ ¬ (q : ℤ) ∣ W'.c₄ ∧
          ∀ A : ValuationSubring (AlgebraicClosure ℚ), A.LiesOverPrime q →
            ∀ y : ((W.map (Int.castRingHom ℚ))⁄(AlgebraicClosure ℚ)).Point,
              (W'.InZeroComponentAt A (φ y) ↔
                ∃ k ∈ L, W.InZeroComponentAt A (y - k)))) := by
  sorry
