#!/usr/bin/env node
// The skills in the Claude plugin delivery directory (integrations/claude-plugin, collected by the
// myWsq/plugins marketplace at a pinned commit SHA) are copies of packages/cli/skills, the single
// source shipped in the npm package and embedded in the coflux binary. The marketplace contract
// forbids symlinks, so this script mirrors the whole source tree into the plugin's skills/ directory;
// CI runs it with --check so the two never drift. The source tree is authoritative: --check fails on
// a missing, extra or differing file.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "packages/cli/skills");
const target = join(root, "integrations/claude-plugin/skills");

/** Relative paths of every regular file under `dir`, sorted; an absent directory has none. */
function files(dir, prefix = "") {
  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Anything that is not a directory counts as a file, so a stray symlink is reported too.
      return entry.isDirectory() ? files(dir, path) : [path];
    })
    .sort();
}

const sourceFiles = files(source);
const targetFiles = files(target);
const sourceSet = new Set(sourceFiles);
const targetSet = new Set(targetFiles);

if (process.argv.includes("--check")) {
  const problems = [
    ...sourceFiles.filter((path) => !targetSet.has(path)).map((path) => `missing: ${path}`),
    ...targetFiles.filter((path) => !sourceSet.has(path)).map((path) => `extra: ${path}`),
    ...sourceFiles
      .filter((path) => targetSet.has(path))
      .filter((path) => !readFileSync(join(source, path)).equals(readFileSync(join(target, path))))
      .map((path) => `differs: ${path}`),
  ];
  if (problems.length > 0) {
    console.error("integrations/claude-plugin/skills does not mirror packages/cli/skills:");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Run node scripts/sync-claude-plugin.mjs");
    process.exit(1);
  }
  console.log(`claude-plugin skills mirror packages/cli/skills (${sourceFiles.length} files)`);
} else {
  for (const path of targetFiles.filter((path) => !sourceSet.has(path))) {
    rmSync(join(target, path));
  }
  for (const path of sourceFiles) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(source, path), join(target, path));
  }
  console.log(`Synced ${sourceFiles.length} skill files to integrations/claude-plugin/skills`);
}
