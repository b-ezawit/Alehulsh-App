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
  private readonly hits = new Map<string, number[]>();

  async hit(key: string, cap: number, windowMs: number) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    kept.push(now);
    this.hits.set(key, kept);

    // Bounded cleanup so a long-lived process does not accumulate a key per
    // user who ever called. Only runs when the map is already large.
    if (this.hits.size > 10_000) {
      for (const [k, times] of this.hits) {
        if (times.every((t) => t <= cutoff)) this.hits.delete(k);
      }
    }
    return { allowed: kept.length <= cap, count: kept.length };
  }
}
