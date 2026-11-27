;; The first 64 bytes hold scratch cumulative probabilities (8 f64s).
;; The learned weights are packed as little-endian f32s, 8 tokens per row.
(module
  (import "math" "exp" (func $exp (param f64) (result f64)))
  (memory (export "memory") 1 1)
  (data (i32.const 64) "@WEIGHTS@")
  (func (export "version") (result i32) (i32.const 2))

  (func $weight (param $row i32) (param $token i32) (result f64)
    (f64.promote_f32
      (f32.load offset=64
        (i32.mul (i32.const 4) (i32.add (i32.mul (local.get $row) (i32.const 8)) (local.get $token))))))

  (func (export "sample")
    (param $stage i32) (param $topic i32) (param $first i32) (param $size i32) (param $random f64)
    (result i32)
    (local $token i32) (local $topicRow i32) (local $score f64) (local $total f64) (local $target f64)
    (local.set $topicRow
      (i32.add (i32.mul (i32.add (local.get $topic) (i32.const 1)) (i32.const 4)) (local.get $stage)))
    (loop $distribution
      (local.set $score
        (f64.add
          (call $weight (local.get $stage) (local.get $token))
          (call $weight (local.get $topicRow) (local.get $token))))
      (if (i32.eq (local.get $stage) (i32.const 2))
        (then (local.set $score
          (f64.add (local.get $score)
            (call $weight (i32.add (i32.const @HISTORY_BASE@) (local.get $first)) (local.get $token))))))
      (local.set $total (f64.add (local.get $total) (call $exp (local.get $score))))
      (f64.store (i32.mul (local.get $token) (i32.const 8)) (local.get $total))
      (local.set $token (i32.add (local.get $token) (i32.const 1)))
      (br_if $distribution (i32.lt_u (local.get $token) (local.get $size))))
    (local.set $target (f64.mul (local.get $random) (local.get $total)))
    (local.set $token (i32.const 0))
    (loop $find
      (if (f64.lt (local.get $target) (f64.load (i32.mul (local.get $token) (i32.const 8))))
        (then (return (local.get $token))))
      (local.set $token (i32.add (local.get $token) (i32.const 1)))
      (br_if $find (i32.lt_u (local.get $token) (local.get $size))))
    (i32.sub (local.get $size) (i32.const 1)))
)
