// Which pad the host builds for the one in hand, across the three ways browsers name a pad.

import { test } from "node:test";
import assert from "node:assert/strict";
import { padKind } from "./input.ts";

test("a pad is built as the kind in hand", () => {
  // Chromium: name, then vendor and product.
  assert.equal(padKind("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"), 2);
  assert.equal(padKind("DualSense Edge Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0df2)"), 7);
  assert.equal(padKind("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"), 3);
  assert.equal(padKind("Xbox 360 Controller (XInput STANDARD GAMEPAD)"), 1);
  // Firefox: vendor-product-name.
  assert.equal(padKind("54c-9cc-Wireless Controller"), 4);
  assert.equal(padKind("57e-2009-Pro Controller"), 8);
  assert.equal(padKind("28de-1205-Steam Deck"), 6);
  // Safari: the name alone.
  assert.equal(padKind("DUALSHOCK 4 Wireless Controller"), 4);
  assert.equal(padKind("Xbox Wireless Controller"), 3);
  // Anything else: Xbox 360, which every game reads.
  assert.equal(padKind("8BitDo SN30 Pro (STANDARD GAMEPAD Vendor: 2dc8 Product: 6101)"), 1);
});
