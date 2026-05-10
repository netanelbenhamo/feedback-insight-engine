import { query } from "../db/pool.js";

export const feedbackRepo = {
  async create(content) {
    const { rows } = await query(
      `INSERT INTO feedback (content) VALUES ($1) RETURNING *`,
      [content]
    );
    return rows[0];
  },

  async setStatus(id, status) {
    const { rows } = await query(
      `UPDATE feedback SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return rows[0];
  },

  async list({ limit = 20, offset = 0, status } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push(`f.status = $${params.length + 1}`);
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT
         f.id,
         f.content,
         f.status,
         f.created_at,
         f.updated_at,
         a.structured_result,
         a.error_message
       FROM feedback f
       LEFT JOIN analysis a ON a.feedback_id = f.id
       ${where}
       ORDER BY f.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM feedback f ${where}`,
      conditions.length ? params.slice(0, -2) : []
    );

    return { items: rows, total: parseInt(countRows[0].count, 10) };
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT
         f.*,
         a.raw_response,
         a.structured_result,
         a.error_message
       FROM feedback f
       LEFT JOIN analysis a ON a.feedback_id = f.id
       WHERE f.id = $1`,
      [id]
    );
    return rows[0] ?? null;
  },
};

export const analysisRepo = {
  async upsert({ feedbackId, raw, structured, errorMessage }) {
    await query(
      `INSERT INTO analysis (feedback_id, raw_response, structured_result, error_message)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (feedback_id)
       DO UPDATE SET
         raw_response     = EXCLUDED.raw_response,
         structured_result = EXCLUDED.structured_result,
         error_message    = EXCLUDED.error_message,
         updated_at       = NOW()`,
      [
        feedbackId,
        raw ?? null,
        structured ? JSON.stringify(structured) : null,
        errorMessage ?? null,
      ]
    );
  },
};