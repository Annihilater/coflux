import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DMG_ALIAS_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  POINTER_CACHE_CONTROL,
  advancePointers,
  createAwsStore,
  readR2Env,
  renderLatestPointer,
  selectPrunablePrefixes,
  selectUploadFiles,
  sha256Hex,
  uploadRelease,
} from "./release-mirror.mjs";
import {
  DESKTOP_DMG_ALIAS_KEY,
  DESKTOP_FEED_KEY,
  LATEST_POINTER_KEY,
  isStableTag,
  mirrorAssetUrl,
} from "./release-mirror-layout.mjs";

const TAG = "v0.35.0";
const TARGET = "x86_64-unknown-linux-musl";
const feedSource = (version) =>
  `version: ${version}\nfiles:\n  - url: coflux-${version}-arm64.zip\n    sha512: digest\npath: coflux-${version}-arm64.zip\nsha512: digest\n`;

/** In-memory stand-in for the aws CLI store, recording every write and delete. */
function memoryStore() {
  const objects = new Map();
  const writes = [];
  const removed = [];
  const store = {
    objects,
    writes,
    removed,
    get(key) {
      const object = objects.get(key);
      return object === undefined ? undefined : object.bytes.toString("utf8");
    },
    head(key) {
      const object = objects.get(key);
      return object === undefined ? undefined : { sha256: object.sha256 };
    },
    put(key, file, options) {
      writes.push(key);
      objects.set(key, { ...options, bytes: readFileSync(file) });
    },
    putText(key, text, options) {
      writes.push(key);
      objects.set(key, { ...options, bytes: Buffer.from(text), sha256: sha256Hex(Buffer.from(text)) });
    },
    listPrefixes(prefix) {
      const prefixes = new Set();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes("/")) prefixes.add(`${prefix}${rest.slice(0, rest.indexOf("/") + 1)}`);
      }
      return [...prefixes].sort();
    },
    removePrefix(prefix) {
      removed.push(prefix);
      for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
    },
  };
  return store;
}

function seed(store, key, text, extra = {}) {
  store.objects.set(key, { bytes: Buffer.from(text), sha256: sha256Hex(Buffer.from(text)), ...extra });
}

/** A release directory shaped like release.yml's asset globs, including the .dmg the mirror drops. */
function releaseFiles(version = "0.35.0") {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-mirror-"));
  const names = {
    "manifest.json": '{"version":"v' + version + '"}\n',
    SHA256SUMS: "sums\n",
    [`coflux-worker-${TARGET}`]: "worker bytes",
    [`coflux-worker-${TARGET}.release.sig`]: "sig",
    [`coflux-transport-NOTICES-${TARGET}.txt`]: "notices",
    [`coflux-${version}-arm64.zip`]: "zip bytes",
    [`coflux-${version}-arm64.zip.blockmap`]: "blockmap",
    "latest-mac.yml": feedSource(version),
    [`coflux-${version}-arm64.dmg`]: "dmg bytes",
  };
  for (const [name, text] of Object.entries(names)) writeFileSync(join(dir, name), text);
  return { dir, files: Object.keys(names).map((name) => join(dir, name)), dmg: join(dir, `coflux-${version}-arm64.dmg`) };
}

test("layout: stable tags only, one R2 URL shape", () => {
  assert.equal(isStableTag("v2.11.0"), true);
  assert.equal(isStableTag("v2.12.0-rc.1"), false);
  assert.throws(() => isStableTag("2.11.0"));
  assert.equal(mirrorAssetUrl("v2.11.0", "manifest.json"), "https://dl.coflux.dev/releases/v2.11.0/manifest.json");
  assert.throws(() => mirrorAssetUrl("v2.11.0", "../latest.json"));
});

