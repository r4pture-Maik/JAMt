/**
 * JAMt - Lightweight Local Thumbnail Database & Cache
 * Uses IndexedDB to store downscaled (128x128 WebP) album covers.
 * Provides in-memory Object URL caching for instant, zero-flicker UI painting.
 * Native ES module with globalThis fallback.
 */

const DB_NAME = 'ytm_media_cache';
const DB_VERSION = 1;
const STORE_NAME = 'album_covers';
const TARGET_SIZE = 128;
const WEBP_QUALITY = 0.8;
const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let dbPromise = null;
const memoryUrlMap = new Map(); // albumKey -> objectUrl
const failedKeyMap = new Map(); // albumKey -> timestamp of the last failure
const pendingFetches = new Map(); // albumKey -> Promise

/**
 * Negative-cache lookups must expire, otherwise a single transient network
 * failure permanently hides an album's cover for the rest of the session.
 *
 * @param {string} albumKey
 * @returns {boolean}
 */
function isNegativeCached(albumKey) {
  if (!albumKey) return false;
  const failedAt = failedKeyMap.get(albumKey);
  if (failedAt === undefined) return false;
  if (Date.now() - failedAt >= NEGATIVE_CACHE_TTL_MS) {
    failedKeyMap.delete(albumKey);
    return false;
  }
  return true;
}

/**
 * Opens or upgrades the IndexedDB database.
 * Singleton Promise prevents parallel open calls.
 */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const globalObj = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
    const indexedDB = globalObj.indexedDB || globalObj.mozIndexedDB || globalObj.webkitIndexedDB;
    if (!indexedDB) {
      return reject(new Error('IndexedDB not supported in this environment'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'albumKey' });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = (event) => {
      dbPromise = null;
      reject(event.target.error);
    };
  });

  return dbPromise;
}

/**
 * Retrieves a record from IndexedDB by albumKey.
 */
export async function getRecord(albumKey) {
  if (!albumKey) return null;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(albumKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ThumbnailCache] Error reading record for', albumKey, err);
    return null;
  }
}

/**
 * Stores a record in IndexedDB.
 */
export async function putRecord(record) {
  if (!record || !record.albumKey) return;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ThumbnailCache] Error storing record for', record.albumKey, err);
  }
}

/**
 * Resizes an image Blob into 128x128 WebP blob using OffscreenCanvas or HTML Canvas
 */
export async function downscaleImageBlob(sourceBlob) {
  if (typeof createImageBitmap !== 'function') return sourceBlob;

  let imgBitmap;
  try {
    imgBitmap = await createImageBitmap(sourceBlob);
  } catch (_) {
    return sourceBlob;
  }

  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(TARGET_SIZE, TARGET_SIZE);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;
  } else {
    if (typeof imgBitmap.close === 'function') imgBitmap.close();
    return sourceBlob;
  }

  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return sourceBlob;

    // Centre-crop to a square before downscaling. The previous 5-argument
    // drawImage() stretched non-square covers into 128x128, distorting them.
    const sourceW = imgBitmap.width || TARGET_SIZE;
    const sourceH = imgBitmap.height || TARGET_SIZE;
    const side = Math.min(sourceW, sourceH);
    const sx = Math.floor((sourceW - side) / 2);
    const sy = Math.floor((sourceH - side) / 2);

    ctx.drawImage(
      imgBitmap,
      sx, sy, side, side,
      0, 0, TARGET_SIZE, TARGET_SIZE
    );

    if (typeof canvas.convertToBlob === 'function') {
      return await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
    }
    if (typeof canvas.toBlob === 'function') {
      return await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b || sourceBlob), 'image/webp', WEBP_QUALITY);
      });
    }
    return sourceBlob;
  } catch (err) {
    console.warn('[ThumbnailCache] Downscale failed, storing original blob:', err);
    return sourceBlob;
  } finally {
    if (typeof imgBitmap.close === 'function') imgBitmap.close();
  }
}

/**
 * Fetches remote image, downscales it, and caches in IndexedDB
 */
