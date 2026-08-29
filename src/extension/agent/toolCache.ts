export type CacheEntry = {
  content: string;
  evidence: unknown[];
  productive: boolean;
  cachedAt: number;
};

export type CacheStats = {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
};

export type ToolCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
};

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(options: ToolCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 100;
  }

  static cacheKey(toolName: string, input: unknown): string {
    const inputStr = JSON.stringify(input, Object.keys(input as object).sort());
    const hash = `${inputStr.length}:${inputStr.slice(0, 100)}`;
    return `${toolName}::${hash}`;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Move to end for LRU behavior
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  set(key: string, entry: Omit<CacheEntry, "cachedAt">): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { ...entry, cachedAt: Date.now() });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}
