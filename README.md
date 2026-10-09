# YTMusic Counter - Firefox Extension

A lightweight, privacy-friendly Firefox WebExtension (Manifest V3) that tracks and counts your music listening stats on [YouTube Music](https://music.youtube.com).

---

## 🎯 Key Features

1. **Per-Song Player Badge**: Directly on YouTube Music's player bar, you see how many times you have listened to the currently playing song (e.g. `🎵 5 plays`).
2. **Aggregated Grouped Counters**:
   - **Songs**: Lifetime play count per unique track.
   - **Artists**: Lifetime plays aggregated across all songs by that artist (including collaborations).
   - **Albums**: Counts how many times you have listened to a full album **from start to finish** without skipping.
3. **Optimized Storage**: Uses compact $O(1)$ dictionary key-value maps. Zero bloat, no unbounded chronological histories, and negligible memory footprint (< 400 KB even after years of continuous listening).
4. **No Build Step Required**: Pure WebExtensions (Manifest V3) JavaScript, CSS, and HTML. A release packager (`tools/build.mjs`) copies the served files and strips the manifest keys each browser does not implement — see [Building for Release](#-building-for-release).
5. **Full Details Page & Config**: Dedicated tab view with a "Totals Song Listened" hero row and a Config tab featuring a safe 3-step confirmation data wipe.
6. **Automated History Scanner**: Scans `music.youtube.com/history` with auto-scrolling to extract past listening history and batch-import all tracks, plays, and artists into your extension stats.

---

## 📁 Project Structure

```text
ytmusic-counter/
├── manifest.json              # WebExtension MV3 metadata, single source for both stores
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
│   └── page-context.js        # MAIN-world ytcfg bridge, via postMessage
├── details/
│   ├── details.html           # Statistics & configuration page
│   ├── details.css            # Dark theme dashboard styling
│   └── details.js             # Tab logic, stats sync, config, 3-step data wipe
├── popup/
│   ├── popup.html             # Toolbar popup: Songs / Artists / Albums
│   ├── popup.css              # Dark theme styling (YouTube Music aesthetic)
│   └── popup.js               # Ranked lists & live counters
├── icons/                     # 16/32/48/128 PNG icons
├── tools/build.mjs            # Release packager (Chrome + Firefox bundles)
├── tests/                     # node:test unit suite
├── PRIVACY.md                 # Privacy policy (also used for both store listings)
└── README.md                  # This file
```

`shared/browse-parse.js` is loaded twice on purpose: once as an ES module by the
background, and once as a classic script in the isolated content-script world, so both share
one implementation of the browse-response parsing.

`shared/messaging.js` follows the same pattern and exists because the two engines do not
accept each other's calling convention: `chrome.*` is callback-only, while `browser.*` is
promise-only and **throws** if handed a callback. Every `sendMessage` therefore goes through
this helper, which picks the convention the host engine accepts.

---

## 🚀 How to Install and Test in Firefox

### 1. Open Firefox Debugging Page
In Firefox, enter the following URL in the address bar:
```text
about:debugging#/runtime/this-firefox
```

### 2. Build the Firefox bundle
```bash
npm run build:firefox   # -> dist/firefox/
```

### 3. Load the Extension
1. Under **Temporary Extensions**, click **"Load Temporary Add-on..."**.
2. Browse to **`dist/firefox/`** and select **`manifest.json`**, then click **Open**.

> Load `dist/firefox/manifest.json`, **not** the one in the project root. The root manifest
> is the cross-platform source and still carries `background.service_worker`, which Firefox
> does not implement; the bundle is the one the packager produced for this browser.

> After reloading the add-on, **reload your `music.youtube.com` tab** as well. Firefox
> injects content scripts on page load, so a tab left open keeps running the previous
> version.

---

## 🎧 Testing the Features

1. Open **[https://music.youtube.com](https://music.youtube.com)**.
2. Play any song:
   - Notice the player badge next to the volume controls immediately shows: `🎵 0 plays` (or previous count).
   - After listening for at least 5 seconds, the count increments by 1 with a subtle pulse animation.
3. Click the **YTMusic Counter** icon in your Firefox toolbar:
   - View your **Total Plays**, **Unique Songs**, **Unique Artists**, and **Full Albums** completed.
   - Switch between the **Top Songs**, **Artists**, and **Full Albums** tabs.
   - Check the **Now Playing** card displaying the active song's play count.

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

## ⚖️ Disclaimer & Trademark Notice

YouTube and YouTube Music are registered trademarks of Google LLC. 

**YTMusic Counter** is an independent, open-source project and is not affiliated with, endorsed by, sponsored by, or connected to Google LLC, YouTube, or Alphabet Inc.

---

## 📦 Building for Release

There is no bundler and no transpiler. `tools/build.mjs` copies the served files and
drops the manifest keys each browser does not implement, producing two uploadable
archives in `dist/`:

```bash
npm run build           # both targets
npm run build:chrome    # -> dist/chrome-1.1.0.zip
npm run build:firefox   # -> dist/firefox-1.1.0.zip
```

Nothing is minified or concatenated, so the uploaded code is byte-identical to the
source above and both stores accept it without a separate source-code submission.
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
| `background.service_worker` / `background.scripts` | one each | one each | Firefox has no MV3 service worker (bug 1573659). |

`tools/build.mjs` refuses to build if the Firefox floor drops below 140 while the data
collection key is present, or if `incognito` goes missing — including a guard that
rejects the invalid `browser_specific_settings.gecko.incognito` spelling.

---

## 📄 License

This project is licensed under the **[MIT License](LICENSE)** - see the [LICENSE](LICENSE) file for details.

