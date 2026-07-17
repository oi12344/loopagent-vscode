import { describe, expect, it } from "vitest";

import { createLruCache } from "../../src/extension/intelligence/util/lruCache";

describe("createLruCache", () => {
  it("evicts the least recently used entry once maxEntries is exceeded", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("treats get as a recency touch so recently read entries survive eviction", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("treats set on an existing key as a recency touch too", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);

    expect(cache.get("a")).toBe(10);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("matches Map semantics for get/has/delete/keys", () => {
    const cache = createLruCache<string, number>(10);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("missing")).toBe(false);
    expect(cache.delete("missing")).toBe(false);

    cache.set("x", 1);
    cache.set("y", 2);
    expect([...cache.keys()]).toEqual(["x", "y"]);
    expect(cache.delete("x")).toBe(true);
    expect([...cache.keys()]).toEqual(["y"]);
  });
});