export async function cacheRemoteThumbnail(albumKey, remoteUrl) {
  if (!albumKey || !remoteUrl) return null;
  if (pendingFetches.has(albumKey)) {
    return pendingFetches.get(albumKey);
  }

  const fetchPromise = (async () => {
    try {
      const response = await fetch(remoteUrl, { mode: 'cors' });
      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}`);
      }
      const rawBlob = await response.blob();
      let optimizedBlob = rawBlob;
      try {
        optimizedBlob = await downscaleImageBlob(rawBlob);
      } catch (downscaleErr) {
        console.warn('[ThumbnailCache] Downscaling failed, storing original blob:', downscaleErr);
      }

      const record = {
        albumKey,
        blob: optimizedBlob,
        cachedAt: Date.now()
      };
      await putRecord(record);

      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        const objectUrl = URL.createObjectURL(optimizedBlob);
        memoryUrlMap.set(albumKey, objectUrl);
        return objectUrl;
      }
      return null;
    } catch (err) {
      console.warn('[ThumbnailCache] Remote fetch failed for', albumKey, err);
      failedKeyMap.set(albumKey, Date.now());
      return null;
    } finally {
      pendingFetches.delete(albumKey);
    }
  })();

  pendingFetches.set(albumKey, fetchPromise);
  return fetchPromise;
}

/**
 * Returns memory object URL if already converted, else null
 */
export function getMemoryObjectUrl(albumKey) {
  return memoryUrlMap.get(albumKey) || null;
}

/**
 * Retrieves cached object URL from memory or IndexedDB
 */
export async function getThumbnailObjectUrl(albumKey) {
  if (!albumKey) return null;
  if (memoryUrlMap.has(albumKey)) {
    return memoryUrlMap.get(albumKey);
  }
  if (isNegativeCached(albumKey)) {
    return null;
  }

  const record = await getRecord(albumKey);
  if (!record || !record.blob) {
    return null;
  }

  if (typeof URL !== 'undefined' && URL.createObjectURL) {
    const objectUrl = URL.createObjectURL(record.blob);
    memoryUrlMap.set(albumKey, objectUrl);
    return objectUrl;
  }
  return null;
}

export async function markThumbnailFailed(albumKey) {
  if (!albumKey) return;
  failedKeyMap.set(albumKey, Date.now());
}

export function isThumbnailFailed(albumKey) {
  return isNegativeCached(albumKey);
}

export async function clearThumbnailCache() {
  revokeAllObjectUrls();
  failedKeyMap.clear();
  pendingFetches.clear();

  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve({ cleared: true });
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[ThumbnailCache] Error clearing store:', err);
    return { cleared: false, error: err.message };
  }
}

/**
 * Tallies the cover cache by walking every stored record.
 *
 * The payload carries raw numbers only: the UI formats the size through
 * `YTMCI18n.formatBytes`, so the background never produces user-facing text.
 *
 * @returns {Promise<{count: number, totalBytes: number, bytes: number,
 *   error?: string}>} Cache tallies; `bytes` mirrors `totalBytes`.
 */
export async function getThumbnailStats() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let count = 0;
      let totalBytes = 0;

      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          count++;
          if (cursor.value && cursor.value.blob) {
            totalBytes += cursor.value.blob.size || 0;
          }
          cursor.continue();
        } else {
          resolve({ count, totalBytes, bytes: totalBytes });
        }
      };
      cursorReq.onerror = () => {
        resolve({ count: 0, totalBytes: 0, bytes: 0 });
      };
    });
  } catch (err) {
    return { count: 0, totalBytes: 0, bytes: 0, error: err.message };
  }
}

export function revokeAllObjectUrls() {
  for (const url of memoryUrlMap.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }
  memoryUrlMap.clear();
}

export const thumbnailCache = {
  openDB,
  getRecord,
  putRecord,
  downscaleImageBlob,
  cacheRemoteThumbnail,
  getMemoryObjectUrl,
  getThumbnailObjectUrl,
  markThumbnailFailed,
  isThumbnailFailed,
  clearThumbnailCache,
  getThumbnailStats,
  revokeAllObjectUrls
};

export default thumbnailCache;
