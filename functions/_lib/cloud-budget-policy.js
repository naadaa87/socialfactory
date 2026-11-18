// Paid automatic synchronization uses eight of the ten included browser hours,
// retaining two hours of headroom. Other deployments keep the original ceiling.
export const DEFAULT_BROWSER_TOTAL_MS = 2 * 3600000;
export const AUTOMATIC_BROWSER_TOTAL_MS = 8 * 3600000;
export function browserTotalCeiling(env) {
  return env.CLOUD_PLAN_MODE === 'paid-included' && env.INCLUDED_BUDGET_CONFIRMED === 'true'
    && env.BROWSER_BUDGET_PROFILE === 'automatic-sync' ? AUTOMATIC_BROWSER_TOTAL_MS : DEFAULT_BROWSER_TOTAL_MS;
}
