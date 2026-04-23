/**
 * Built-in model pricing table and fuzzy model matcher.
 * Prices are per 1M tokens (USD).
 */

export const MODEL_PRICING = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.80, output: 4 },
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'deepseek-v3': { input: 0.27, output: 1.10 },
  'deepseek-r1': { input: 0.55, output: 2.19 },
};

/**
 * Fuzzy-match a model name to a pricing entry.
 * Tries exact match first, then lowercase + substring matching,
 * then strips version suffixes (e.g. "-20250414") and retries.
 *
 * @param {string} modelName — The model string to look up
 * @returns {{ input: number, output: number } | null}
 */
export function resolveModelPricing(modelName) {
  if (!modelName) return null;

  const lower = modelName.toLowerCase().trim();

  // 1. Exact match
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];

  // 2. Check if any known key is a substring of the input (or vice versa)
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key) || key.includes(lower)) {
      return pricing;
    }
  }

  // 3. Strip version suffixes like -20250414, -v2, -latest and retry
  const stripped = lower.replace(/[-_](20\d{6}|v\d+|latest|preview|beta|exp)$/g, '');
  if (stripped !== lower) {
    if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      if (stripped.includes(key) || key.includes(stripped)) {
        return pricing;
      }
    }
  }

  return null;
}

/**
 * Calculate cost in USD from token counts and per-1M-token pricing.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {{ input: number, output: number }} pricing — per 1M tokens
 * @returns {number} cost in USD
 */
export function calculateCost(inputTokens, outputTokens, pricing) {
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
