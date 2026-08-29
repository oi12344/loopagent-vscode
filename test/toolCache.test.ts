import { describe, it, expect, vi } from "vitest";
import { ToolResultCache } from "../src/extension/agent/toolCache";

describe("ToolResultCache", () => {
  describe("cacheKey", () => {
    it("same input generates same cache key", () => {
      const input = { query: "hello", limit: 10 };
      const key1 = ToolResultCache.cacheKey("readFile", input);
      const key2 = ToolResultCache.cacheKey("readFile", input);
      expect(key1).toBe(key2);
    });

    it("different input generates different cache key", () => {
      const key1 = ToolResultCache.cacheKey("readFile", { query: "hello" });
      const key2 = ToolResultCache.cacheKey("readFile", { query: "world" });
      expect(key1).not.toBe(key2);
    });

    it("key includes tool name", () => {
      const key = ToolResultCache.cacheKey("exploreCode", { path: "src/" });
      expect(key).toContain("exploreCode::");
    });

    it("key is stable regardless of property insertion order", () => {
      const input1 = { a: 1, b: 2 };
      const input2 = { b: 2, a: 1 };
      const key1 = ToolResultCache.cacheKey("tool", input1);
      const key2 = ToolResultCache.cacheKey("tool", input2);
      expect(key1).toBe(key2);
    });
  });

  describe("get / set / has", () => {
    it("returns entry after set", () => {
      const cache = new ToolResultCache();
      cache.set("key1", { content: "result", evidence: [], productive: true });
      const entry = cache.get("key1");
      expect(entry).toBeDefined();
      expect(entry!.content).toBe("result");
      expect(entry!.productive).toBe(true);
      expect(entry!.cachedAt).toBeTypeOf("number");
    });

    it("returns undefined for missing key", () => {
      const cache = new ToolResultCache();
      expect(cache.get("missing")).toBeUndefined();
    });

    it("has() returns true for existing key", () => {
      const cache = new ToolResultCache();
      cache.set("key1", { content: "x", evidence: [], productive: false });
      expect(cache.has("key1")).toBe(true);
    });

    it("has() returns false for missing key", () => {
      const cache = new ToolResultCache();
      expect(cache.has("missing")).toBe(false);
    });

    it("has() returns false for expired entry", () => {
      vi.useFakeTimers();
      const cache = new ToolResultCache({ ttlMs: 1000 });
      cache.set("key1", { content: "x", evidence: [], productive: true });
      vi.advanceTimersByTime(1001);
      expect(cache.has("key1")).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("TTL expiration", () => {
    it("returns undefined after TTL expires", () => {
      vi.useFakeTimers();
      const cache = new ToolResultCache({ ttlMs: 1000 });
      cache.set("key1", { content: "data", evidence: [], productive: true });

      // Not expired yet
      expect(cache.get("key1")).toBeDefined();

      // Advance past TTL
      vi.advanceTimersByTime(1001);
      expect(cache.get("key1")).toBeUndefined();
      vi.useRealTimers();
    });

    it("does not expire within TTL window", () => {
      vi.useFakeTimers();
      const cache = new ToolResultCache({ ttlMs: 5000 });
      cache.set("key1", { content: "data", evidence: [], productive: true });
      vi.advanceTimersByTime(4999);
      expect(cache.get("key1")).toBeDefined();
      vi.useRealTimers();
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when maxEntries exceeded", () => {
      const cache = new ToolResultCache({ maxEntries: 3 });
      cache.set("a", { content: "1", evidence: [], productive: true });
      cache.set("b", { content: "2", evidence: [], productive: true });
      cache.set("c", { content: "3", evidence: [], productive: true });

      // Adding a 4th should evict "a" (oldest)
      cache.set("d", { content: "4", evidence: [], productive: true });

      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
      expect(cache.size).toBe(3);
    });

    it("updating existing key does not trigger eviction", () => {
      const cache = new ToolResultCache({ maxEntries: 2 });
      cache.set("a", { content: "1", evidence: [], productive: true });
      cache.set("b", { content: "2", evidence: [], productive: true });

      // Update "a" - should not evict anything
      cache.set("a", { content: "1-updated", evidence: [], productive: true });

      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(true);
      expect(cache.size).toBe(2);
    });

    it("get() refreshes LRU order", () => {
      const cache = new ToolResultCache({ maxEntries: 3 });
      cache.set("a", { content: "1", evidence: [], productive: true });
      cache.set("b", { content: "2", evidence: [], productive: true });
      cache.set("c", { content: "3", evidence: [], productive: true });

      // Access "a" to refresh it
      cache.get("a");

      // Adding "d" should evict "b" (now oldest)
      cache.set("d", { content: "4", evidence: [], productive: true });

      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
    });
  });

  describe("clear", () => {
    it("empties the cache", () => {
      const cache = new ToolResultCache();
      cache.set("a", { content: "1", evidence: [], productive: true });
      cache.set("b", { content: "2", evidence: [], productive: true });
      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(false);
    });
  });
});
