import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAVORITES_LIMIT,
  FAVORITES_STORAGE_KEY,
  FavoritesStore,
  favoriteViewFromHash,
  normalizeFavoriteName,
  parseStoredFavorites,
} from './favorites.js';

const HASH =
  'v=2&lat=40.7484&lon=-73.9857&alt=620&heading=12&pitch=-28&roll=0&style=normal&map=photoreal';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('favoriteViewFromHash reads the share-link camera pose', () => {
  assert.deepEqual(favoriteViewFromHash(`#${HASH}`), {
    lat: 40.7484,
    lon: -73.9857,
    alt: 620,
    heading: 12,
    pitch: -28,
    roll: 0,
  });
});

test('favoriteViewFromHash rejects missing or impossible coordinates', () => {
  assert.equal(favoriteViewFromHash(''), null);
  assert.equal(favoriteViewFromHash('lat=1'), null);
  assert.equal(favoriteViewFromHash('lat=Infinity&lon=2'), null);
  assert.equal(favoriteViewFromHash('lat=91&lon=2'), null);
  assert.deepEqual(favoriteViewFromHash('lat=1&lon=2'), {
    lat: 1,
    lon: 2,
    alt: 800,
    heading: 0,
    pitch: -35,
    roll: 0,
  });
});

test('normalizeFavoriteName trims, collapses and caps', () => {
  assert.equal(normalizeFavoriteName('  Golden\n  Gate  '), 'Golden Gate');
  assert.equal(normalizeFavoriteName('   '), '');
  assert.equal(normalizeFavoriteName('x'.repeat(80)).length, 40);
});

test('saving, listing and deleting persist across store instances', () => {
  const storage = memoryStorage();
  const store = new FavoritesStore({ storage, now: () => 1000 });
  const saved = store.add('Empire State', `#${HASH}`);
  assert.equal(saved.ok, true);
  assert.equal(saved.persisted, true);
  assert.equal(saved.favorite.hash, HASH);

  const reloaded = new FavoritesStore({ storage });
  assert.deepEqual(
    reloaded.list().map((entry) => entry.name),
    ['Empire State'],
  );
  assert.equal(reloaded.remove(saved.favorite.id).ok, true);
  assert.deepEqual(new FavoritesStore({ storage }).list(), []);
});

test('ids stay unique when two views are saved in the same millisecond', () => {
  const store = new FavoritesStore({
    storage: memoryStorage(),
    now: () => 5,
  });
  const a = store.add('A', HASH).favorite.id;
  const b = store.add('B', HASH).favorite.id;
  assert.notEqual(a, b);
});

test('add refuses empty names, unusable views and a full list', () => {
  const store = new FavoritesStore({ storage: memoryStorage() });
  assert.deepEqual(store.add('  ', HASH), { ok: false, reason: 'empty-name' });
  assert.deepEqual(store.add('Nowhere', 'style=nvg'), {
    ok: false,
    reason: 'invalid-view',
  });
  for (let i = 0; i < FAVORITES_LIMIT; i += 1)
    assert.equal(store.add(`View ${i}`, HASH).ok, true);
  assert.deepEqual(store.add('One more', HASH), { ok: false, reason: 'full' });
});

test('blocked storage keeps favorites working in memory', () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  const store = new FavoritesStore({ storage: throwing });
  assert.equal(store.persistent, false);
  const saved = store.add('Private', HASH);
  assert.equal(saved.ok, true);
  assert.equal(saved.persisted, false);
  assert.equal(store.list().length, 1);
  assert.equal(store.remove(saved.favorite.id).ok, true);

  const none = new FavoritesStore({ storage: null });
  assert.equal(none.add('No storage', HASH).persisted, false);
});

test('a quota error on write is reported, not thrown', () => {
  const storage = memoryStorage();
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const store = new FavoritesStore({ storage });
  assert.equal(store.add('Full disk', HASH).persisted, false);
  assert.equal(store.persistent, false);
});

test('corrupt or hostile stored data is dropped entry by entry', () => {
  assert.deepEqual(parseStoredFavorites('not json'), []);
  assert.deepEqual(parseStoredFavorites('{"favorites":"nope"}'), []);
  const storage = memoryStorage({
    [FAVORITES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      favorites: [
        { id: 'a', name: 'Good', hash: HASH, createdAt: 1 },
        { id: 'a', name: 'Duplicate id', hash: HASH },
        { id: 'b', name: '', hash: HASH },
        { id: 'c', name: 'No coords', hash: 'style=nvg' },
        { id: 'd', name: 'Huge', hash: `${HASH}&x=${'y'.repeat(5000)}` },
        null,
        'string',
      ],
    }),
  });
  assert.deepEqual(
    new FavoritesStore({ storage }).list().map((entry) => entry.id),
    ['a'],
  );
});
