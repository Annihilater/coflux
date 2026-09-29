import assert from "node:assert/strict";
import { test } from "node:test";

import {
  annotatorStateNeedsPage,
  elementCropFraction,
  parsePageMessage,
  sanitizeAnnotatorSync,
  sanitizeSourceIdentity,
} from "./browser-annotator-policy";

test("annotator sync: ids and pins are validated, unknown anchors dropped", () => {
  const parsed = sanitizeAnnotatorSync({
    guestId: 7,
    state: {
      mode: true,
      pins: [
        { id: "ann-1", number: 2, resolved: true, selector: "#a", domPath: "html > body", tag: "BUTTON", text: "Save", elementId: "a", classes: ["x", 3] },
        { id: "../bad", number: 1 },
        { id: "ann-2" },
      ],
      anchor: { kind: "pin", id: "ann-1", scroll: true },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.guestId, 7);
  assert.equal(parsed.state.pins.length, 1);
  assert.equal(parsed.state.pins[0]!.tag, "button");
  assert.deepEqual(parsed.state.pins[0]!.classes, ["x"]);
  assert.deepEqual(parsed.state.anchor, { kind: "pin", id: "ann-1", scroll: true });
  assert.equal(sanitizeAnnotatorSync({ guestId: -1, state: {} }), null);
  assert.equal(sanitizeAnnotatorSync({ guestId: 1, state: { anchor: { kind: "pick", token: "a b" } } })?.state.anchor, null);
  assert.equal(annotatorStateNeedsPage({ mode: false, pins: [], anchor: null }), false);
});

test("page messages: only known shapes pass", () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: "exit" })), { type: "exit" });
  assert.equal(parsePageMessage("{"), null);
  assert.equal(parsePageMessage(JSON.stringify({ type: "eval", code: "x" })), null);
  const pick = parsePageMessage(
    JSON.stringify({
      type: "pick",
      token: "p1",
      url: "http://localhost:3000/",
      title: "Home",
      rect: { x: 10, y: 20, width: 30, height: 40 },
      viewport: { width: 800, height: 600 },
      element: { tag: "DIV", selector: "div", attributes: { role: "button" }, styles: { color: "red" }, width: 30, height: 40 },
    }),
  );
  assert.equal(pick?.type, "pick");
  assert.equal(parsePageMessage(JSON.stringify({ type: "pin-click", id: "x/y" })), null);
});

test("source identity: empty is null, location only with a file", () => {
  assert.equal(sanitizeSourceIdentity({ framework: "", components: [], file: "" }), null);
  assert.deepEqual(sanitizeSourceIdentity({ framework: "React", components: ["Button", "Toolbar"], file: "", line: 3 }), {
    framework: "react",
    components: ["Button", "Toolbar"],
    file: "",
    line: 0,
    column: 0,
  });
});

test("element crop: padded, clipped to the viewport, null when off screen", () => {
  const crop = elementCropFraction({ x: 0, y: 100, width: 200, height: 100 }, { width: 1000, height: 500 }, 10);
  assert.deepEqual(crop, { x: 0, y: 90 / 500, width: 210 / 1000, height: 120 / 500 });
  assert.equal(elementCropFraction({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1000, height: 500 }), null);
});
