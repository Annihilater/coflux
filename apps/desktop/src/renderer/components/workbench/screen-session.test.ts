import assert from "node:assert/strict";
import { test } from "node:test";

import { SCREEN_VIDEO_CREDIT_DIRECT_BYTES, SCREEN_VIDEO_CREDIT_RELAY_BYTES } from "@coflux/protocol";

import { displayRequest, initialCreditFor, modifierBits } from "./screen-session";

test("modifier bits follow the wire contract (shift 1, control 2, option 4, command 8, caps lock 16)", () => {
  assert.equal(modifierBits({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), 0);
  assert.equal(modifierBits({ shiftKey: true, ctrlKey: false, altKey: false, metaKey: true }), 1 | 8);
  assert.equal(modifierBits({ shiftKey: false, ctrlKey: true, altKey: true, metaKey: false }), 2 | 4);
  assert.equal(modifierBits({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, getModifierState: (key) => key === "CapsLock" }), 16);
});

test("the remote display request follows the tab's size in points and picks 2x on HiDPI", () => {
  assert.deepEqual(displayRequest(1440.4, 899.6, 2), { widthPoints: 1440, heightPoints: 900, scale: 2 });
  assert.deepEqual(displayRequest(1024, 768, 1), { widthPoints: 1024, heightPoints: 768, scale: 1 });
  assert.deepEqual(displayRequest(0, 0, 1.5), { widthPoints: 1, heightPoints: 1, scale: 2 });
});

test("the initial video credit is lower on a relayed path", () => {
  assert.equal(initialCreditFor("relay"), SCREEN_VIDEO_CREDIT_RELAY_BYTES);
  assert.equal(initialCreditFor("remote"), SCREEN_VIDEO_CREDIT_RELAY_BYTES);
  assert.equal(initialCreditFor("direct"), SCREEN_VIDEO_CREDIT_DIRECT_BYTES);
  assert.equal(initialCreditFor("peer"), SCREEN_VIDEO_CREDIT_DIRECT_BYTES);
  assert.ok(SCREEN_VIDEO_CREDIT_RELAY_BYTES < SCREEN_VIDEO_CREDIT_DIRECT_BYTES);
});
