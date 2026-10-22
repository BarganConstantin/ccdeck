// OpenAI confirms ChatGPT auto-review checks are free:
// https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
// The announcement was on Oct 6. Use the following UTC day conservatively;
// do not infer the exact historical billing cutover from the current policy.
export const AUTO_REVIEW_MODEL = "codex-auto-review";
export const FREE_AUTO_REVIEW_TIER = "chatgpt-auto-review-free";
export const FREE_AUTO_REVIEW_FROM = Date.parse("2026-10-07T00:00:00Z");
export function isFreeAutoReview(model, creator, at) {
  return model === AUTO_REVIEW_MODEL && typeof creator === "string" && creator.trim().length > 0
    && typeof at === "string" && Date.parse(at) >= FREE_AUTO_REVIEW_FROM;
}
