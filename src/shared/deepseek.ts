/** Native Responses API web_search is supported only by Pro. */
export const DEEPSEEK_ANSWER_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_ROUTER_MODEL = "deepseek-flash";

// Conservative peak, cache-miss USD estimates; actual off-peak/cache costs vary.
// https://api-docs.deepseek.com/quick_start/pricing/ (2026-10-21)
export const DEEPSEEK_ROUTER_INPUT_PRICE_PER_MILLION = "0.30";
export const DEEPSEEK_ROUTER_OUTPUT_PRICE_PER_MILLION = "1.20";
