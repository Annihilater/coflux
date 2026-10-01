import assert from "node:assert/strict";
import { test } from "node:test";
import { AnnotationImageKind, AnnotationStatus, TaskStatus, create, AnnotationSchema, TaskSchema } from "@coflux/protocol";

import {
  agentTerminals,
  annotationCount,
  annotationMeta,
  annotationsMarkdown,
  annotationTitle,
  cardPlacement,
  codeAnnotations,
  dataUrlToImage,
  groupByPage,
  pageAnnotations,
  pageKey,
  pinsForPage,
} from "./browser-annotations";

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
    annotation({ annotationId: "a1", number: 1, pageUrl: "http://x/a?q=1", status: AnnotationStatus.RESOLVED, targets: [{ element: { tag: "button", selector: "#s" } }] }),
    annotation({ annotationId: "b1", number: 3, pageUrl: "http://x/b", targets: [{ element: { tag: "div" } }] }),
    annotation({ annotationId: "a3", number: 4, pageUrl: "http://x/a", targets: [{ element: { tag: "header" } }, { element: { tag: "img" } }], region: { x: 1, y: 2, width: 30, height: 40 } }),
  ];
  const groups = groupByPage(list);
  assert.deepEqual(groups.map((group) => group.annotations.map((item) => item.annotationId)), [["a1", "a2", "a3"], ["b1"]]);
  // An annotation without any element (never stored by the worker) has no pin.
  const pins = pinsForPage(list, "http://x/a#top");
  assert.deepEqual(pins.map((pin) => [pin.id, pin.resolved]), [["a1", true], ["a3", false]]);
  assert.equal(pins[0]!.targets[0]!.selector, "#s");
  assert.equal(pins[0]!.region, null);
  assert.equal(pins[1]!.targets.length, 2);
  assert.deepEqual(pins[1]!.region, { x: 1, y: 2, width: 30, height: 40 });
});

test("toolbar count: pending, else resolved with a check, else nothing", () => {
  const pending = annotation({ annotationId: "a", number: 1, pageUrl: "http://x/" });
  const resolved = annotation({ annotationId: "b", number: 2, pageUrl: "http://x/", status: AnnotationStatus.RESOLVED });
  assert.deepEqual(annotationCount(undefined, [pending, resolved]), { kind: "pending", count: 1 });
  assert.deepEqual(annotationCount(undefined, [resolved]), { kind: "resolved", count: 1 });
  // The loaded list wins over the summary (which also counts code comments); the summary is the
  // fallback before the first load.
  assert.deepEqual(annotationCount({ pending: 0, resolved: 3 }, [pending]), { kind: "pending", count: 1 });
  assert.deepEqual(annotationCount({ pending: 0, resolved: 3 }, null), { kind: "resolved", count: 3 });
  assert.equal(annotationCount({ pending: 0, resolved: 0 }, null), null);
  assert.equal(annotationCount(undefined, null), null);
});

test("the browser panel's lists and count ignore code comments", () => {
  const page = annotation({ annotationId: "a", number: 1, pageUrl: "http://x/", targets: [{ element: { tag: "button" } }] });
  const comment = annotation({ annotationId: "b", number: 2, pageUrl: "", code: { path: "src/a.ts", side: 2, startLine: 3, endLine: 3 } });
  const resolvedComment = annotation({
    annotationId: "c",
    number: 3,
    pageUrl: "",
    status: AnnotationStatus.RESOLVED,
    code: { path: "src/a.ts", side: 1, startLine: 1, endLine: 2 },
  });
  const all = [page, comment, resolvedComment];
  assert.deepEqual(pageAnnotations(all).map((item) => item.annotationId), ["a"]);
  assert.deepEqual(codeAnnotations(all).map((item) => item.annotationId), ["b", "c"]);
  // The summary counts every kind; once loaded, the badge counts page annotations only.
  assert.deepEqual(annotationCount({ pending: 2, resolved: 1 }, pageAnnotations(all)), { kind: "pending", count: 1 });
  assert.equal(annotationCount({ pending: 1, resolved: 1 }, pageAnnotations([comment, resolvedComment])), null);
  assert.equal(pinsForPage(all, "http://x/").length, 1);
});

