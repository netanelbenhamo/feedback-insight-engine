# feedback-insight-engine

A backend service that accepts free-text feedback and asynchronously extracts structured insights using an LLM (Claude via Anthropic API).

---

## Setup

### Prerequisites
- Node.js 20+
- Docker (for Postgres)

### Steps

```bash
# 1. Clone and install
git clone <repo>
cd feedback-insight-engine
npm install

# 2. Start Postgres
docker-compose up -d

# 3. Configure environment
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY

# 4. Run migrations
npm run migrate

# 5. Start the server
npm start
# or for auto-reload: npm run dev
```

Server starts on `http://localhost:3000` by default.

---

## API

### `POST /feedback`
Submit feedback for analysis. Returns immediately (202) while analysis runs async.

**Request:**
```json
{ "content": "Your feedback text here" }
```

**Response (202):**
```json
{
  "id": "uuid",
  "status": "RECEIVED",
  "created_at": "2025-01-01T00:00:00Z"
}
```

---

### `GET /feedback`
List all feedback with analysis results.

**Query params:**
- `status` — filter by `RECEIVED | ANALYZING | DONE | FAILED`
- `limit` — max results (default 20, max 100)
- `offset` — pagination offset

**Response:**
```json
{
  "total": 42,
  "limit": 20,
  "offset": 0,
  "items": [
    {
      "id": "uuid",
      "content": "...",
      "status": "DONE",
      "created_at": "...",
      "updated_at": "...",
      "structured_result": {
        "sentiment": "positive",
        "feature_requests": [{ "title": "Dark mode", "confidence": 0.95 }],
        "actionable_insight": "Prioritize dark mode in next sprint."
      },
      "error_message": null
    }
  ]
}
```

---

### `GET /feedback/:id`
Get a single feedback item including raw AI response.

---

### `POST /feedback/:id/retry`
Retry analysis for a `FAILED` feedback item. Returns 409 if the item isn't in FAILED state.

---

### `GET /health`
Returns `{ status: "ok", db: "connected" }` (503 if DB unreachable).

---

## Design Decisions & Tradeoffs

### Async Queue: In-Process vs External
**Choice:** In-process FIFO queue using `setImmediate` + a Promise chain.

**Why:** For a 3-hour timebox this avoids Redis/BullMQ operational overhead while meeting the "non-blocking submission" requirement. The queue serializes one analysis at a time, which pairs naturally with the rate limiter.

**Tradeoff:** Jobs in the queue are lost on process restart. In production, use BullMQ + Redis for durability, visibility, and horizontal scaling. The `FAILED` status + retry endpoint mitigate data loss — a lost job leaves a `RECEIVED` item you can requeue.

---

### Guardrail: Rate Limiting
**Choice:** Sliding-window rate limiter on AI analysis calls (`AI_RATE_LIMIT_PER_MINUTE`, default 10).

**Why over the alternatives?**
- **Hash dedup** protects against duplicate content only — not unique high-volume submissions.
- **Caching** helps repeat identical input only — same limitation.
- **Token truncation** is already implemented (content capped at 4000 chars) as a separate content-level guard; it's not a throughput guardrail.
- **Rate limiting** caps runaway API cost regardless of content uniqueness, is trivially observable via logs, and degrades gracefully (job is retried, not dropped).

**Tradeoff:** In-memory state is lost on restart. For production, move to a Redis counter with `EXPIRE`.

---

### AI Output Validation
AI responses are validated against a strict Zod schema:
```
sentiment: "positive" | "neutral" | "negative"
feature_requests: Array<{ title: string, confidence: float }>
actionable_insight: string
```

- Markdown code fences are stripped before JSON parsing (models sometimes add them despite explicit instructions).
- Invalid output → `FAILED` status + error stored; raw response always persisted for debugging.
- Content is truncated to 4000 chars before sending to the model (avoids token overruns on large pastes).

---

### Retry Logic
- Max 2 retries per job.
- Exponential backoff: 5s, 10s.
- Rate-limit hits re-queue the job rather than failing it.
- Only `FAILED` jobs can be manually retried via the API.

---

### Database Schema
Two tables:
- `feedback` — content, status, timestamps.
- `analysis` — one-to-one with feedback, stores raw response, validated JSON, and error message.

Separation keeps `feedback` light for list queries; analysis data only loaded when needed.

---

## What I Would Improve With More Time

1. **Durable queue** — Replace in-process queue with BullMQ + Redis. Adds job visibility, automatic retries with backoff, dead-letter queue, and crash safety.
2. **Distributed rate limiting** — Move the in-memory counter to Redis so it works across replicas.
3. **Integration tests** — Test the happy path and failure modes with a real Postgres instance (e.g. Vitest + testcontainers).
4. **Structured logging** — Replace `console.log` with a JSON logger (pino) for log aggregation.
5. **OpenAPI spec** — Document the API with a machine-readable spec.
6. **Graceful shutdown** — Drain the queue before process exit; signal the inflight job to complete.

---

## AI Collaboration Log

### Tools Used
- **Claude (claude.ai)** — architecture planning, code generation, README drafting.

---

### Example Prompts

**1. Architecture design**
> "Design a Node.js backend that accepts feedback submissions, runs async LLM analysis without blocking the HTTP response, persists to Postgres, and handles FAILED state with retries. No external queue dependencies — keep it simple for a 3-hour build."

This produced the in-process `setImmediate`-based queue design. I steered the output away from an overly complex BullMQ setup by explicitly scoping the constraint.

**2. Schema validation**
> "Write a Zod validator for this AI output schema: `{ sentiment, feature_requests: [{title, confidence}], actionable_insight }`. Handle the case where the model wraps the JSON in markdown code fences."

Produced `src/lib/schema.js`. I added the code-fence stripping after observing the model occasionally wrapping output in triple-backticks despite explicit system prompt instructions.

**3. Rate limiter**
> "Implement a sliding-window in-memory rate limiter for AI calls. It should return `{ allowed, retryAfterMs }` so callers know when to retry. Explain the tradeoff vs Redis."

Generated `src/lib/rateLimiter.js`. I reviewed and kept the in-memory approach with documented production caveats.

---

### Where AI Output Was Wrong / Low Quality

**Problem:** The initial AI-generated queue had an infinite-recursion risk — `_processNext` called itself directly without using `setImmediate`, which would blow the call stack under high queue depth. It also called `analyzeWithAI` with the feedback content passed at enqueue time, meaning if the DB row changed (e.g. retry) the stale content would be used.

**Correction:**
1. Replaced direct recursion with `setImmediate(() => this._processNext())` to return control to the event loop between jobs.
2. Changed the queue to store only the `feedbackId` and fetch fresh content from the DB at process time — making retries safe and removing stale-closure bugs.

**Lesson:** AI-generated async code often has subtle event-loop and stale-closure issues that require careful review. Generating the structure is fast; auditing the async correctness is the human's job.

**Problem:** The AI-generated aiService.js used gemini-1.5-flash as the model name, which returned a 404 — the model had been deprecated/renamed and wasn't available on the current API version.

**Correction:**
Updated to gemini-2.0-flash, then again to gemini-2.5-flash after live testing confirmed which model name the API actually accepts.

**Lesson:** AI coding assistants have a training cutoff and don't know the current state of third-party APIs. Any hardcoded model name, SDK version, or API endpoint generated by an AI should be verified against live documentation before relying on it.