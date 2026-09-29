// Object layout of the R2 download mirror at dl.coflux.dev (plan 20260930-r2-download-mirror).
//
// Installed clients hard-code parts of this layout: every stable manifest carries
// `<origin>/releases/<tag>/<asset>` URLs, desktop builds read `<origin>/desktop/latest-mac.yml`, cofluxd
// reads `<origin>/releases/latest.json`, and the add-device page links the DMG alias. Changing any
// name here needs a migration, not an edit. The mirror holds only the latest stable release; every
// older release and every prerelease is served by GitHub Releases.
import { parseStrictSemver } from "./npm-publish-guard.mjs";

export const MIRROR_ORIGIN = "https://dl.coflux.dev";
export const RELEASES_PREFIX = "releases/";
export const LATEST_POINTER_KEY = `${RELEASES_PREFIX}latest.json`;
export const DESKTOP_FEED_KEY = "desktop/latest-mac.yml";
export const DESKTOP_DMG_ALIAS_KEY = "desktop/coflux-arm64.dmg";

const ASSET_NAME = /^[A-Za-z0-9._+-]+$/;

/** Stable = a strict `v` SemVer tag without prerelease identifiers, the same rule as release.yml's metadata job. */
export function isStableTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) throw new Error(`release tag must be a v* tag: ${JSON.stringify(tag)}`);
  return parseStrictSemver(tag.slice(1), "release tag").prerelease.length === 0;
}

/** The mirror key of one GitHub Release asset of `tag`. */
export function releaseKey(tag, asset) {
  isStableTag(tag);
  if (!ASSET_NAME.test(asset) || asset === "." || asset === "..") throw new Error(`invalid release asset name: ${JSON.stringify(asset)}`);
  return `${RELEASES_PREFIX}${tag}/${asset}`;
}

export function mirrorUrl(key) {
  return `${MIRROR_ORIGIN}/${key}`;
}

export function mirrorAssetUrl(tag, asset) {
  return mirrorUrl(releaseKey(tag, asset));
}
