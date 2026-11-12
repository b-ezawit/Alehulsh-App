/**
 * Swap point #4 of 4. See docs/api-layer.md.
 *
 * Rate limiting is deliberately NOT a repository method. The Firestore alert
 * collection is keyed by uid, so it holds only the current alert and cannot
 * answer "how many did she raise this hour" without a new collection — and
 * CLAUDE.md §28 is explicit that new Firestore architecture is the work that
 * gets thrown away at C-04. Keeping this behind its own interface means the
 * in-memory implementation below is replaced by Redis or a Postgres table
 * later without touching a route.
 */
export interface RateLimiter {
  /**
   * Records a hit against `key` and reports whether it is within `cap` for the
   * trailing `windowMs`. The refused hit is counted too, so a caller hammering
   * the endpoint cannot reset their own budget by failing.
   */
  hit(key: string, cap: number, windowMs: number): Promise<{ allowed: boolean; count: number }>;
}

/**
 * Per-process sliding window.
 *
 * Two honest limitations, neither of which matters for what this guards:
 *
 *   it is per-instance, so N replicas allow roughly N times the cap;
 *   it is lost on restart.
 *
 * Both are acceptable because the only thing on it is an abuse ceiling set far
 * above human behaviour. It must never be used for anything where exceeding
 * the limit is a safety or correctness problem rather than a cost one.
 */
export class InMemorySlidingWindowLimiter implements RateLimiter {
  private readonly hits = new Map<string, { buckets: Array<{ at: number; count: number }>; windowMs: number }>();
  constructor(private readonly maxKeys = 10_000, private readonly maxBuckets = 64) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || !Number.isSafeInteger(maxBuckets) || maxBuckets < 2) throw new Error('invalid limiter bounds');
  }
  /** Public aggregate counters contain no subjects or request data. */
  get usage() { return { keys: this.hits.size, buckets: [...this.hits.values()].reduce((n, v) => n + v.buckets.length, 0) }; }

  async hit(key: string, cap: number, windowMs: number) {
    if (!Number.isSafeInteger(cap) || cap < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('invalid limiter policy');
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry) {
      if (this.hits.size >= this.maxKeys) {
        // Each key expires using its own policy, not the incoming request's
        // possibly much shorter window. Never evict a still-limited identity.
        for (const [k, item] of this.hits) {
          if (item.buckets.every(b => b.at <= now - item.windowMs)) this.hits.delete(k);
        }
      }
      if (this.hits.size >= this.maxKeys) return { allowed: false, count: cap + 1 };
      entry = { buckets: [], windowMs }; this.hits.set(key, entry);
    }
    // Changing the policy cannot shorten a live key's accounting window.
    entry.windowMs = Math.max(entry.windowMs, windowMs);
    entry.buckets = entry.buckets.filter(b => b.at > now - entry!.windowMs);
    const last = entry.buckets.at(-1);
    if (last?.at === now) last.count = Math.min(Number.MAX_SAFE_INTEGER, last.count + 1);
    else entry.buckets.push({ at: now, count: 1 });
    if (entry.buckets.length > this.maxBuckets) {
      const first = entry.buckets.shift()!;
      // Coalesce at the later timestamp: accounting may expire later under
      // attack, but never earlier. Memory is bounded even for denied requests.
      entry.buckets[0]!.count = Math.min(Number.MAX_SAFE_INTEGER, entry.buckets[0]!.count + first.count);
    }
    const count = Math.min(Number.MAX_SAFE_INTEGER, entry.buckets.reduce((n, b) => n + b.count, 0));
    return { allowed: count <= cap, count };
  }
}
