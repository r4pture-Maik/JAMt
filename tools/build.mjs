#!/usr/bin/env node
/**
 * build.mjs — release packager for the Chrome Web Store and addons.mozilla.org.
 *
 * Deliberately NOT a bundler:
 *   - nothing is minified, nothing is concatenated
 *   - the uploaded code is byte-identical to the reviewed source
 * That keeps us clear of AMO's source-code submission requirement and of the
 * Chrome Web Store code readability policy, and it makes review trivial: the
 * reviewer reads the same files we do.
 *
 * All it does is copy the served files and drop the manifest keys that the
 * target browser does not implement.
 *
 *   node tools/build.mjs              # both targets
 *   node tools/build.mjs chrome       # one target
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

/** Directories copied verbatim into every bundle. */
const BUNDLE_DIRS = ["background", "content", "details", "popup", "shared", "icons"];
/** Extra single files. LICENSE is required by its own terms: the notice must
 *  travel with every copy, and the uploaded archive is a copy. */
const BUNDLE_FILES = ["manifest.json", "LICENSE"];

/** Chrome ignores background.scripts in MV3 only from 121 on; before that it
 *  refuses to load the extension entirely. */
const MIN_CHROME_FOR_BACKGROUND_SCRIPTS = 121;

/**
 * `browser_specific_settings.gecko.data_collection_permissions` is required for
 * every new add-on submitted to AMO since 2025-11-03, but Firefox only
 * understands it from 140. Declaring the key under a lower floor is rejected by
 * addons-linter (KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION) and would also leave
 * older Firefox with a consent experience nobody sees.
 */
const MIN_FIREFOX_FOR_DATA_COLLECTION_PERMISSIONS = 140;

const TARGETS = {
  chrome: {
    store: "Chrome Web Store",
    transform(m) {
      // Ignored by Chrome 121+, but a dead key buys a console warning and
      // noise during review.
      delete m.background?.scripts;
      delete m.browser_specific_settings;
      // Firefox-specific hardening: `not_allowed` keeps the content script out
      // of Chrome incognito windows, where counts would land in the same
      // storage.local as the normal profile. Dropping it restores Chrome's
      // default ("spanning"), which is what shipped before.
      delete m.incognito;
    },
    expect: "service_worker",
  },
  firefox: {
    store: "Firefox Add-ons (AMO)",
    transform(m) {
      // Firefox does not implement background.service_worker (bug 1573659).
      delete m.background?.service_worker;
      // Meaningless to AMO, which warns on unknown keys.
      delete m.minimum_chrome_version;
    },
    expect: "scripts",
  },
};

/* ------------------------------------------------------------------ *
 * Minimal ZIP writer (store + deflate). Node built-ins only, so the
 * build has no dependencies to audit or vendor.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp: two builds of the same tree produce identical archives,
// which keeps diffs between released versions meaningful.
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    // Already-compressed payloads (PNG) would grow: fall back to STORE.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, central, eocd]);
}

/* ------------------------------------------------------------------ */

function collect(absDir, prefix) {
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(absDir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collect(abs, name));
    else if (entry.isFile()) out.push({ name, abs });
  }
  return out;
}

function iconPaths(manifest) {
  const sizes = new Set();
  for (const src of [manifest.icons, manifest.action?.default_icon]) {
    for (const [size, file] of Object.entries(src ?? {})) sizes.add(`${size} ${file}`);
  }
  return [...sizes].map((s) => s.split(" "));
}

