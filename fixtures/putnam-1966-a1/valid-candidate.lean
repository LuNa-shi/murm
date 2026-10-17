import Mathlib

noncomputable section

open scoped BigOperators

def term (m : ℤ) : ℤ := if Even m then m / 2 else (m - 1) / 2

def F (n : ℤ) : ℤ := ∑ m ∈ Finset.Icc 0 n, term m

def G (n : ℕ) : ℤ := ∑ m ∈ Finset.range (n + 1), (m : ℤ) / 2

lemma term_eq_div (m : ℤ) : term m = m / 2 := by
  by_cases he : Even m
  · simp [term, he]
  · have ho : Odd m := Int.not_even_iff_odd.mp he
    rcases ho with ⟨k, hk⟩
    simp [term, hk]
    omega

lemma F_nat (n : ℕ) : F n = G n := by
  rw [F, Int.Icc_eq_finset_map]
  simp only [Finset.sum_map]
  simp [G, term_eq_div]

lemma div_two_even_nat (k : ℕ) : ((2 * k : ℕ) : ℤ) / 2 = k := by omega

lemma div_two_odd_nat (k : ℕ) : ((2 * k + 1 : ℕ) : ℤ) / 2 = k := by omega

lemma G_succ (n : ℕ) : G (n + 1) = G n + ((n + 1 : ℕ) : ℤ) / 2 := by
  simp [G, Nat.add_assoc, Finset.sum_range_succ]

lemma G_even (k : ℕ) : G (2 * k) = (k : ℤ) * k := by
  induction k with
  | zero => simp [G]
  | succ k ih =>
    rw [show 2 * (Nat.succ k) = 2 * k + 2 by omega, G_succ, G_succ, ih]
    have hodd : ((2 * k + 1 : ℕ) : ℤ) / 2 = k := div_two_odd_nat k
    have heven : ((2 * k + 1 + 1 : ℕ) : ℤ) / 2 = k + 1 := by omega
    rw [hodd, heven]
    push_cast
    ring

lemma G_odd (k : ℕ) : G (2 * k + 1) = (k : ℤ) * (k + 1) := by
  rw [show 2 * k + 1 = (2 * k) + 1 by omega, G_succ, G_even]
  rw [div_two_odd_nat]
  ring

lemma F_even {k : ℤ} (hk : 0 ≤ k) : F (2 * k) = k * k := by
  have hnat : (k.toNat : ℤ) = k := Int.toNat_of_nonneg hk
  rw [← hnat]
  rw [show 2 * (k.toNat : ℤ) = ((2 * k.toNat : ℕ) : ℤ) by norm_num]
  rw [F_nat, G_even]

lemma F_odd {k : ℤ} (hk : 0 ≤ k) : F (2 * k + 1) = k * (k + 1) := by
  have hnat : (k.toNat : ℤ) = k := Int.toNat_of_nonneg hk
  rw [← hnat]
  rw [show 2 * (k.toNat : ℤ) + 1 = ((2 * k.toNat + 1 : ℕ) : ℤ) by norm_num]
  rw [F_nat, G_odd]

theorem swarmenv_fixture_candidate
(f : ℤ → ℤ)
(hf : f = fun n : ℤ => ∑ m ∈ Finset.Icc 0 n, (if Even m then m / 2 else (m - 1)/2))
: ∀ x y : ℤ, x > 0 ∧ y > 0 ∧ x > y → x * y = f (x + y) - f (x - y) := by
  intro x y hxy
  rw [hf]
  change x * y = F (x + y) - F (x - y)
  rcases Int.even_or_odd' x with ⟨a, rfl | rfl⟩
  · rcases Int.even_or_odd' y with ⟨b, rfl | rfl⟩
    · have ha : 0 ≤ a := by omega
      have hab : 0 ≤ a - b := by omega
      rw [show 2 * a + 2 * b = 2 * (a + b) by ring,
        show 2 * a - 2 * b = 2 * (a - b) by ring,
        F_even (by omega), F_even hab]
      ring
    · have ha : 0 ≤ a := by omega
      have hab : 0 ≤ a - b - 1 := by omega
      rw [show 2 * a + (2 * b + 1) = 2 * (a + b) + 1 by ring,
        show 2 * a - (2 * b + 1) = 2 * (a - b - 1) + 1 by ring,
        F_odd (by omega), F_odd hab]
      ring
  · rcases Int.even_or_odd' y with ⟨b, rfl | rfl⟩
    · have hab : 0 ≤ a - b := by omega
      rw [show (2 * a + 1) + 2 * b = 2 * (a + b) + 1 by ring,
        show (2 * a + 1) - 2 * b = 2 * (a - b) + 1 by ring,
        F_odd (by omega), F_odd hab]
      ring
    · have hab : 0 ≤ a - b := by omega
      rw [show (2 * a + 1) + (2 * b + 1) = 2 * (a + b + 1) by ring,
        show (2 * a + 1) - (2 * b + 1) = 2 * (a - b) by ring,
        F_even (by omega), F_even hab]
      ring
