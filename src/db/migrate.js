import "dotenv/config";
import pool from "./pool.js";

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS feedback (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'RECEIVED'
                  CHECK (status IN ('RECEIVED','ANALYZING','DONE','FAILED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS analysis (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_id      UUID NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    raw_response     TEXT,
    structured_result JSONB,
    error_message    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Index for listing feedback efficiently
  CREATE INDEX IF NOT EXISTS idx_feedback_status     ON feedback(status);
  CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_feedback_id_unique ON analysis(feedback_id);
  CREATE INDEX IF NOT EXISTS idx_analysis_feedback_id ON analysis(feedback_id);

  -- Trigger to auto-update updated_at on feedback
  CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_feedback_updated_at ON feedback;
  CREATE TRIGGER trg_feedback_updated_at
    BEFORE UPDATE ON feedback
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  DROP TRIGGER IF EXISTS trg_analysis_updated_at ON analysis;
  CREATE TRIGGER trg_analysis_updated_at
    BEFORE UPDATE ON analysis
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Running migrations...");
    await client.query(MIGRATION);
    console.log("✅ Migrations complete.");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();