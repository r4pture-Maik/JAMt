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

/** Directories copied verbatim into every bundle.
 *  `_locales` must be listed or the message catalogs never ship and every
 *  `__MSG_*__` placeholder in manifest.json resolves to an empty string. */
const BUNDLE_DIRS = ["background", "content", "details", "popup", "shared", "icons", "_locales"];
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

/** ---------------------------------------------------------------- *
 * i18n validation constants.
 *
 * Chrome and Firefox share one message-catalog format
 * (`_locales/<code>/messages.json`) and one substitution syntax
 * (`__MSG_<name>__` in manifest.json only, never in HTML). The validator
 * below exists because both engines fail *silently* for a key that is not
 * in the catalog: Chrome substitutes "" with no diagnostic at all, Firefox
 * substitutes "" and logs a console error. A missing translation is
 * therefore a blank label in Chrome and noise in Firefox, which is exactly
 * the kind of bug that ships.
 * ---------------------------------------------------------------- */

/** Must match `default_locale` in manifest.json; the reference catalog. */
const DEFAULT_LOCALE = "en";
const LOCALES_DIR = "_locales";

/** Source trees scanned for message keys. */
const I18N_SCAN_DIRS = ["popup", "details", "content", "shared", "background"];

/** Fields a catalog entry may carry. Only the default catalog keeps the
 *  translator-facing ones; the engines ignore them, so shipping them in every
 *  locale is dead weight. */
const I18N_FIELDS_DEFAULT = ["message", "description", "placeholders"];
const I18N_FIELDS_TRANSLATED = ["message"];

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

/** ---------------------------------------------------------------- *
 * i18n source scanning helpers.
 *
 * Plain text scanners on purpose: the build has no dependencies and must
 * not parse the reviewed source. A key counts as referenced when it appears
 * as a string literal anywhere in the scanned JS (calls, key maps, lists
 * alike), or in a `data-i18n*` attribute in HTML. A key named in a comment
 * also counts; that is the safe direction, since the worst case is a missed
 * "unused key" report rather than a false failure.
 * ---------------------------------------------------------------- */

/** Recursively collect every string value in a JSON-ish object, with its path. */
function collectStrings(value, out = [], path = "") {
  if (typeof value === "string") {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, out, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectStrings(v, out, path ? `${path}.${k}` : k);
  }
  return out;
}

/** Every `<name>` referenced by a `__MSG_<name>__` placeholder in `text`. */
function msgPlaceholderNames(text) {
  // The placeholder body is the message name verbatim (`__MSG_foo__` -> `foo`),
  // so `MSG_` is part of the prefix, not of the name.
  return [...text.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]);
}

