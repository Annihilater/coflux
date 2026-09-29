#!/usr/bin/env node
// Publishes a stable release to the R2 download mirror at dl.coflux.dev (plan 20260930-r2-download-mirror).
// release.yml runs it in two phases:
//
//   upload  node scripts/release-mirror.mjs upload <tag> <github-release-exists: true|false> <file>...
//           Before the GitHub Release exists: puts the release assets under releases/<tag>/ (the .dmg is
//           dropped; the mirror serves the DMG only under its alias). If the GitHub Release is already
//           published, nothing is written unless every object is byte-identical, which then is a no-op.
//   point   node scripts/release-mirror.mjs point <tag> <latest-mac.yml> <dmg>
//           After the GitHub Release succeeded: writes the DMG alias, desktop/latest-mac.yml and
//           releases/latest.json, reads latest.json back, and deletes every other releases/<tag>/ prefix.
//
// Credentials come from the release-signing environment: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
// (secrets), R2_ENDPOINT and R2_BUCKET (variables). Object I/O goes through the aws CLI against the
// R2 S3 endpoint. Every decision (what to write, what to refuse, what to prune) is in pure functions
// below, tested by scripts/release-mirror.test.mjs against an in-memory store.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderDesktopFeed } from "./desktop-update-feed.mjs";
import { compareSemver, parseStrictSemver } from "./npm-publish-guard.mjs";
import {
  DESKTOP_DMG_ALIAS_KEY,
  DESKTOP_FEED_KEY,
  LATEST_POINTER_KEY,
  RELEASES_PREFIX,
  isStableTag,
  releaseKey,
} from "./release-mirror-layout.mjs";

// Versioned objects never change once published, so the edge may keep them for good. The pointers
// and the DMG alias move with every release and must go stale within minutes. Cloudflare only
// caches extension-less binaries, .sig, .json and .yml because of the hostname Cache Rule that
// makes dl.coflux.dev honour these origin headers.
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const POINTER_CACHE_CONTROL = "public, max-age=60";
export const DMG_ALIAS_CACHE_CONTROL = "public, max-age=300";

/** Object metadata key holding the sha256 of the bytes, written with every put (the overwrite gate reads it). */
export const SHA256_METADATA = "sha256";

export const R2_ENV = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET"];

export function contentTypeFor(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".yml")) return "text/yaml; charset=utf-8";
  if (name.endsWith(".txt") || name === "SHA256SUMS") return "text/plain; charset=utf-8";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  return "application/octet-stream";
}

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function requireStableTag(tag) {
  if (!isStableTag(tag)) throw new Error(`prerelease ${tag} is never published to the download mirror`);
}

/**
 * The mirror upload set: the GitHub Release asset files minus the .dmg, which the mirror serves only
 * under its version-less alias. Asset names must be unique and the set must hold what clients read.
 */
export function selectUploadFiles(paths) {
  const selected = paths.filter((path) => !path.endsWith(".dmg"));
  const names = selected.map((path) => basename(path));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`release asset name appears twice: ${duplicate}`);
  for (const required of ["manifest.json", "SHA256SUMS", "latest-mac.yml"]) {
    if (!names.includes(required)) throw new Error(`release upload set is missing ${required}`);
  }
  if (!names.some((name) => name.endsWith(".zip"))) throw new Error("release upload set is missing the desktop .zip");
  return selected;
}

/**
 * Phase 1. Never overwrites a published tag: the server and `cofluxd --version` consume versioned
 * objects without looking at pointers, so once the GitHub Release exists the bytes behind its manifest
 * must not change. Before that, a full re-run legitimately rebuilds different bytes and may overwrite.
 * Byte identity is the sha256 each put records in the object's metadata alongside the bytes; an object
 * without it counts as different.
 */
export function uploadRelease({ tag, files, releaseExists, store }) {
  requireStableTag(tag);
  if (typeof releaseExists !== "boolean") throw new Error("releaseExists must be decided before any upload");
  const entries = selectUploadFiles(files).map((file) => {
    const name = basename(file);
    return { file, key: releaseKey(tag, name), name, sha256: sha256Hex(readFileSync(file)) };
  });
  if (releaseExists) {
    const differing = entries.filter((entry) => store.head(entry.key)?.sha256 !== entry.sha256).map((entry) => entry.key);
    if (differing.length) {
      throw new Error(
        `GitHub Release ${tag} is already published; refusing to overwrite its mirror objects, ` +
        `which differ or are missing: ${differing.join(", ")}`,
      );
    }
    return { uploaded: [], unchanged: entries.map((entry) => entry.key) };
  }
  for (const entry of entries) {
    store.put(entry.key, entry.file, {
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: contentTypeFor(entry.name),
      sha256: entry.sha256,
    });
  }
  return { uploaded: entries.map((entry) => entry.key), unchanged: [] };
}