test("upload: the release asset set minus the .dmg, immutable and hashed, under releases/<tag>/", () => {
  const { dir, files } = releaseFiles();
  try {
    const store = memoryStore();
    const result = uploadRelease({ tag: TAG, files, releaseExists: false, store });
    assert.equal(result.uploaded.length, files.length - 1);
    assert.ok(!store.writes.some((key) => key.endsWith(".dmg")), "the versioned .dmg is never mirrored");
    for (const key of store.writes) {
      assert.match(key, /^releases\/v0\.35\.0\/[^/]+$/);
      const object = store.objects.get(key);
      assert.equal(object.cacheControl, IMMUTABLE_CACHE_CONTROL);
      assert.equal(object.sha256, sha256Hex(object.bytes));
    }
    assert.equal(store.objects.get("releases/v0.35.0/manifest.json").contentType, "application/json");
    assert.equal(store.objects.get(`releases/v0.35.0/coflux-worker-${TARGET}`).contentType, "application/octet-stream");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: a published tag is never overwritten; identical bytes are a no-op", () => {
  const { dir, files } = releaseFiles();
  try {
    const store = memoryStore();
    uploadRelease({ tag: TAG, files, releaseExists: false, store });
    store.writes.length = 0;

    const same = uploadRelease({ tag: TAG, files, releaseExists: true, store });
    assert.deepEqual(same.uploaded, []);
    assert.equal(same.unchanged.length, files.length - 1);
    assert.deepEqual(store.writes, []);

    // A full re-run rebuilt one artifact after the GitHub Release already exists.
    writeFileSync(files[2], "rebuilt worker bytes");
    assert.throws(() => uploadRelease({ tag: TAG, files, releaseExists: true, store }), /already published.*coflux-worker/);
    assert.deepEqual(store.writes, []);

    // An object without its sha256 metadata counts as different, as does a missing one.
    const bare = memoryStore();
    assert.throws(() => uploadRelease({ tag: TAG, files, releaseExists: true, store: bare }), /refusing to overwrite/);
    assert.deepEqual(bare.writes, []);

    // Before the GitHub Release exists, a re-run may replace the bytes.
    uploadRelease({ tag: TAG, files, releaseExists: false, store });
    assert.equal(store.objects.get(`releases/v0.35.0/coflux-worker-${TARGET}`).bytes.toString(), "rebuilt worker bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: prereleases, an undecided gate and incomplete sets are refused before any write", () => {
  const { dir, files } = releaseFiles();
  try {
    const store = memoryStore();
    assert.throws(() => uploadRelease({ tag: "v0.35.0-rc.1", files, releaseExists: false, store }), /never published/);
    assert.throws(() => uploadRelease({ tag: TAG, files, releaseExists: undefined, store }), /decided/);
    assert.throws(() => uploadRelease({ tag: TAG, files: files.filter((file) => !file.endsWith("manifest.json")), releaseExists: false, store }), /manifest\.json/);
    assert.throws(() => uploadRelease({ tag: TAG, files: files.filter((file) => !file.endsWith(".zip")), releaseExists: false, store }), /\.zip/);
    assert.deepEqual(store.writes, []);
    assert.throws(() => selectUploadFiles([...files, join(tmpdir(), "manifest.json")]), /twice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune selection never returns the confirmed latest tag and returns nothing when read-back disagrees", () => {
  const listed = ["releases/v2.10.0/", "releases/v2.11.0/", "releases/v2.12.0/", "releases/tmp/", "releases/v2.9.0-rc.1/"];
  assert.deepEqual(selectPrunablePrefixes(listed, "v2.12.0", "v2.12.0"), ["releases/v2.10.0/", "releases/v2.11.0/", "releases/v2.9.0-rc.1/"]);
  // An orphan prefix above latest (an upload whose release job failed) is pruned too.
  assert.deepEqual(selectPrunablePrefixes(listed, "v2.11.0", "v2.11.0"), ["releases/v2.10.0/", "releases/v2.12.0/", "releases/v2.9.0-rc.1/"]);
  for (const tag of ["v2.10.0", "v2.11.0", "v2.12.0"]) {
    assert.ok(!selectPrunablePrefixes(listed, tag, tag).includes(`releases/${tag}/`));
  }
  assert.deepEqual(selectPrunablePrefixes(listed, "v2.11.0", "v2.12.0"), [], "read-back disagrees");
  assert.deepEqual(selectPrunablePrefixes(listed, undefined, "v2.12.0"), [], "read-back missing");
  assert.deepEqual(selectPrunablePrefixes(["releases/v2.10.0/"], "v2.12.0", "v2.12.0"), [], "latest prefix absent from the listing");
  assert.deepEqual(selectPrunablePrefixes(["releases/v2.12.0/"], "v2.12.0", "v2.12.0"), []);
});

test("latest.json never moves back and rejects malformed previous pointers", () => {
  assert.equal(renderLatestPointer("v2.12.0", undefined), '{"version":"v2.12.0"}\n');
  assert.equal(renderLatestPointer("v2.12.0", '{"version":"v2.11.0"}\n'), '{"version":"v2.12.0"}\n');
  assert.equal(renderLatestPointer("v2.12.0", '{"version":"v2.12.0"}\n'), '{"version":"v2.12.0"}\n');
  assert.throws(() => renderLatestPointer("v2.11.0", '{"version":"v2.12.0"}'), /back from v2\.12\.0/);
  assert.throws(() => renderLatestPointer("v2.12.0", '{"version":"v2.12.0+other"}'), /another build/);
  assert.throws(() => renderLatestPointer("v2.12.0", "<html>"), /not valid JSON/);
  assert.throws(() => renderLatestPointer("v2.12.0", '{"version":"latest"}'), /no v\* version/);
  assert.throws(() => renderLatestPointer("v2.12.0-rc.1", undefined), /never published/);
});

function publishedPrevious(store) {
  seed(store, "releases/v0.34.0/manifest.json", "{}");
  seed(store, "releases/v0.34.0/coflux-0.34.0-arm64.zip", "old zip");
  seed(store, LATEST_POINTER_KEY, '{"version":"v0.34.0"}\n');
  seed(store, DESKTOP_FEED_KEY, feedSource("0.34.0").replaceAll("coflux-0.34.0-arm64.zip", mirrorAssetUrl("v0.34.0", "coflux-0.34.0-arm64.zip")));
  seed(store, "releases/v0.35.0/manifest.json", "{}");
}

test("pointers: alias, feed, then latest.json; read back; prune every other release", () => {
  const { dir, dmg } = releaseFiles();
  try {
    const store = memoryStore();
    publishedPrevious(store);
    const { pruned } = advancePointers({ tag: TAG, feedSource: feedSource("0.35.0"), dmgFile: dmg, store });
    assert.deepEqual(store.writes, [DESKTOP_DMG_ALIAS_KEY, DESKTOP_FEED_KEY, LATEST_POINTER_KEY], "latest.json is written last");
    assert.equal(store.get(LATEST_POINTER_KEY), '{"version":"v0.35.0"}\n');
    assert.equal(store.objects.get(LATEST_POINTER_KEY).cacheControl, POINTER_CACHE_CONTROL);
    assert.equal(store.objects.get(DESKTOP_FEED_KEY).cacheControl, POINTER_CACHE_CONTROL);
    assert.match(store.get(DESKTOP_FEED_KEY), /url: https:\/\/dl\.coflux\.dev\/releases\/v0\.35\.0\/coflux-0\.35\.0-arm64\.zip/);
    const alias = store.objects.get(DESKTOP_DMG_ALIAS_KEY);
    assert.equal(alias.bytes.toString(), "dmg bytes");
    assert.equal(alias.cacheControl, DMG_ALIAS_CACHE_CONTROL, "the alias keeps its own short Cache-Control");
    assert.deepEqual(pruned, ["releases/v0.34.0/"]);
    assert.ok(store.objects.has("releases/v0.35.0/manifest.json"));
    assert.ok(![...store.objects.keys()].some((key) => key.startsWith("releases/v0.34.0/")));

    // A re-run of the pointer job is idempotent: same pointers, nothing left to prune.
    store.writes.length = 0;
    assert.deepEqual(advancePointers({ tag: TAG, feedSource: feedSource("0.35.0"), dmgFile: dmg, store }).pruned, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pointers: every refusal happens before the first write", () => {
  const { dir, dmg } = releaseFiles();
  try {
    const cases = [
      ["a lower version", (store) => seed(store, LATEST_POINTER_KEY, '{"version":"v0.36.0"}\n'), /back from/],
      ["same-version feed drift", (store) => {
        seed(store, LATEST_POINTER_KEY, '{"version":"v0.35.0"}\n');
        seed(store, DESKTOP_FEED_KEY, feedSource("0.35.0").replaceAll("digest", "other"));
      }, /漂移/],
      ["an unreadable pointer that is not a plain 404", (store) => {
        store.get = (key) => { throw new Error(`read ${key} failed (exit 254): (AccessDenied)`); };
      }, /AccessDenied/],
      ["a corrupt pointer", (store) => seed(store, LATEST_POINTER_KEY, "not json"), /not valid JSON/],
      ["missing versioned objects", (store) => store.objects.delete("releases/v0.35.0/manifest.json"), /upload job/],
    ];
    for (const [label, arrange, error] of cases) {
      const store = memoryStore();
      publishedPrevious(store);
      arrange(store);
      assert.throws(() => advancePointers({ tag: TAG, feedSource: feedSource("0.35.0"), dmgFile: dmg, store }), error, label);
      assert.deepEqual(store.writes, [], label);
      assert.deepEqual(store.removed, [], label);
    }
    const store = memoryStore();
    publishedPrevious(store);
    assert.throws(() => advancePointers({ tag: TAG, feedSource: feedSource("0.35.0"), dmgFile: join(dir, "manifest.json"), store }), /expected the DMG/);
    assert.throws(() => advancePointers({ tag: "v0.35.0-rc.1", feedSource: feedSource("0.35.0-rc.1"), dmgFile: dmg, store }), /never published/);
    assert.deepEqual(store.writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pointers: a read-back that disagrees fails the job and prunes nothing", () => {
  const { dir, dmg } = releaseFiles();
  try {
    for (const readBack of ['{"version":"v0.34.0"}\n', undefined]) {
      const store = memoryStore();
      publishedPrevious(store);
      const get = store.get;
      store.get = (key) => (key === LATEST_POINTER_KEY && store.writes.includes(LATEST_POINTER_KEY) ? readBack : get(key));
      assert.throws(() => advancePointers({ tag: TAG, feedSource: feedSource("0.35.0"), dmgFile: dmg, store }), /reads back/);
      assert.deepEqual(store.removed, []);
      assert.ok(store.objects.has("releases/v0.34.0/manifest.json"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aws store: a plain 404 is 'absent', any other failure throws", () => {
  const calls = [];
  const responses = [];
  const run = (args) => {
    calls.push(args);
    const response = responses.shift();
    if (response.file !== undefined) writeFileSync(args.at(-1), response.file);
    return { status: response.status, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  const store = createAwsStore({ bucket: "coflux-releases", endpoint: "https://account.r2.cloudflarestorage.com", run });

  responses.push({ status: 0, file: '{"version":"v1.0.0"}\n' });
  assert.equal(store.get(LATEST_POINTER_KEY), '{"version":"v1.0.0"}\n');
  assert.deepEqual(calls.at(-1).slice(0, 6), ["s3api", "get-object", "--bucket", "coflux-releases", "--key", LATEST_POINTER_KEY]);
  assert.ok(calls.at(-1).includes("--endpoint-url"));

  responses.push({ status: 254, stderr: "An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist." });
  assert.equal(store.get(LATEST_POINTER_KEY), undefined);
  responses.push({ status: 254, stderr: "An error occurred (AccessDenied) when calling the GetObject operation: Access Denied" });
  assert.throws(() => store.get(LATEST_POINTER_KEY), /AccessDenied/);
  responses.push({ status: 255, stderr: "Could not connect to the endpoint URL" });
  assert.throws(() => store.get(LATEST_POINTER_KEY), /Could not connect/);

  responses.push({ status: 254, stderr: "An error occurred (404) when calling the HeadObject operation: Not Found" });
  assert.equal(store.head("releases/v1.0.0/manifest.json"), undefined);
  responses.push({ status: 0, stdout: JSON.stringify({ Metadata: { sha256: "ab" } }) });
  assert.deepEqual(store.head("releases/v1.0.0/manifest.json"), { sha256: "ab" });
  responses.push({ status: 254, stderr: "An error occurred (403) when calling the HeadObject operation: Forbidden" });
  assert.throws(() => store.head("releases/v1.0.0/manifest.json"), /Forbidden/);

  responses.push({ status: 0, stdout: JSON.stringify({ CommonPrefixes: [{ Prefix: "releases/v1.0.0/" }, { Prefix: "releases/v0.9.0/" }] }) });
  assert.deepEqual(store.listPrefixes("releases/"), ["releases/v1.0.0/", "releases/v0.9.0/"]);
  assert.ok(calls.at(-1).includes("--delimiter"));
  responses.push({ status: 0, stdout: "" });
  assert.deepEqual(store.listPrefixes("releases/"), []);
  responses.push({ status: 254, stderr: "An error occurred (AccessDenied)" });
  assert.throws(() => store.listPrefixes("releases/"), /AccessDenied/);

  responses.push({ status: 0 });
  store.putText(LATEST_POINTER_KEY, "{}\n", { cacheControl: POINTER_CACHE_CONTROL, contentType: "application/json" });
  const put = calls.at(-1);
  assert.equal(put[0], "s3");
  assert.equal(put[1], "cp");
  assert.equal(put[3], `s3://coflux-releases/${LATEST_POINTER_KEY}`);
  assert.equal(put[put.indexOf("--cache-control") + 1], POINTER_CACHE_CONTROL);
  assert.equal(put[put.indexOf("--content-type") + 1], "application/json");
  assert.equal(put[put.indexOf("--metadata") + 1], `sha256=${sha256Hex(Buffer.from("{}\n"))}`);
  responses.push({ status: 1, stderr: "upload failed" });
  assert.throws(() => store.putText(LATEST_POINTER_KEY, "{}\n", { cacheControl: POINTER_CACHE_CONTROL, contentType: "application/json" }), /upload failed/);

  responses.push({ status: 0 });
  store.removePrefix("releases/v0.9.0/");
  assert.deepEqual(calls.at(-1).slice(0, 4), ["s3", "rm", "s3://coflux-releases/releases/v0.9.0/", "--recursive"]);
  const before = calls.length;
  for (const prefix of ["releases/", "desktop/", "", "releases/v0.9.0", "releases/../"]) {
    assert.throws(() => store.removePrefix(prefix), /non-release prefix/, prefix);
  }
  assert.equal(calls.length, before, "a refused delete never reaches the CLI");
});

test("missing R2 secrets or variables are named, never guessed", () => {
  assert.throws(() => readR2Env({}), /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET/);
  assert.throws(() => readR2Env({ R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_ENDPOINT: "https://x", R2_BUCKET: "" }), /missing R2_BUCKET$/);
  assert.throws(() => readR2Env({ R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_ENDPOINT: "http://x", R2_BUCKET: "c" }), /https/);
  const env = readR2Env({ R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_ENDPOINT: "https://x", R2_BUCKET: "c" });
  assert.equal(env.bucket, "c");
  assert.equal(env.awsEnv.AWS_ACCESS_KEY_ID, "a");
  assert.equal(env.awsEnv.AWS_DEFAULT_REGION, "auto");
});
