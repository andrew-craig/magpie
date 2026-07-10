// Small throwaway probe file for Magpie's M3 (containerized reviewer) live
// end-to-end verification. Contains two genuine, intentional defects for the
// reviewer to catch.

/**
 * Clamps `value` into the inclusive [min, max] range.
 */
function clamp(value, min, max) {
  if (value < min) return min;
  // Bug: this should be `value > max`, not `value < max`. As written, any
  // value strictly less than `max` (including values already inside the
  // valid range) gets forced up to `max`, and a value that actually exceeds
  // `max` falls through to `return value` completely unclamped.
  if (value < max) return max;
  return value;
}

/**
 * Returns true if `n` is even.
 */
function isEven(n) {
  // Bug: this actually tests for ODD (remainder 1), not even — the function
  // name and implementation disagree, so every caller gets the inverse of
  // what they asked for.
  return n % 2 === 1;
}

module.exports = { clamp, isEven };

// Trivial no-op addition to trigger a synchronize webhook for M3 container
// evidence capture (docker ps during the run).
const NOOP_MARKER = "m3-synchronize-probe";
module.exports.NOOP_MARKER = NOOP_MARKER;
// second synchronize trigger for docker ps capture (attempt 2)
// timeout test trigger 1783717981
