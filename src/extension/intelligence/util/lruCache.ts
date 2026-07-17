export type LruCache<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  has(key: K): boolean;
  keys(): IterableIterator<K>;
};

// Backed by Map's insertion-order iteration: re-inserting a key on access/write
// moves it to the "most recently used" end, so the oldest key via keys().next()
// is always the least recently used.
export function createLruCache<K, V>(maxEntries: number): LruCache<K, V> {
  const map = new Map<K, V>();

  return {
    get(key) {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete: (key) => map.delete(key),
    has: (key) => map.has(key),
    keys: () => map.keys(),
  };
}
