// Renders the stable desktop update feed. Both feeds use it: the `desktop-updates` branch that installed
// apps read, and `desktop/latest-mac.yml` on the R2 mirror that newer builds read. Either way the zip
// URL is the absolute R2 mirror URL of this release, and an old run can never roll a feed back.
//   Usage: node scripts/desktop-update-feed.mjs <tag> <latest-mac.yml> [previous feed]
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictSemver, compareSemver } from "./npm-publish-guard.mjs";
import { mirrorAssetUrl } from "./release-mirror-layout.mjs";

function manifestVersion(text) {
  const matches = [...text.matchAll(/^version: ['"]?([^\s'"]+)['"]?\s*$/gm)];
  if (matches.length !== 1) throw new Error("桌面更新清单缺少唯一 version");
  return parseStrictSemver(matches[0][1]);
}

export function renderDesktopFeed(tag, source, previous) {
  if (!tag.startsWith("v")) throw new Error("更新源只接受统一 v* tag");
  const version = parseStrictSemver(tag.slice(1));
  if (version.prerelease.length || tag.includes("+")) throw new Error("预发布版本不能覆盖稳定更新源");
  if (manifestVersion(source).raw !== version.raw) throw new Error("桌面清单版本与 tag 不一致");
  const asset = `coflux-${version.raw}-arm64.zip`;
  const destination = mirrorAssetUrl(tag, asset);
  let count = 0;
  const rendered = source.replace(/^(\s*-?\s*(?:url|path): )([^\r\n]+)$/gm, (_line, prefix, value) => {
    if (value !== asset) throw new Error("桌面清单包含非本次发布的产物地址");
    count++;
    return prefix + destination;
  });
  if (count < 2) throw new Error("桌面清单缺少产物地址");
  if (previous !== undefined) {
    const order = compareSemver(version, manifestVersion(previous));
    if (order < 0) throw new Error("拒绝旧发布覆盖较新的桌面更新源");
    if (order === 0 && previous !== rendered) throw new Error("同版本更新清单内容漂移");
  }
  return rendered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [tag, source, previous] = process.argv.slice(2);
    process.stdout.write(renderDesktopFeed(tag, readFileSync(source, "utf8"), previous && existsSync(previous) ? readFileSync(previous, "utf8") : undefined));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
