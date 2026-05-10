import "dotenv/config";
import express from "express";
import feedbackRoutes from "./routes/feedback.js";
import pool from "./db/pool.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));

// Simple request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/feedback", feedbackRoutes);

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "unreachable" });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 feedback-insight-engine listening on http://localhost:${PORT}`);
  console.log(`   POST /feedback       — submit feedback`);
  console.log(`   GET  /feedback       — list feedback`);
  console.log(`   GET  /feedback/:id   — get single item`);
  console.log(`   POST /feedback/:id/retry — retry failed analysis`);
  console.log(`   GET  /health         — health check`);
});

export default app;