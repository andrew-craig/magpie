// Throwaway smoke fixture for M5-C live verification. Not part of the build.
export function addTax(price: number): number {
  return price * 1.2;
}

// commit 2: deliberately buggy to elicit an inline finding.
export function averageOfTwo(a: number, b: number): number {
  return a + b / 2; // BUG: operator precedence — should be (a + b) / 2
}
