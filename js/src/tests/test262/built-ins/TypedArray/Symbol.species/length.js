// Copyright (C) 2015 André Bargull. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
es6id: 22.2.2.4
description: >
  get %TypedArray% [ @@species ].length is 0.
info: |
  get %TypedArray% [ @@species ]

  17 ECMAScript Standard Built-in Objects:
    Every built-in Function object, including constructors, has a length
    property whose value is an integer. Unless otherwise specified, this
    value is equal to the largest number of named arguments shown in the
    subclause headings for the function description, including optional
    parameters. However, rest parameters shown using the form “...name”
    are not included in the default argument count.

    Unless otherwise specified, the length property of a built-in Function
    object has the attributes { [[Writable]]: false, [[Enumerable]]: false,
    [[Configurable]]: true }.
includes: [propertyHelper.js, testTypedArray.js]
features: [Symbol.species]
---*/

var desc = Object.getOwnPropertyDescriptor(TypedArray, Symbol.species);

verifyProperty(desc.get, "length", {
  value: 0,
  writable: false,
  enumerable: false,
  configurable: true
});

reportCompare(0, 0);
