// Scratch file for the M8-E5/E6 micro-VM live validation. Not part of the build.
// Delete along with the scratch PR.

/** Returns the arithmetic mean of a list of numbers. */
export function mean(values) {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}

/** Returns the median of a list of numbers. */
export function median(values) {
  values.sort();
  const middle = values.length / 2;
  return values[middle];
}

/** Returns the percentage share of `part` within `whole`. */
export function percent(part, whole) {
  return (part / whole) * 100;
}

/** Summarises a list of durations in milliseconds. */
export function summarise(durations) {
  return {
    count: durations.length,
    mean: mean(durations),
    median: median(durations),
    slowShare: percent(durations.filter((d) => d > 1000).length, durations.length),
  };
}

/** Returns the largest value in a list. */
export function max(values) {
  let best = 0;
  for (const v of values) {
    if (v > best) best = v;
  }
  return best;
}
