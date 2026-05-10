import { Router } from "express";
import { feedbackRepo } from "../services/feedbackRepo.js";
import { analysisQueue } from "../workers/analysisQueue.js";

const router = Router();

/**
 * POST /feedback
 * Submit new feedback for analysis.
 */
router.post("/", async (req, res) => {
  const { content } = req.body;

  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "content must be a non-empty string" });
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return res.status(400).json({ error: "content must not be blank" });
  }
  if (trimmed.length > 10_000) {
    return res
      .status(400)
      .json({ error: "content exceeds 10,000 character limit" });
  }

  try {
    const feedback = await feedbackRepo.create(trimmed);

    // Enqueue async analysis — does NOT block this response
    analysisQueue.enqueue(feedback.id);

    return res.status(202).json({
      id: feedback.id,
      status: feedback.status,
      created_at: feedback.created_at,
    });
  } catch (err) {
    console.error("POST /feedback error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /feedback
 * List feedback with optional filtering and pagination.
 *
 * Query params:
 *   - status: RECEIVED | ANALYZING | DONE | FAILED
 *   - limit: number (default 20, max 100)
 *   - offset: number (default 0)
 */
router.get("/", async (req, res) => {
  const VALID_STATUSES = new Set(["RECEIVED", "ANALYZING", "DONE", "FAILED"]);
  const { status } = req.query;

  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json({
      error: `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
    });
  }

  const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset ?? "0", 10) || 0, 0);

  try {
    const { items, total } = await feedbackRepo.list({ limit, offset, status });
    return res.json({
      total,
      limit,
      offset,
      items,
    });
  } catch (err) {
    console.error("GET /feedback error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /feedback/:id
 * Get a single feedback item with its analysis result.
 */
router.get("/:id", async (req, res) => {
  try {
    const item = await feedbackRepo.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Feedback not found" });
    }
    return res.json(item);
  } catch (err) {
    console.error("GET /feedback/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /feedback/:id/retry
 * Retry analysis for a FAILED feedback item.
 */
router.post("/:id/retry", async (req, res) => {
  try {
    const item = await feedbackRepo.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Feedback not found" });
    }
    if (item.status !== "FAILED") {
      return res
        .status(409)
        .json({ error: `Cannot retry feedback with status '${item.status}'` });
    }

    await feedbackRepo.setStatus(item.id, "RECEIVED");
    analysisQueue.enqueue(item.id);

    return res.json({ id: item.id, status: "RECEIVED", message: "Queued for retry" });
  } catch (err) {
    console.error("POST /feedback/:id/retry error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;