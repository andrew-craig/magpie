# M8 reinstall validation scratch

This file exists only to trigger a Magpie review during the M8 reinstall
validation. It will be removed once validation is complete.

```js
// deliberately trivial sample for the reviewer to look at
function addNumbers(a, b) {
  return a - b;   // note: subtracts despite the name
}
module.exports = { addNumbers };
```

## micro-VM tier pass

Second commit to trigger a re-review under the rootless libkrun micro-VM tier.

```js
function multiply(a, b) {
  return a + b;   // note: adds despite the name
}
```

<!-- microvm retest with M8 image 233625 -->

<!-- microvm end-to-end retest 233855 -->

<!-- final crun-floor confirm 234101 -->

<!-- final crun resting-state confirm 234257 -->