test("titles and meta lines name the elements", () => {
  const button = { element: { tag: "button", classes: ["primary"] }, source: { components: ["Button", "Header", "App", "Root"] } };
  const card = { element: { tag: "div", classes: ["card"] }, source: null };
  const nav = { element: { tag: "nav", classes: [] }, source: { components: ["Nav"] } };
  assert.equal(annotationTitle([button], false), "Button ‹ Header ‹ App");
  assert.equal(annotationTitle([card], false), "div.card");
  assert.equal(annotationTitle([button, card, nav], false), "3 个元素 · Button、div.card、Nav");
  assert.equal(annotationTitle([button, card, nav, nav], false), "4 个元素 · Button、div.card、Nav…");
  assert.equal(annotationTitle([nav, button], true), "区域 · Nav");
  const single = annotation({ annotationId: "a", number: 1, pageUrl: "http://x/", targets: [{ element: { tag: "a" }, source: { components: ["Link", "Nav", "App"] } }] });
  const multi = annotation({ annotationId: "b", number: 2, pageUrl: "http://x/", targets: [{ element: { tag: "a" } }, { element: { tag: "b" } }] });
  const region = annotation({ annotationId: "c", number: 3, pageUrl: "http://x/", targets: [{ element: { tag: "a" } }], region: { width: 1, height: 1 } });
  assert.equal(annotationMeta(single), "Link ‹ Nav");
  assert.equal(annotationMeta(multi), "2 个元素");
  assert.equal(annotationMeta(region), "区域");
});

test("cards go below the anchor, else above, else the roomier side, always inside the area", () => {
  const area = { width: 800, height: 600 };
  const card = { width: 320, height: 150 };
  assert.deepEqual(cardPlacement({ x: 100, y: 100, width: 50, height: 20 }, card, area), { left: 100, top: 128 });
  assert.deepEqual(cardPlacement({ x: 100, y: 500, width: 50, height: 20 }, card, area), { left: 100, top: 342 });
  // Right edge: kept inside.
  assert.deepEqual(cardPlacement({ x: 700, y: 100, width: 50, height: 20 }, card, area), { left: 472, top: 128 });
  // Neither side fits a tall card: the roomier side, clamped to the area.
  assert.deepEqual(cardPlacement({ x: 10, y: 200, width: 50, height: 20 }, { width: 320, height: 500 }, area), { left: 10, top: 92 });
  assert.deepEqual(cardPlacement(null, card, area), { left: 472, top: 8 });
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
        targets: [
          {
            source: { framework: "react", components: ["Save", "Toolbar"], file: "src/Save.tsx", line: 4, column: 2 },
            element: { tag: "button", elementId: "save", selector: "#save", text: "Save", styles: { color: "red" } },
          },
        ],
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

test("markdown describes every element of a selection, and a region with its container and contents", () => {
  const markdown = annotationsMarkdown(
    [
      annotation({
        annotationId: "ann-2",
        number: 2,
        pageUrl: "http://localhost:3000/",
        comment: "Align these",
        targets: [
          { element: { tag: "button", selector: ".a" }, source: { components: ["Button", "Header"] } },
          { element: { tag: "div", classes: ["card"], selector: ".b" }, source: { components: ["Card"], file: "src/Card.tsx", line: 4 } },
        ],
      }),
      annotation({
        annotationId: "ann-3",
        number: 3,
        pageUrl: "http://localhost:3000/",
        comment: "Too crowded",
        targets: [
          { element: { tag: "header", selector: "header" }, source: { components: ["Header", "App"] } },
          { element: { tag: "img", selector: "#logo" }, source: { components: ["Logo"] } },
        ],
        region: { x: 12, y: 4.5, width: 320, height: 80 },
      }),
    ],
    "w",
  );
  for (const phrase of [
    "- Elements: 2 (the user selected them together; the comment applies to all of them)",
    "#### Element 1 of 2",
    "Components (innermost first): Button < Header",
    "#### Element 2 of 2",
    "Source: `src/Card.tsx:4`",
    "- Region: the user dragged a 320×80 px area on the page, 12 px right and 4.5 px down",
    "#### Container (the innermost element holding the region)",
    "Components (innermost first): Header < App",
    "#### Inside the region",
    "- Logo · `<img>` · selector `#logo`",
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