/** Recursively list the `.js` / `.html` files under `<relDir>`, relative to ROOT. */
function scanFiles(relDir) {
  const out = [];
  const abs = join(ROOT, relDir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...scanFiles(rel));
    else if (entry.isFile() && /\.(js|html)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Every message key the source refers to, as `Map<key, ["file:line", ...]>`.
 * JS: any `'msg_...'` / `"msg_..."` / backtick literal. HTML: the key part of
 * `data-i18n`, `-title`, `-placeholder`, `-aria-label` (`key` or `key:$1$2`).
 * A literal that is a plural base (`plural('msg_count_play', n)`) is returned
 * as written; the caller resolves it against the `_one` / `_other` forms.
 */
function collectSourceKeys() {
  const refs = new Map();
  for (const file of I18N_SCAN_DIRS.flatMap(scanFiles)) {
    const text = readFileSync(join(ROOT, ...file.split("/")), "utf8");
    const pattern = file.endsWith(".html")
      ? /\bdata-i18n(?:-title|-placeholder|-aria-label)?\s*=\s*(["'])\s*([A-Za-z0-9_]+)\s*(?::[^"']*)?\1/g
      : /(["'`])(msg_[A-Za-z0-9_]+)\1/g;
    for (const m of text.matchAll(pattern)) {
      const where = `${file}:${text.slice(0, m.index).split("\n").length}`;
      if (!refs.has(m[2])) refs.set(m[2], []);
      refs.get(m[2]).push(where);
    }
  }
  return refs;
}

/**
 * Shape of a messages.json catalog: a flat `key -> { message, ... }` map, with
 * the entry fields limited to `allowed`. Returns human-readable problems.
 */
function catalogShapeProblems(catalog, label, allowed) {
  const problems = [];
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    return [
      `${label} must be a JSON object mapping message names to message objects, ` +
        `e.g. { "msg_title": { "message": "Title" } }.`,
    ];
  }
  for (const [key, value] of Object.entries(catalog)) {
    const at = `${label} -> ${JSON.stringify(key)}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${at} must be an object { "message": "..." }, not ${JSON.stringify(value)}.`);
      continue;
    }
    if (typeof value.message !== "string") {
      problems.push(
        `${at} has no string "message". A catalog entry without one resolves to ` +
          `"" on both engines, so every lookup of this key renders a blank string.`,
      );
    } else if (value.message.trim() === "") {
      // An empty translation is the same blank label as a missing key, and it
      // slips past the key-set check. Chrome renders "" with no diagnostic, and
      // localizeDocument() treats "" as "no translation" and leaves the inline
      // English in place.
      problems.push(
        `${at} has an empty "message". The key is present, so the key-set check ` +
          `passes, but every lookup still renders blank. Copy the ${DEFAULT_LOCALE} ` +
          `message or delete the key.`,
      );
    }
    if ("description" in value && typeof value.description !== "string") {
      problems.push(`${at} has a non-string "description"; it must be a string or absent.`);
    }
    if (
      "placeholders" in value &&
      (value.placeholders === null ||
        typeof value.placeholders !== "object" ||
        Array.isArray(value.placeholders))
    ) {
      problems.push(`${at} has a malformed "placeholders"; it must be an object or absent.`);
    }
    const unknown = Object.keys(value).filter((f) => !allowed.includes(f));
    if (unknown.length) {
      problems.push(
        `${at} has unsupported field(s) ${unknown.map((f) => JSON.stringify(f)).join(", ")}. ` +
          `Entries in this catalog may only carry ${allowed.map((f) => JSON.stringify(f)).join(", ")}.`,
      );
    }
  }
  return problems;
}

/**
 * Read one catalog. Always returns `{ rel, error, problems, catalog }`:
 * `catalog` is non-null only when the file parsed *and* has the right shape.
 */
function readCatalog(locale) {
  const rel = `${LOCALES_DIR}/${locale}/messages.json`;
  const abs = join(ROOT, LOCALES_DIR, locale, "messages.json");
  if (!existsSync(abs)) {
    return { rel, error: `${rel} is missing.`, problems: [], catalog: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return { rel, error: `${rel} is not valid JSON: ${err.message}.`, problems: [], catalog: null };
  }
  const allowed = locale === DEFAULT_LOCALE ? I18N_FIELDS_DEFAULT : I18N_FIELDS_TRANSLATED;
  const problems = catalogShapeProblems(parsed, rel, allowed);
  return { rel, error: null, problems, catalog: problems.length ? null : parsed };
}

/** Locale directories present under `_locales/`, sorted, excluding the default. */
function translatedLocales() {
  const abs = join(ROOT, LOCALES_DIR);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== DEFAULT_LOCALE)
    .map((e) => e.name)
    .sort();
}

/** The `$1`..`$9` slots of a message, sorted, as one comparable string. */
const placeholderSlots = (message) => (message.match(/\$[1-9]/g) ?? []).sort().join(" ");

/**
 * The i18n contract. validateSource() calls it and treats every returned
 * string as a fatal build error.
 */
function validateI18n(manifest) {
  const errors = [];

  // Guard the manifest edit itself: `_locales/` plus `__MSG_*__` without
  // `default_locale` does not degrade, it fails to load at all.
  if (manifest.default_locale !== DEFAULT_LOCALE) {
    errors.push(
      `manifest "default_locale" must be "${DEFAULT_LOCALE}" (found ` +
        `${JSON.stringify(manifest.default_locale)}). Chrome refuses to load an ` +
        `extension that ships _locales/ without it, and AMO rejects the upload.`,
    );
  }

  if (!existsSync(join(ROOT, LOCALES_DIR))) {
    errors.push(
      `${LOCALES_DIR}/ is missing, so there are no message catalogs at all. ` +
        `manifest.json resolves its name, description and action title through ` +
        `__MSG_*__ placeholders: Chrome and Firefox then substitute empty strings, ` +
        `and Firefox refuses to load the extension entirely.`,
    );
    return errors;
  }

  // Default catalog: exists, parses, has the right shape.
  const en = readCatalog(DEFAULT_LOCALE);
  if (en.error || en.problems.length) {
    errors.push(
      ...(en.error
        ? [`${en.error} It is the reference catalog: every other check resolves against it.`]
        : en.problems),
    );
    return errors;
  }
  const keys = new Set(Object.keys(en.catalog));
  const enPath = `${LOCALES_DIR}/${DEFAULT_LOCALE}/messages.json`;

  // Every __MSG_*__ anywhere in the manifest resolves in `en`. These keys are
  // referenced by the manifest, not by source code, so they are exempt from the
  // unused-key check below.
  const manifestKeys = new Set();
  for (const { path, value } of collectStrings(manifest)) {
    for (const name of msgPlaceholderNames(value)) {
      manifestKeys.add(name);
      if (!keys.has(name)) {
        errors.push(
          `manifest.json ${path} -> "${value}" needs message "${name}", which is not in ` +
            `${enPath}. A __MSG_*__ placeholder that does not resolve is replaced with ` +
            `an empty string by both engines, with no console output on Chrome.`,
        );
      }
    }
  }

  // Plural forms (en is the reference; the key-set check carries it to the rest).
  for (const key of keys) {
    const m = /^(.+)_(zero|one|two|few|many|other)$/.exec(key);
    if (!m) continue;
    const [, base, category] = m;
    if (category === "zero") {
      errors.push(
        `${enPath} defines "${key}". The runtime never selects a "zero" form (pt_BR ` +
          `maps 0 to "other"), so it is dead; delete it.`,
      );
    } else if (category === "one" && !keys.has(`${base}_other`)) {
      errors.push(`${enPath} defines "${key}" but not "${base}_other", the fallback every count needs.`);
    } else if (category === "other" && !keys.has(`${base}_one`)) {
      errors.push(`${enPath} defines "${key}" but not "${base}_one".`);
    }
    if (keys.has(base)) {
      errors.push(`${enPath} defines "${base}" and its plural forms "${base}_*"; use one or the other.`);
    }
  }

  // Source references. A literal resolves directly, or as a plural base when
  // `<base>_other` exists (plural('msg_count_play', n) reads _one / _other).
  const used = new Set();
  for (const [key, where] of collectSourceKeys()) {
    if (keys.has(key)) {
      used.add(key);
    } else if (keys.has(`${key}_other`)) {
      used.add(`${key}_one`).add(`${key}_other`);
    } else {
      errors.push(
        `message "${key}" is referenced at ${where.join(", ")} but is not in ${enPath}. ` +
          `YTMCI18n.t() returns "" for an unknown key, so this renders as a blank label.`,
      );
    }
  }
  const unused = [...keys].filter((k) => !used.has(k) && !manifestKeys.has(k)).sort();
  if (unused.length) {
    errors.push(
      `${unused.length} message(s) in ${enPath} are referenced nowhere in ` +
        `${I18N_SCAN_DIRS.join("/, ")}/ or the manifest: ` +
        `${unused.map((k) => JSON.stringify(k)).join(", ")}. Delete them from every ` +
        `locale (each one is translated six times for nothing), or reference them.`,
    );
  }

  // Every other catalog mirrors `en`: same keys, same $n slots per key.
  const translated = [];
  for (const locale of translatedLocales()) {
    const other = readCatalog(locale);
    if (other.error || other.problems.length) {
      errors.push(
        ...(other.error
          ? [`${other.error} Every locale directory under ${LOCALES_DIR}/ must contain a messages.json.`]
          : other.problems),
      );
      continue;
    }
    translated.push(other);
    const missingKeys = [...keys].filter((k) => !(k in other.catalog)).sort();
    const extraKeys = Object.keys(other.catalog)
      .filter((k) => !keys.has(k))
      .sort();
    if (missingKeys.length) {
      errors.push(
        `${other.rel} is missing ${missingKeys.length} key(s) that ${enPath} defines: ` +
          `${missingKeys.map((k) => JSON.stringify(k)).join(", ")}. Chrome returns "" for ` +
          `a missing key without a diagnostic, so the gap is a silent blank label.`,
      );
    }
    if (extraKeys.length) {
      errors.push(
        `${other.rel} defines ${extraKeys.length} key(s) that ${enPath} does not: ` +
          `${extraKeys.map((k) => JSON.stringify(k)).join(", ")}. They are never looked up.`,
      );
    }
    for (const key of keys) {
      if (!(key in other.catalog)) continue;
      const want = placeholderSlots(en.catalog[key].message);
      const got = placeholderSlots(other.catalog[key].message);
      if (want !== got) {
        errors.push(
          `${other.rel} -> "${key}" has placeholders [${got}] but ${DEFAULT_LOCALE} has ` +
            `[${want}]. A dropped $n renders without its value; an extra one renders literally.`,
        );
      }
    }
  }

  // Brand strings (the extension name and the toolbar title) are not translated:
  // byte-identical in every catalog. The keys come from the manifest, so this
  // stays correct if a placeholder is renamed.
  const brandKeys = [manifest.name, manifest.action?.default_title].flatMap((v) =>
    msgPlaceholderNames(v ?? ""),
  );
  for (const brandKey of new Set(brandKeys)) {
    if (!keys.has(brandKey)) continue;
    const brand = Buffer.from(en.catalog[brandKey].message, "utf8");
    for (const other of translated) {
      const value = other.catalog[brandKey]?.message;
      if (typeof value === "string" && !Buffer.from(value, "utf8").equals(brand)) {
        errors.push(
          `${other.rel} message "${brandKey}" is ${JSON.stringify(value)} but ${enPath} has ` +
            `${JSON.stringify(en.catalog[brandKey].message)}. The extension name is a brand ` +
            `and must be byte-identical in every catalog.`,
        );
      }
    }
  }

  return errors;
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

  // i18n contract: catalogs well-shaped, every manifest / source reference
  // resolves, no dead keys, translated catalogs mirror `en` (keys, $n slots,
  // plural forms, brand strings).
  errors.push(...validateI18n(manifest));

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
  for (const dir of BUNDLE_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) {
      if (dir === LOCALES_DIR) {
        // validateSource() already refuses to build when the default catalog is
        // missing; this warning catches the directory being renamed or deleted
        // between validation and packaging.
        warnings.push(
          `${LOCALES_DIR}/ is missing, so this bundle ships without message catalogs. ` +
            `manifest.json declares "default_locale" and resolves its name, ` +
            `description and action title through __MSG_*__ placeholders: Chrome ` +
            `substitutes empty strings, and Firefox refuses to load the extension.`,
        );
        continue;
      }
      // Any other missing source directory is a packaging bug, not a state we
      // can paper over: let collect() fail loudly as it always has.
      sources.push(...collect(abs, dir));
      continue;
    }
    sources.push(...collect(abs, dir));
  }
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
