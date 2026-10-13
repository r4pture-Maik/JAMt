# YTMusic Counter - Firefox & Chrome Extension

A lightweight, privacy-friendly WebExtension (Manifest V3) that tracks and counts your music listening stats on [YouTube Music](https://music.youtube.com). One codebase, two stores: **Firefox 140+** (addons.mozilla.org) and **Chrome 121+** (Chrome Web Store).

---

## 🎯 Key Features

1. **Per-Song Player Badge**: Directly on YouTube Music's player bar, you see how many times you have listened to the currently playing song (e.g. `🎵 5 plays`).
2. **Aggregated Grouped Counters**:
   - **Songs**: Lifetime play count per unique track.
   - **Artists**: Lifetime plays aggregated across all songs by that artist (including collaborations).
   - **Albums**: Counts how many times you have listened to a full album **from start to finish** without skipping.
3. **Listening Time**: Continuous playback is accumulated in the background, so the popup and dashboard show *Time Listened* next to your play totals.
4. **Optimized Storage**: Uses compact $O(1)$ dictionary key-value maps for counts in `storage.local`, plus a small IndexedDB cover-art cache (128px WebP). Zero bloat, no unbounded chronological histories, and negligible memory footprint (< 400 KB even after years of continuous listening).
5. **Six Languages, Switchable In-App**: English, German, Spanish, French, Italian and Brazilian Portuguese ship as `__MSG_*__` catalogs, and the Details page has a language switcher that overrides the browser locale without a reload.
6. **No Build Step Required**: Pure WebExtensions (Manifest V3) JavaScript, CSS, and HTML. A release packager (`tools/build.mjs`) copies the served files, strips the manifest keys each browser does not implement, validates the message catalogs, and writes the upload ZIPs — see [Building for Release](#-building-for-release).
7. **Dashboard, Settings & About**: A dedicated details page with an **Overview** tab (totals, artist/album/single counts, album listening progress), a **Settings** tab (language, history sync, cover-art cache, backup/restore, 3-step data wipe) and an **About** tab (version, contact links, changelog).
8. **Automated History Scanner**: Scans `music.youtube.com/history` with auto-scrolling to extract past listening history and batch-import all tracks, plays, and artists into your extension stats.
9. **Backup & Restore**: One-click export of your whole library to a JSON file and restore from it, so a profile reset is never a data loss.

---

## 📁 Project Structure

```text
ytmusic-counter/
├── manifest.json              # WebExtension MV3 metadata, single source for both stores
├── _locales/                  # Message catalogs: en (default), de, es, fr, it, pt_BR
├── background/
│   ├── background.js          # Message router, play counting, enrichment pump
│   ├── storage.js             # storage.local schema, counters, export/import, lock
│   ├── scoring.js             # Album completion logic, track-title index
│   ├── duration.js            # Listening-time accumulation
│   ├── enrichment.js          # Throttled browse queue & retry bookkeeping
│   └── thumbnails.js          # IndexedDB cover-art cache (128px WebP)
├── content/
│   ├── content.js             # Playback detection, in-player badge, history scanner
│   └── content.css            # Badge styling on the YouTube Music player
├── shared/
│   ├── browse-parse.js        # InnerTube browse payload parsing (both worlds)
│   ├── messaging.js           # Cross-engine runtime/tabs messaging (see below)
│   ├── i18n.js                # Localization runtime: catalogs, plurals, fallbacks
│   └── page-context.js        # MAIN-world ytcfg bridge, via postMessage
├── details/
│   ├── details.html           # Overview / Settings / About page
│   ├── details.css            # Dark theme dashboard styling
│   └── details.js             # Tab logic, stats sync, settings, backup, 3-step wipe
├── popup/
│   ├── popup.html             # Toolbar popup: Songs / Artists / Albums
│   ├── popup.css              # Dark theme styling (YouTube Music aesthetic)
│   └── popup.js               # Ranked lists & live counters
├── icons/                     # 16/32/48/128 PNG icons
├── i18n/fragments/            # Translation working copies (B1-B5), not shipped
├── tools/build.mjs            # Release packager (Chrome + Firefox bundles, i18n validation)
├── tests/                     # node:test unit suite (11 files)
├── .githooks/pre-commit       # Runs the test suite with the 80% coverage gate
├── package.json               # Scripts only - zero runtime dependencies
├── PRIVACY.md                 # Privacy policy (also used for both store listings)
├── LICENSE                    # MIT
└── README.md                  # This file
```

`shared/browse-parse.js` is loaded twice on purpose: once as an ES module by the
background, and once as a classic script in the isolated content-script world, so both share
one implementation of the browse-response parsing.

`shared/messaging.js` follows the same pattern and exists because the two engines do not
accept each other's calling convention: `chrome.*` is callback-only, while `browser.*` is
promise-only and **throws** if handed a callback. Every `sendMessage` therefore goes through
this helper, which picks the convention the host engine accepts.

`shared/i18n.js` exists because `chrome.i18n.getMessage()` can only answer in the browser's
UI language, so an in-app language switcher needs a second lookup path. Extension pages
fetch `_locales/<code>/messages.json` themselves; a content script cannot (the request
would go to the host page's origin), so it asks the background for the raw templates.
See [Localization](#-localization).

---

## 🚀 How to Install and Test

> Load the built manifest from `dist/<browser>/`, **not** the one in the project root. The root
> manifest is the cross-platform source and still carries `background.service_worker`, which
> Firefox does not implement; the bundle is the one the packager produced for that browser.

> After reloading the extension, **reload your `music.youtube.com` tab** as well. Content
> scripts are injected on page load, so a tab left open keeps running the previous version.

### Firefox

1. Build the bundle:
   ```bash
   npm run build:firefox   # -> dist/firefox/
   ```
2. Open `about:debugging#/runtime/this-firefox` in the address bar.
3. Under **Temporary Extensions**, click **"Load Temporary Add-on..."**.
4. Browse to **`dist/firefox/`** and select **`manifest.json`**, then click **Open**.

### Chrome

1. Build the bundle:
   ```bash
   npm run build:chrome   # -> dist/chrome/
   ```
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **"Load unpacked"** and select the **`dist/chrome/`** folder.

---

## 🎧 Testing the Features

1. Open **[https://music.youtube.com](https://music.youtube.com)**.
2. Play any song:
   - The player badge next to the volume controls immediately shows `🎵 0 plays` (or your previous count).
   - After listening for at least 5 seconds, the count increments by 1 with a subtle pulse animation.
3. Click the **YTMusic Counter** icon in the toolbar:
   - **Total Plays** and **Time Listened** in the hero block.
   - Switch between the **Top Songs**, **Top Artists** and **Top Albums** tabs.
   - Check the **Now Playing** card displaying the active song's play count.
4. Open the **Details** page from the popup:
   - **Overview**: totals, *Different Songs*, *Artists*, *Albums*, *Singles*, *Albums Finished*, and your album listening progress.
   - **Settings**: change the extension language, trigger a history sync, inspect the thumbnail cache, export/restore your library, or wipe all data behind a 3-step confirmation.
   - **About**: version, contact links and the changelog.

---

## 🔒 Privacy & Data Collection

**YTMusic Counter is privacy-friendly by architecture:**

- **No telemetry, no analytics, no tracking**: nothing is measured, logged, fingerprinted, or sent anywhere.
- **No data leaves your browser**: there is no server, no account, no backend. The only network requests go to `music.youtube.com` (to read your listening history and look up album tracklists) and to Google's own image CDNs (to download cover art) — the same hosts YouTube Music already contacts while you use it.
- **100% on-device storage**: all counts live in `storage.local` plus a local IndexedDB cover-art cache. Uninstalling erases everything.
- **Open source and auditable**: no build step, no obfuscation, no vendored binaries. The code you review is the code that runs.
- **History import is opt-in**: the only feature that reads anything about your activity runs when you ask it to, and is documented in full in the [Privacy Policy](PRIVACY.md).

Read the complete [Privacy Policy](PRIVACY.md) for network request details, permission
explanations, and the Chrome Web Store Limited Use affirmation.

---

## 🛠️ Development & Testing

No dependencies, no `node_modules`, no transpiler. The whole suite runs on Node's built-in
test runner against the same files the browser loads.

```bash
npm test              # node:test unit suite
npm run test:coverage # suite + coverage report for background/, shared/, content/
npm run test:gate     # suite + coverage, fails under 80% lines/branches/functions
npm run build         # both store bundles
```

A **pre-commit hook** runs `npm run test:gate`, so a commit that breaks a test or drops below
the coverage thresholds is rejected. `npm run prepare` (run automatically after `npm install`)
points `core.hooksPath` at `.githooks/`. In an emergency: `git commit --no-verify`.

---

## 🌍 Localization

Six catalogs live in `_locales/<code>/messages.json`: `en` (default, and the reference),
`de`, `es`, `fr`, `it`, `pt_BR`. `manifest.json` resolves its name, description and action
title through `__MSG_*__` placeholders; everything else is looked up at runtime by
`shared/i18n.js`.

`tools/build.mjs` **refuses to build** on any i18n violation, because both engines fail
*silently* for a bad key — Chrome substitutes `""` with no diagnostic, Firefox substitutes
`""` and logs an error, which in practice ships as a blank label:

- a `__MSG_*__` in the manifest or a key referenced in source that is missing from `en`
- a key in `en` that nothing references (each dead key is translated six times for nothing)
- a translated catalog with missing/extra keys, or a `$1`/`$2` placeholder that drifted
- a plural base without both `_one` and `_other`, or a `_zero` form the runtime never selects
- an empty `message`, which passes the key-set check but still renders blank
- a translated brand string: the extension name must be byte-identical in every catalog

Plural categories come from `Intl.PluralRules`, never from a `count === 1 ?` ternary
(French treats 0 as singular). `i18n/fragments/` holds the translator working copies
(`B1`-`B5`) and is not part of the bundle.

---

## ⚖️ Disclaimer & Trademark Notice

YouTube and YouTube Music are registered trademarks of Google LLC. 

**YTMusic Counter** is an independent, open-source project and is not affiliated with, endorsed by, sponsored by, or connected to Google LLC, YouTube, or Alphabet Inc.

---

## 📦 Building for Release

There is no bundler and no transpiler. `tools/build.mjs` validates the source, copies the
served files (`background/`, `content/`, `details/`, `popup/`, `shared/`, `icons/`,
`_locales/`, plus `manifest.json` and `LICENSE`), drops the manifest keys each browser does
not implement, and writes two uploadable archives in `dist/`:

```bash
npm run build           # both targets
npm run build:chrome    # -> dist/chrome-1.1.0.zip
npm run build:firefox   # -> dist/firefox-1.1.0.zip
```

Nothing is minified or concatenated, so the uploaded code is byte-identical to the
source above and both stores accept it without a separate source-code submission. The ZIP is
written with a fixed timestamp, so two builds of the same tree produce identical archives.
`dist/` is gitignored.

The single `manifest.json` is the source of truth for both. It carries both
`background.service_worker` (Chrome) and `background.scripts` (Firefox) because the two
browsers implement MV3 background contexts differently, and the build strips whichever
one the target does not want. The whole `browser_specific_settings` block is dropped from
the Chrome bundle, and so is `incognito`, so neither Firefox-only key reaches that store.

> `minimum_chrome_version` must stay at **121 or above** while `background.scripts` is
> present in the source manifest: Chrome 120 and earlier refuse to load the extension
> outright. The build fails loudly if that invariant is ever broken.

### Store-specific manifest keys

| Key | Firefox | Chrome | Why |
| :--- | :--- | :--- | :--- |
| `browser_specific_settings.gecko.data_collection_permissions` | `required: ["none"]` | dropped | Mandatory on AMO for new add-ons since 2025-11-03. `none` is accurate: nothing leaves the browser. |
| `browser_specific_settings.gecko.strict_min_version` | `140.0` | — | The data collection key only exists from Firefox 140. |
| `incognito` (top level) | `not_allowed` | dropped | Add-on Policies §6.3.2 forbid storing private-browsing data for listed add-ons. This is a **top-level** key: nesting it under `browser_specific_settings.gecko` is not in the schema, so Firefox logged a manifest warning and ignored it. |
| `browser_specific_settings.gecko.id` | required | dropped | Required to sign MV3 on AMO. |
| `minimum_chrome_version` | dropped | `121` | Meaningless to AMO, which warns on unknown keys. |
| `background.service_worker` / `background.scripts` | one each | one each | Firefox has no MV3 service worker (bug 1573659). |

Before packaging, `tools/build.mjs` also refuses to build when:

- the Firefox floor drops below 140 while the data collection key is present, or `incognito`
  goes missing — including a guard that rejects the invalid
  `browser_specific_settings.gecko.incognito` spelling;
- any of `content.js`, `background.js`, `popup.js` or `details.js` stops going through
  `shared/messaging.js` (or `popup.html` stops loading it), which would leave that context
  unable to reach the background on one of the two engines;
- any message catalog violates the contract listed in [Localization](#-localization).

---

## 📄 License

This project is licensed under the **[MIT License](LICENSE)** - see the [LICENSE](LICENSE) file for details.

