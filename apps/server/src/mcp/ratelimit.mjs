// Token bucket per key (the person's `sub`), in memory. One process, so no shared state needed;
// a restart refills everyone, which is fine for an abuse guard.

export class TokenBuckets {
  constructor({ burst, perMinute, now = () => Date.now() }) {
    this.burst = burst;
    this.refillPerMs = perMinute / 60_000;
    this.now = now;
    this.buckets = new Map();
  }

  // → { ok: true } or { ok: false, retryAfterSeconds }
  take(key, cost = 1) {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * this.refillPerMs);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens >= cost) { b.tokens -= cost; return { ok: true }; }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - b.tokens) / this.refillPerMs / 1000)) };
  }

  // Drop buckets that have been full for a while (nothing to remember about them).
  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.refillPerMs >= this.burst) this.buckets.delete(k);
    }
  }
}