/** The tag named by a latest.json body; throws on anything malformed. */
export function parseLatestPointer(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("releases/latest.json is not valid JSON"); }
  const tag = value?.version;
  if (typeof tag !== "string" || !tag.startsWith("v")) throw new Error("releases/latest.json has no v* version");
  parseStrictSemver(tag.slice(1), "releases/latest.json version");
  return tag;
}

/** latest.json for `tag`, refusing to move the pointer to a lower version than `previous` names. */
export function renderLatestPointer(tag, previous) {
  requireStableTag(tag);
  if (previous !== undefined) {
    const previousTag = parseLatestPointer(previous);
    const order = compareSemver(parseStrictSemver(tag.slice(1)), parseStrictSemver(previousTag.slice(1)));
    if (order < 0) throw new Error(`refusing to move releases/latest.json back from ${previousTag} to ${tag}`);
    if (order === 0 && previousTag !== tag) throw new Error(`releases/latest.json names ${previousTag}, another build of ${tag}`);
  }
  return `${JSON.stringify({ version: tag })}\n`;
}

function tagOfPrefix(prefix) {
  const match = /^releases\/(v[^/]+)\/$/.exec(prefix);
  if (!match) return undefined;
  try {
    parseStrictSemver(match[1].slice(1));
    return match[1];
  } catch {
    return undefined;
  }
}

/**
 * Which `releases/<tag>/` prefixes to delete. Pure: `prefixes` is the listing under `releases/`,
 * `confirmedTag` is what latest.json said when read back, `expectedTag` is the tag just published.
 * Returns nothing unless the read-back names the expected tag and the listing contains its prefix,
 * never returns that prefix, and ignores anything that is not a release tag prefix.
 */
export function selectPrunablePrefixes(prefixes, confirmedTag, expectedTag) {
  if (typeof confirmedTag !== "string" || confirmedTag !== expectedTag) return [];
  const keep = `${RELEASES_PREFIX}${confirmedTag}/`;
  if (!prefixes.includes(keep)) return [];
  return prefixes.filter((prefix) => prefix !== keep && tagOfPrefix(prefix) !== undefined);
}

/**
 * Phase 2. Runs only after the GitHub Release succeeded, and only for stable tags. Every refusal
 * happens before the first write; the prune happens only after latest.json reads back as `tag`.
 */
export function advancePointers({ tag, feedSource, dmgFile, store }) {
  requireStableTag(tag);
  const dmgName = `coflux-${tag.slice(1)}-arm64.dmg`;
  if (basename(dmgFile) !== dmgName) throw new Error(`expected the DMG ${dmgName}, got ${basename(dmgFile)}`);
  if (!store.head(releaseKey(tag, "manifest.json"))) {
    throw new Error(`${releaseKey(tag, "manifest.json")} is missing: the upload job has not mirrored ${tag}`);
  }
  // A plain 404 means "no previous pointer"; any other read failure throws from the store.
  const latest = renderLatestPointer(tag, store.get(LATEST_POINTER_KEY));
  const feed = renderDesktopFeed(tag, feedSource, store.get(DESKTOP_FEED_KEY));

  // Uploaded fresh with its own short Cache-Control: a server-side copy of the versioned object
  // would keep that object's immutable metadata.
  store.put(DESKTOP_DMG_ALIAS_KEY, dmgFile, {
    cacheControl: DMG_ALIAS_CACHE_CONTROL,
    contentType: contentTypeFor(dmgName),
    sha256: sha256Hex(readFileSync(dmgFile)),
  });
  store.putText(DESKTOP_FEED_KEY, feed, { cacheControl: POINTER_CACHE_CONTROL, contentType: contentTypeFor(DESKTOP_FEED_KEY) });
  store.putText(LATEST_POINTER_KEY, latest, { cacheControl: POINTER_CACHE_CONTROL, contentType: contentTypeFor(LATEST_POINTER_KEY) });

  const readBack = store.get(LATEST_POINTER_KEY);
  const confirmed = readBack === undefined ? undefined : parseLatestPointer(readBack);
  if (confirmed !== tag) {
    throw new Error(`releases/latest.json reads back as ${confirmed ?? "<missing>"}, not ${tag}; nothing is pruned`);
  }
  const pruned = selectPrunablePrefixes(store.listPrefixes(RELEASES_PREFIX), confirmed, tag);
  for (const prefix of pruned) store.removePrefix(prefix);
  return { pruned };
}

// ---------------------------------------------------------------------------------------------
// The aws CLI store. `run(args)` returns { status, stdout, stderr } and is injectable for tests.

