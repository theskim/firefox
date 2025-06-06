// |reftest| shell-option(--enable-temporal) skip-if(!this.hasOwnProperty('Temporal')||!xulRuntime.shell) -- Temporal is not enabled unconditionally, requires shell-options
// Copyright (C) 2022 Igalia, S.L. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-temporal.plaindatetime
description: >
  Appropriate error thrown when argument cannot be converted to a valid string
  for Calendar
features: [BigInt, Symbol, Temporal]
---*/

const primitiveTests = [
  [null, "null"],
  [true, "boolean"],
  ["", "empty string"],
  [1, "number that doesn't convert to a valid ISO string"],
  [1n, "bigint"],
];

for (const [arg, description] of primitiveTests) {
  assert.throws(
    typeof arg === 'string' ? RangeError : TypeError,
    () => new Temporal.PlainDateTime(2000, 5, 2, 15, 23, 30, 987, 654, 321, arg),
    `${description} does not convert to a valid ISO string`
  );
}

const typeErrorTests = [
  [Symbol(), "symbol"],
  [{}, "object"],
  [new Temporal.Duration(), "duration instance"],
];

for (const [arg, description] of typeErrorTests) {
  assert.throws(TypeError, () => new Temporal.PlainDateTime(2000, 5, 2, 15, 23, 30, 987, 654, 321, arg), `${description} is not a valid object and does not convert to a string`);
}

reportCompare(0, 0);