/** Refuse to build rather than ship something a reviewer will bounce. */
function validateSource(manifest) {
  const errors = [];

  // Regression guard: shipping background.scripts to a browser older than 121
  // makes the extension fail to load, so the floor must be raised in lockstep.
  if (manifest.background?.scripts) {
    const min = parseInt(manifest.minimum_chrome_version ?? "0", 10);
    if (min < MIN_CHROME_FOR_BACKGROUND_SCRIPTS) {
      errors.push(
        `background.scripts is present, so minimum_chrome_version must be >= ` +
          `${MIN_CHROME_FOR_BACKGROUND_SCRIPTS} (found ${manifest.minimum_chrome_version}). ` +
          `Chrome ${MIN_CHROME_FOR_BACKGROUND_SCRIPTS - 1} and earlier refuse to load the extension.`,
      );
    }
  }
  if (!manifest.background?.service_worker) {
    errors.push("background.service_worker is missing: Chrome has no fallback.");
  }

  // Same invariant, Firefox side: AMO blocks new add-ons without the key, and
  // the key is meaningless below Firefox 140.
  const gecko = manifest.browser_specific_settings?.gecko;
  if (gecko && !gecko.data_collection_permissions) {
    errors.push(
      `browser_specific_settings.gecko.data_collection_permissions is missing. ` +
        `AMO refuses new add-ons without it (mandatory since 2025-11-03). This ` +
        `extension transmits nothing outside the browser, so the value must be ` +
        `{ "required": ["none"] }.`,
    );
  }
  if (gecko?.data_collection_permissions) {
    const min = parseFloat(gecko.strict_min_version ?? "0") || 0;
    if (min < MIN_FIREFOX_FOR_DATA_COLLECTION_PERMISSIONS) {
      errors.push(
        `data_collection_permissions is present, so gecko.strict_min_version must be >= ` +
          `${MIN_FIREFOX_FOR_DATA_COLLECTION_PERMISSIONS} (found ${gecko.strict_min_version}). ` +
          `Firefox ignores the key below that, so users would never see the data ` +
          `collection consent.`,
      );
    }
    // `incognito: not_allowed` keeps the content script out of private windows.
    // Without it the default is "spanning": opt-in from about:addons, but then
    // storage.local would hold listening counts from a private session, which
    // Add-on Policies 6.3.2 forbids for listed add-ons.
    //
    // It is a TOP-LEVEL manifest key, not a gecko one: nesting it under
    // browser_specific_settings.gecko is not part of the schema, so Firefox
    // logged `An unexpected property was found in the WebExtension manifest` on
    // every load and silently ignored it, leaving the add-on default to
    // "spanning".
    if (manifest.incognito !== "not_allowed") {
      errors.push(
        `manifest "incognito" must be "not_allowed" (top-level key, NOT under ` +
          `browser_specific_settings.gecko). Add-on Policies 6.3.2 forbid storing ` +
          `data from private browsing sessions. Found: ${JSON.stringify(manifest.incognito)}.`,
      );
    }
    // Regression guard: the key used to live here, where Firefox does not read it.
    if (gecko && "incognito" in gecko) {
      errors.push(
        `browser_specific_settings.gecko.incognito is not a valid gecko property. ` +
          `Firefox rejects it with "An unexpected property was found in the ` +
          `WebExtension manifest" and ignores it. Use the top-level "incognito" key.`,
      );
    }
  }

  // Every runtime message goes through shared/messaging.js, which picks the
  // calling convention the host engine accepts. If a context forgets to load
  // it, every message throws on the other engine and the extension silently
  // stops tracking, so it is worth a build-time guard.
  if (!existsSync(join(ROOT, "shared", "messaging.js"))) {
    errors.push("shared/messaging.js is missing: no context can reach the background.");
  }
  for (const [file, who] of [
    ["content/content.js", "the content script"],
    ["background/background.js", "the background script"],
    ["popup/popup.js", "the popup"],
    ["details/details.js", "the Details page"],
  ]) {
    const abs = join(ROOT, file);
    if (!existsSync(abs) || !readFileSync(abs, "utf8").includes("YTMCMessaging")) {
      errors.push(`${file} does not use shared/messaging.js, so ${who} cannot reach the background.`);
    }
  }
  if (!readFileSync(join(ROOT, "popup", "popup.html"), "utf8").includes("shared/messaging.js")) {
    errors.push("popup/popup.html does not load shared/messaging.js, so the popup has no helper.");
  }

  return errors;
}

function buildTarget(name, spec, sourceManifest) {
  const warnings = [];
  const manifest = structuredClone(sourceManifest);
  spec.transform(manifest);

  if (!manifest.background?.[spec.expect]) {
    warnings.push(`background.${spec.expect} is missing in the generated manifest.`);
  }
  if (name === "firefox") {
    const geckoId = manifest.browser_specific_settings?.gecko?.id ?? "";
    if (/example\.(com|org|net)$/i.test(geckoId)) {
      warnings.push(
        `browser_specific_settings.gecko.id is the placeholder "${geckoId}". ` +
          `AMO will not accept it: set a real add-on id before submitting.`,
      );
    }
    // The source manifest carries the real id; make sure the transform did not
    // drop it, since Firefox refuses to load an MV3 add-on without one.
    if (!geckoId) {
      warnings.push(
        `browser_specific_settings.gecko.id is missing. Manifest V3 add-ons ` +
          `must declare an id to be signed.`,
      );
    }
  }

  const outDir = join(DIST, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sources = [];
  for (const dir of BUNDLE_DIRS) sources.push(...collect(join(ROOT, dir), dir));
  for (const file of BUNDLE_FILES) sources.push({ name: file, abs: join(ROOT, file) });

  const entries = sources.map(({ name: entryName, abs }) => {
    const raw = readFileSync(abs);
    const data =
      entryName === "manifest.json" ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) : raw;
    const dest = join(outDir, ...entryName.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    return { name: entryName, data };
  });

  const zipPath = join(DIST, `${name}-${manifest.version}.zip`);
  const zip = buildZip(entries);
  writeFileSync(zipPath, zip);

  return { warnings, zipPath, zip, manifest, fileCount: entries.length };
}

/* ------------------------------------------------------------------ */

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = requested.length ? requested : Object.keys(TARGETS);

for (const t of targets) {
  if (!TARGETS[t]) {
    console.error(`Unknown target "${t}". Known: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
}

const sourceManifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const errors = validateSource(sourceManifest);
if (errors.length) {
  console.error("Refusing to build:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

for (const [size, file] of iconPaths(sourceManifest)) {
  if (!BUNDLE_DIRS.includes(file.split("/")[0])) {
    console.error(`Refusing to build: icon ${size} -> ${file} is outside the bundled directories.`);
    process.exit(1);
  }
}

mkdirSync(DIST, { recursive: true });

for (const name of targets) {
  const spec = TARGETS[name];
  const { warnings, zipPath, zip, manifest, fileCount } = buildTarget(name, spec, sourceManifest);

  console.log(`\n${spec.store}`);
  console.log(`  version   ${manifest.version}`);
  console.log(`  files     ${fileCount} -> ${relative(ROOT, join(DIST, name))}/`);
  console.log(`  archive   ${relative(ROOT, zipPath)} (${(zip.length / 1024).toFixed(1)} KB)`);
  for (const w of warnings) console.log(`  WARNING   ${w}`);
}
console.log("");
