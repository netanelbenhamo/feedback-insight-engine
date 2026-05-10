import { z } from "zod";

export const analysisSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  feature_requests: z.array(
    z.object({
      title: z.string().min(1),
      confidence: z.number().min(0).max(1),
    })
  ),
  actionable_insight: z.string().min(1),
});

/**
 * Parse and validate raw AI text response.
 * Returns { data } on success or { error } on failure.
 */
export function parseAnalysisResponse(rawText) {
  let parsed;

  // Strip markdown code fences if present (```json ... ```)
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { error: `JSON parse failed: ${rawText.slice(0, 200)}` };
  }

  const result = analysisSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { error: `Schema validation failed: ${issues}` };
  }

  return { data: result.data };
}