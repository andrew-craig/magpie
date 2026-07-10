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