export function readR2Env(env = process.env) {
  const missing = R2_ENV.filter((name) => !env[name]);
  if (missing.length) throw new Error(`release-signing environment is missing ${missing.join(", ")}`);
  if (!/^https:\/\//.test(env.R2_ENDPOINT)) throw new Error("R2_ENDPOINT must be the https S3 endpoint of the account");
  return {
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT,
    awsEnv: {
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      AWS_DEFAULT_REGION: "auto",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
    },
  };
}

export function awsRunner(awsEnv) {
  return (args) => {
    const result = spawnSync("aws", args, {
      encoding: "utf8",
      env: { ...process.env, ...awsEnv },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

const NOT_FOUND = /\((?:NoSuchKey|404|NotFound)\)/;

export function createAwsStore({ bucket, endpoint, run }) {
  const common = ["--endpoint-url", endpoint];
  const fail = (what, result) => {
    throw new Error(`${what} failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  };
  const assertKey = (key) => {
    if (typeof key !== "string" || !key || key.startsWith("/") || key.includes("..")) throw new Error(`invalid object key: ${key}`);
  };
  const put = (key, file, { cacheControl, contentType, sha256 }) => {
    assertKey(key);
    const result = run([
      "s3", "cp", file, `s3://${bucket}/${key}`, ...common,
      "--no-progress", "--only-show-errors",
      "--cache-control", cacheControl,
      "--content-type", contentType,
      "--metadata", `${SHA256_METADATA}=${sha256}`,
    ]);
    if (result.status !== 0) fail(`upload ${key}`, result);
  };
  return {
    /** Object text, or undefined on a plain 404; any other failure throws. */
    get(key) {
      assertKey(key);
      const dir = mkdtempSync(join(tmpdir(), "coflux-mirror-get-"));
      try {
        const out = join(dir, "object");
        const result = run(["s3api", "get-object", "--bucket", bucket, "--key", key, ...common, out]);
        if (result.status !== 0) {
          if (NOT_FOUND.test(result.stderr)) return undefined;
          fail(`read ${key}`, result);
        }
        return readFileSync(out, "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    /** { sha256 } from the object's metadata, or undefined on a plain 404; any other failure throws. */
    head(key) {
      assertKey(key);
      const result = run(["s3api", "head-object", "--bucket", bucket, "--key", key, ...common, "--output", "json"]);
      if (result.status !== 0) {
        if (NOT_FOUND.test(result.stderr)) return undefined;
        fail(`head ${key}`, result);
      }
      const metadata = JSON.parse(result.stdout || "{}").Metadata ?? {};
      return { sha256: metadata[SHA256_METADATA] };
    },
    put,
    putText(key, text, { cacheControl, contentType }) {
      const dir = mkdtempSync(join(tmpdir(), "coflux-mirror-put-"));
      try {
        const file = join(dir, "object");
        writeFileSync(file, text);
        put(key, file, { cacheControl, contentType, sha256: sha256Hex(Buffer.from(text)) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    /** The immediate sub-prefixes of `prefix` (for `releases/`: one `releases/<tag>/` per release). */
    listPrefixes(prefix) {
      const result = run([
        "s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix, "--delimiter", "/", ...common, "--output", "json",
      ]);
      if (result.status !== 0) fail(`list ${prefix}`, result);
      if (!result.stdout.trim()) return [];
      const listing = JSON.parse(result.stdout);
      return (listing.CommonPrefixes ?? []).map((entry) => entry.Prefix).filter((value) => typeof value === "string");
    },
    removePrefix(prefix) {
      if (tagOfPrefix(prefix) === undefined) throw new Error(`refusing to delete a non-release prefix: ${prefix}`);
      const result = run(["s3", "rm", `s3://${bucket}/${prefix}`, "--recursive", ...common, "--only-show-errors"]);
      if (result.status !== 0) fail(`delete ${prefix}`, result);
    },
  };
}

function main(argv) {
  const [command, tag, ...rest] = argv;
  const r2 = readR2Env();
  const store = createAwsStore({ bucket: r2.bucket, endpoint: r2.endpoint, run: awsRunner(r2.awsEnv) });
  if (command === "upload") {
    const [exists, ...files] = rest;
    if (exists !== "true" && exists !== "false") throw new Error("upload needs <github-release-exists: true|false>");
    const result = uploadRelease({ tag, files, releaseExists: exists === "true", store });
    if (result.uploaded.length) console.log(`mirrored ${result.uploaded.length} objects under releases/${tag}/`);
    else console.log(`GitHub Release ${tag} is published and its ${result.unchanged.length} mirror objects are identical; nothing to do`);
    return;
  }
  if (command === "point") {
    const [feedFile, dmgFile] = rest;
    if (!feedFile || !dmgFile) throw new Error("point needs <latest-mac.yml> <dmg>");
    const { pruned } = advancePointers({ tag, feedSource: readFileSync(feedFile, "utf8"), dmgFile, store });
    console.log(`releases/latest.json, ${DESKTOP_FEED_KEY} and ${DESKTOP_DMG_ALIAS_KEY} now point at ${tag}`);
    console.log(pruned.length ? `pruned ${pruned.join(", ")}` : "nothing to prune");
    return;
  }
  throw new Error("usage: release-mirror.mjs upload <tag> <true|false> <file>... | point <tag> <latest-mac.yml> <dmg>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
