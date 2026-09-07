/** A rolling-window limiter with lazy expiry and a hard bound on stored keys. */
export class BoundedRateLimiter {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number
  ) {}

  get size(): number {
    return this.entries.size;
  }

  consume(key: string, now = Date.now()): boolean {
    // Accepted hits move their key to the end, ordering expiry by last hit.
    for (const [storedKey, times] of this.entries) {
      if (now - times[times.length - 1] < this.windowMs) break;
      this.entries.delete(storedKey);
    }

    const existing = this.entries.get(key);
    const times = (existing ?? []).filter((time) => now - time < this.windowMs);
    if (times.length >= this.limit) return false;
    // Never evict active keys to admit new ones: that would reset limits.
    if (!existing && this.entries.size >= this.maxKeys) return false;
    times.push(now);
    this.entries.delete(key);
    this.entries.set(key, times);
    return true;
  }
}
