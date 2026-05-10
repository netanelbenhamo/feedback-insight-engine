/**
 * In-process async queue for AI analysis jobs.
 *
 * Design: a simple async FIFO using a Promise chain so only one analysis runs
 * at a time per process. This is intentionally simple — in production you'd use
 * BullMQ + Redis for durability, retries, and horizontal scaling.
 *
 * Tradeoff: Jobs pending in-memory are lost on process restart. Acceptable for
 * a 3-hour timebox; documented in README.
 */

import { analyzeWithAI } from "../services/aiService.js";
import { feedbackRepo, analysisRepo } from "../services/feedbackRepo.js";
import { aiRateLimiter } from "../lib/rateLimiter.js";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

class AnalysisQueue {
  constructor() {
    /** @type {Array<{ feedbackId: string, attempt: number }>} */
    this._queue = [];
    this._running = false;
  }

  enqueue(feedbackId) {
    this._queue.push({ feedbackId, attempt: 1 });
    this._drain();
  }

  _drain() {
    if (this._running) return;
    this._running = true;
    // Detach from the call stack so the HTTP response returns immediately
    setImmediate(() => this._processNext());
  }

  async _processNext() {
    const job = this._queue.shift();
    if (!job) {
      this._running = false;
      return;
    }

    try {
      await this._process(job);
    } catch (err) {
      // Unexpected error in the runner itself — log and continue
      console.error(`[queue] Unexpected runner error for ${job.feedbackId}:`, err);
    }

    // Process next job
    setImmediate(() => this._processNext());
  }

  async _process({ feedbackId, attempt }) {
    console.log(`[queue] Processing feedback ${feedbackId} (attempt ${attempt})`);

    // Check rate limit before touching the AI
    const { allowed, retryAfterMs } = aiRateLimiter.try();
    if (!allowed) {
      console.warn(
        `[queue] Rate limit hit for ${feedbackId}. Retrying in ${retryAfterMs}ms`
      );
      // Re-queue after the window resets if we haven't exceeded retries
      if (attempt <= MAX_RETRIES) {
        setTimeout(() => {
          this._queue.unshift({ feedbackId, attempt: attempt + 1 });
          if (!this._running) this._drain();
        }, retryAfterMs);
      } else {
        await this._fail(feedbackId, "Rate limit exceeded after max retries");
      }
      return;
    }

    // Mark as ANALYZING
    await feedbackRepo.setStatus(feedbackId, "ANALYZING");

    try {
      const result = await analyzeWithAI(
        // Fetch fresh content from DB (avoid stale closure over old content)
        await getFeedbackContent(feedbackId)
      );

      if (result.validationError) {
        // AI responded but output was invalid
        await analysisRepo.upsert({
          feedbackId,
          raw: result.raw,
          structured: null,
          errorMessage: result.validationError,
        });
        await feedbackRepo.setStatus(feedbackId, "FAILED");
        console.warn(`[queue] Validation failed for ${feedbackId}: ${result.validationError}`);
        return;
      }

      // Success
      await analysisRepo.upsert({
        feedbackId,
        raw: result.raw,
        structured: result.data,
        errorMessage: null,
      });
      await feedbackRepo.setStatus(feedbackId, "DONE");
      console.log(`[queue] ✅ Done for ${feedbackId}`);
    } catch (err) {
      console.error(`[queue] AI call failed for ${feedbackId} (attempt ${attempt}):`, err.message);

      if (attempt < MAX_RETRIES) {
        // Exponential backoff retry
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`[queue] Retrying ${feedbackId} in ${delay}ms...`);
        setTimeout(() => {
          this._queue.unshift({ feedbackId, attempt: attempt + 1 });
          if (!this._running) this._drain();
        }, delay);
      } else {
        await this._fail(feedbackId, err.message);
      }
    }
  }

  async _fail(feedbackId, reason) {
    await analysisRepo.upsert({
      feedbackId,
      raw: null,
      structured: null,
      errorMessage: reason,
    });
    await feedbackRepo.setStatus(feedbackId, "FAILED");
    console.error(`[queue] ❌ Failed ${feedbackId}: ${reason}`);
  }
}

async function getFeedbackContent(feedbackId) {
  const row = await feedbackRepo.findById(feedbackId);
  if (!row) throw new Error(`Feedback ${feedbackId} not found in DB`);
  return row.content;
}

export const analysisQueue = new AnalysisQueue();