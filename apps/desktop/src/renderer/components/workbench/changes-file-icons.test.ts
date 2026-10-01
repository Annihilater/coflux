import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { fileIconName, folderIconName } from "./changes-file-icons";

/* Plan 20261001-changes-review-polish: VS Code's resolution order over the vendored Catppuccin tables. */

const iconExists = (name: string) => existsSync(new URL(`../../assets/file-icons/icons/${name}.svg`, import.meta.url));

test("well-known files resolve to their specific icons", () => {
  const expected: Record<string, string> = {
    "Cargo.toml": "cargo",
    "apps/desktop/package.json": "package-json",
    "tsconfig.json": "typescript-config",
    "pnpm-lock.yaml": "pnpm-lock",
    Dockerfile: "docker",
    ".gitignore": "git",
  };
  for (const [path, icon] of Object.entries(expected)) assert.equal(fileIconName(path), icon, path);
});

test("the longest compound extension wins, then the shorter one, then the default", () => {
  assert.equal(fileIconName("src/types.d.ts"), "typescript-def");
  assert.equal(fileIconName("src/view.test.ts"), "typescript-test");
  assert.equal(fileIconName("src/view.ts"), "typescript");
  assert.equal(fileIconName("crates/worker/src/changes.rs"), "rust");
  assert.equal(fileIconName("NOTES.unknownext"), "_file");
  assert.equal(fileIconName("Makefile"), "makefile");
});

test("local overrides fill names the set does not map", () => {
  assert.equal(fileIconName("AGENTS.md"), "readme");
  assert.equal(fileIconName("docs/CLAUDE.md"), "readme");
  assert.equal(folderIconName("wiki", false), "folder_docs");
  assert.equal(folderIconName("wiki", true), "folder_docs_open");
});

test("folders resolve by their last segment, open and closed separately", () => {
  assert.equal(folderIconName("src", false), "folder_src");
  assert.equal(folderIconName("src", true), "folder_src_open");
  assert.equal(folderIconName("apps/desktop/src", true), "folder_src_open");
  assert.equal(folderIconName(".github", false), "folder_github");
  assert.equal(folderIconName("some-folder", false), "_folder");
  assert.equal(folderIconName("some-folder", true), "_folder_open");
});

test("every icon the resolver can name is vendored", () => {
  for (const name of [
    fileIconName("x.ts"),
    fileIconName("AGENTS.md"),
    folderIconName("wiki", true),
    folderIconName("wiki", false),
    folderIconName("x", true),
    folderIconName("x", false),
    fileIconName("x"),
  ]) {
    assert.ok(iconExists(name), name);
  }
});
