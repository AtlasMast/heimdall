/**
 * Favorites — named saved views kept in this browser.
 *
 * A favorite is a share-link hash (the same `#lat=…&lon=…&l=…` string the
 * address bar carries) plus a name. Storing the hash rather than a bespoke
 * record means a favorite captures exactly what a share link captures, camera
 * pose and durable layer state included, and stays readable by the share-link
 * decoders as those evolve.
 *
 * Persistence is best effort: localStorage can be missing, blocked (private
 * windows, disabled site data) or full. Every access is guarded, and the store
 * keeps working in memory for the rest of the page's life when it cannot write.
 */

export const FAVORITES_STORAGE_KEY = 'heimdall.favorites.v1';
export const FAVORITES_LIMIT = 50;
export const FAVORITE_NAME_MAX = 40;
const HASH_MAX = 4096;

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Trim, collapse whitespace and cap a user-typed name; '' when nothing usable. */
export function normalizeFavoriteName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FAVORITE_NAME_MAX)
    .trim();
}

/**
 * Read the camera pose out of a share hash, or null when it has no usable
 * coordinates. Defaults mirror ShareLinkManager.parseInitialHash.
 * @param {string} hash - with or without the leading '#'
 * @returns {{lat:number, lon:number, alt:number, heading:number, pitch:number, roll:number}|null}
 */
export function favoriteViewFromHash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const num = (key, fallback) => {
    if (!params.has(key)) return fallback;
    const value = parseFloat(params.get(key));
    return Number.isFinite(value) ? value : fallback;
  };
  const lat = num('lat', NaN);
  const lon = num('lon', NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    alt: Math.max(1, num('alt', 800)),
    heading: num('heading', 0),
    pitch: num('pitch', -35),
    roll: num('roll', 0),
  };
}

function normalizeFavorite(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const name = normalizeFavoriteName(candidate.name);
  const hash =
    typeof candidate.hash === 'string' ? candidate.hash.replace(/^#/, '') : '';
  const id = typeof candidate.id === 'string' ? candidate.id : '';
  if (!name || !id || !hash || hash.length > HASH_MAX) return null;
  if (!favoriteViewFromHash(hash)) return null;
  const createdAt = Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : 0;
  return { id, name, hash, createdAt };
}

/** Parse the stored JSON, dropping anything malformed. Never throws. */
export function parseStoredFavorites(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed?.favorites) ? parsed.favorites : [];
  const seen = new Set();
  const favorites = [];
  for (const entry of entries) {
    const favorite = normalizeFavorite(entry);
    if (!favorite || seen.has(favorite.id)) continue;
    seen.add(favorite.id);
    favorites.push(favorite);
    if (favorites.length >= FAVORITES_LIMIT) break;
  }
  return favorites;
}

/** The saved-view list, persisted to localStorage when the browser allows it. */
export class FavoritesStore {
  constructor({
    storage = safeStorage(),
    now = () => Date.now(),
    key = FAVORITES_STORAGE_KEY,
  } = {}) {
    this.storage = storage;
    this.now = now;
    this.key = key;
    this._sequence = 0;
    this._persistent = !!storage;
    let raw = null;
    try {
      raw = storage?.getItem?.(key) ?? null;
    } catch {
      this._persistent = false;
    }
    this._favorites = parseStoredFavorites(raw);
  }

  /** False once the browser has refused a read or write. */
  get persistent() {
    return this._persistent;
  }

  list() {
    return this._favorites.map((favorite) => ({ ...favorite }));
  }

  get(id) {
    const favorite = this._favorites.find((entry) => entry.id === id);
    return favorite ? { ...favorite } : null;
  }

  /**
   * Save a view. Returns `{ok:false, reason}` for an empty name, an unusable
   * hash or a full list; otherwise the new favorite and whether it persisted.
   */
  add(name, hash) {
    if (this._favorites.length >= FAVORITES_LIMIT)
      return { ok: false, reason: 'full' };
    const createdAt = this.now();
    const favorite = normalizeFavorite({
      id: `fav-${createdAt.toString(36)}-${(this._sequence++).toString(36)}`,
      name,
      hash,
      createdAt,
    });
    if (!favorite)
      return {
        ok: false,
        reason: normalizeFavoriteName(name) ? 'invalid-view' : 'empty-name',
      };
    this._favorites = [...this._favorites, favorite];
    return { ok: true, favorite: { ...favorite }, persisted: this._write() };
  }

  /** Delete by id. Returns whether anything was removed and whether it persisted. */
  remove(id) {
    const next = this._favorites.filter((entry) => entry.id !== id);
    if (next.length === this._favorites.length)
      return { ok: false, persisted: this._persistent };
    this._favorites = next;
    return { ok: true, persisted: this._write() };
  }

  _write() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({ version: 1, favorites: this._favorites }),
      );
      this._persistent = true;
      return true;
    } catch {
      this._persistent = false;
      return false;
    }
  }
}
