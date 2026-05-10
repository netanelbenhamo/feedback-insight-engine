import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseAnalysisResponse } from "../lib/schema.js";
import "dotenv/config";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are a product feedback analyst. Given user feedback text, return ONLY a valid JSON object — no markdown, no explanation, no preamble.

The JSON must exactly match this schema:
{
  "sentiment": "positive" | "neutral" | "negative",
  "feature_requests": [
    { "title": "string", "confidence": <float 0.0–1.0> }
  ],
  "actionable_insight": "string"
}

Rules:
- sentiment: overall tone of the feedback.
- feature_requests: list of distinct feature asks detected. Empty array if none.
- confidence: your confidence that this is genuinely a feature request (0.0 = unsure, 1.0 = certain).
- actionable_insight: one concrete, specific recommendation for the product team.
- Output ONLY the JSON object. Any additional text will cause a parsing failure.`;

/**
 * Max characters of feedback sent to the model.
 * Truncate to 4000 chars to stay well within token limits.
 */
const MAX_CONTENT_CHARS = 4000;

/**
 * Call Gemini and return { raw, data } or throw on API error.
 * Validation failures are returned as { raw, validationError }.
 */
export async function analyzeWithAI(content) {
  const truncated =
    content.length > MAX_CONTENT_CHARS
      ? content.slice(0, MAX_CONTENT_CHARS) + "\n[truncated]"
      : content;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await model.generateContent(truncated);
  const raw = result.response.text();

  const { data, error } = parseAnalysisResponse(raw);

  if (error) {
    return { raw, validationError: error };
  }

  return { raw, data };
}