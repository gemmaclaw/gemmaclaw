/**
 * Absolute minimum prompt budget in tokens.  When the context window is
 * large enough that `contextTokenBudget * MIN_PROMPT_BUDGET_RATIO` exceeds
 * this value, this absolute floor takes precedence.
 */
export const MIN_PROMPT_BUDGET_TOKENS = 16_000;

/**
 * Minimum share of the context window that must remain available for prompt
 * content after reserve tokens are subtracted.
 */
export const MIN_PROMPT_BUDGET_RATIO = 0.5;
