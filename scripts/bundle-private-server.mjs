#!/usr/bin/env node
// Bundle the centre and the create-user command into single Node programs.
// The server has no compile step of its own; this is what a private deploy runs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) {
  console.error("用法: node scripts/bundle-private-server.mjs <输出目录>");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
function findEsbuild() {
  const base = join(root, "node_modules/.pnpm");
  const hits = readdirSync(base)
    .filter((name) => name.startsWith("esbuild@"))
    .map((name) => join(base, name, "node_modules/esbuild/bin/esbuild"))
    .filter((bin) => existsSync(bin));
  if (hits.length === 0) {
    console.error("找不到 esbuild。先在仓库根目录执行 pnpm install。");
    process.exit(1);
  }
  return hits.sort()[0];
}

const esbuild = findEsbuild();
const banner = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";
const common = [esbuild, "--bundle", "--platform=node", "--target=node22", "--format=esm", `--banner:js=${banner}`];

function build(entry, outfile) {
  const result = spawnSync(common[0], [...common.slice(1), entry, `--outfile=${outfile}`], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

build(join(root, "apps/server/src/index.ts"), join(out, "coflux-server.mjs"));
build(join(root, "scripts/create-user.mjs"), join(out, "create-user.mjs"));
console.log(`Bundled the centre into ${out}`);
