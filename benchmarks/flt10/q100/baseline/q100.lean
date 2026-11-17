import FLT10.DAG_q100

set_option autoImplicit false

theorem FLT10Bench.q100_fermat_last_theorem
    (n : ℕ) (hn : 3 ≤ n)
    (a b c : ℕ)
    (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) :
    a ^ n + b ^ n ≠ c ^ n := by
  sorry
