/**
 * Simple in-memory sliding-window rate limiter for AI analysis calls.
 *
 * Guardrail choice: Rate-limit AI analysis.
 *
 * Why rate limiting over the alternatives?
 * - Deduplication (hash-based) doesn't protect against high-volume unique feedback.
 * - Caching only helps for repeated identical inputs.
 * - Token truncation is a content concern, not a throughput concern.
 * - Rate limiting is the most broadly protective guardrail: it caps runaway costs
 *   (Anthropic API is metered), prevents abuse regardless of uniqueness, and is
 *   trivially observable and adjustable without schema changes.
 *
 * Tradeoff: In-memory state is lost on restart. For production, use Redis.
 * The limiter is per-process and not distributed-safe.
 */

const WINDOW_MS = 60_000; // 1 minute

export class RateLimiter {
  constructor(maxPerWindow = 10) {
    this.maxPerWindow = maxPerWindow;
    /** @type {number[]} timestamps of recent calls */
    this.calls = [];
  }

  /**
   * Attempt to consume one slot.
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  try() {
    const now = Date.now();
    // Drop timestamps outside the sliding window
    this.calls = this.calls.filter((t) => now - t < WINDOW_MS);

    if (this.calls.length >= this.maxPerWindow) {
      // Earliest call in window; retry after it ages out
      const oldest = this.calls[0];
      const retryAfterMs = WINDOW_MS - (now - oldest);
      return { allowed: false, retryAfterMs };
    }

    this.calls.push(now);
    return { allowed: true };
  }

  get remaining() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < WINDOW_MS);
    return Math.max(0, this.maxPerWindow - this.calls.length);
  }
}

// Singleton shared across the process
const limit = parseInt(process.env.AI_RATE_LIMIT_PER_MINUTE ?? "10", 10);
export const aiRateLimiter = new RateLimiter(limit);