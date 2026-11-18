// Paid automatic synchronization uses eight of the ten included browser hours,
// retaining two hours of headroom. Other deployments keep the original ceiling.
export const DEFAULT_BROWSER_TOTAL_MS = 2 * 3600000;
export const AUTOMATIC_BROWSER_TOTAL_MS = 8 * 3600000;
export const isMeteredPlan = env => env.CLOUD_PLAN_MODE === 'paid-metered'
  && env.METERED_USAGE_CONFIRMED === 'true' && env.BROWSER_BUDGET_PROFILE === 'continuous-sync';
export const isMeteredBudget = budget => budget?.mode === 'metered'
  && ['daily_limit_ms','monthly_limit_ms','rolling_32d_limit_ms'].every(key => budget[key] === null);
export function browserTotalCeiling(env) {
  return env.CLOUD_PLAN_MODE === 'paid-included' && env.INCLUDED_BUDGET_CONFIRMED === 'true'
    && env.BROWSER_BUDGET_PROFILE === 'automatic-sync' ? AUTOMATIC_BROWSER_TOTAL_MS : DEFAULT_BROWSER_TOTAL_MS;
}
