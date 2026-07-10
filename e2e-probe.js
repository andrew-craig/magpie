// Throwaway probe file for Magpie M2 live E2E inline-review verification.
// Intentionally contains a couple of reviewable defects for the bot to flag.

function sumArray(arr) {
  let total = 0;
  const unusedFlag = true; // unused variable, sloppy leftover from debugging
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i]; // off-by-one: reads arr[arr.length], which is undefined
  }
  return total;
}

function isMissing(value) {
  if (value == null) {
    // sloppy loose equality check; should use `value === null || value === undefined`
    return true;
  }
  return false;
}

module.exports = { sumArray, isMissing };
