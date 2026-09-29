import assert from "node:assert/strict";
import { test } from "node:test";
import { AnnotationImageKind, AnnotationStatus, TaskStatus, create, AnnotationSchema, TaskSchema } from "@coflux/protocol";

import { agentTerminals, annotationsMarkdown, dataUrlToImage, groupByPage, pageKey, pendingCount, pinsForPage } from "./browser-annotations";

function annotation(init: { annotationId: string; number: number; pageUrl: string; [field: string]: unknown }) {
  return create(AnnotationSchema, { status: AnnotationStatus.PENDING, comment: "c", ...init } as never);
}

test("page key ignores query, hash and a trailing slash", () => {
  assert.equal(pageKey("http://localhost:3000/settings/?tab=1#x"), "http://localhost:3000/settings");
  assert.equal(pageKey("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(pageKey("not a url"), "not a url");
});

test("grouping and pins follow the page", () => {
  const list = [
    annotation({ annotationId: "a2", number: 2, pageUrl: "http://x/a" }),
    annotation({ annotationId: "a1", number: 1, pageUrl: "http://x/a?q=1", status: AnnotationStatus.RESOLVED, element: { tag: "button", selector: "#s" } }),
    annotation({ annotationId: "b1", number: 3, pageUrl: "http://x/b" }),
  ];
  const groups = groupByPage(list);
  assert.deepEqual(groups.map((group) => group.annotations.map((item) => item.annotationId)), [["a1", "a2"], ["b1"]]);
  const pins = pinsForPage(list, "http://x/a#top");
  assert.deepEqual(pins.map((pin) => [pin.id, pin.resolved]), [["a2", false], ["a1", true]]);
  assert.equal(pins[1]!.selector, "#s");
  assert.equal(pendingCount(undefined, list), 2);
  assert.equal(pendingCount({ pending: 5 }, list), 5);
});

test("agent terminals are running terminals of the workspace with an agent", () => {
  const tasks = [
    create(TaskSchema, { id: "t1", workspaceId: "w", status: TaskStatus.RUNNING, sessionId: "s1", title: "claude" }),
    create(TaskSchema, { id: "t2", workspaceId: "w", status: TaskStatus.RUNNING, sessionId: "s2", title: "shell" }),
    create(TaskSchema, { id: "t3", workspaceId: "other", status: TaskStatus.RUNNING, sessionId: "s3", title: "codex" }),
  ];
  const agents = {
    s1: { daemonId: "d", taskId: "t1", agent: "claude", state: "", message: "", progress: "", agentSessionId: "" },
    s3: { daemonId: "d", taskId: "t3", agent: "codex", state: "", message: "", progress: "", agentSessionId: "" },
  };
  assert.deepEqual(agentTerminals(tasks, agents, "w"), [{ taskId: "t1", title: "claude", agent: "claude" }]);
});

test("markdown carries comment, source, element and image paths", () => {
  const markdown = annotationsMarkdown(
    [
      annotation({
        annotationId: "ann-1",
        number: 1,
        pageUrl: "http://localhost:3000/",
        pageTitle: "Home",
        comment: "Make it blue",
        source: { framework: "react", components: ["Save", "Toolbar"], file: "src/Save.tsx", line: 4, column: 2 },
        element: { tag: "button", elementId: "save", selector: "#save", text: "Save", styles: { color: "red" } },
        images: [{ imageId: "i", kind: AnnotationImageKind.SCREENSHOT, path: "/h/i.png" }],
      }),
    ],
    "coflux:workspace:abcd1234",
  );
  for (const phrase of [
    "# Browser annotations · coflux:workspace:abcd1234",
    "## Home — http://localhost:3000/",
    "### #1 · `ann-1`",
    "> Make it blue",
    "Components (innermost first, react): Save < Toolbar",
    "Source: `src/Save.tsx:4:2`",
    'Element: `<button id="save">` with text "Save"',
    "Computed styles: `color: red`",
    "Screenshot of the current state: /h/i.png",
  ]) {
    assert.ok(markdown.includes(phrase), `missing ${phrase}\n${markdown}`);
  }
});

test("data URLs decode to bytes", () => {
  const image = dataUrlToImage("data:image/png;base64,AQID");
  assert.equal(image?.mimeType, "image/png");
  assert.deepEqual([...image!.data], [1, 2, 3]);
  assert.equal(dataUrlToImage("data:text/html;base64,AAAA"), null);
});
