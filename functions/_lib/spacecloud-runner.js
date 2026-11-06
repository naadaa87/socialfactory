/** Wake the separately deployed Cloudflare browser runner; this never releases a booking hold. */
const WAKE_TIMEOUT_MS = 10000;

/** Only an explicit Cloudflare Worker origin may receive the worker bearer secret. */
export function cloudRunnerOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password
      || url.port || url.search || url.hash || url.pathname !== '/') return null;
    // The deployed worker URL has a worker label and an account subdomain.
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (!new RegExp('^' + label + '\\.' + label + '\\.workers\\.dev$').test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

function runnerConfig(env) {
  if (env?.SPACECLOUD_SYNC_ENABLED !== 'true') return {reason:'disabled'};
  if (!env.SPACECLOUD_RUNNER_URL || !env.SPACECLOUD_WORKER_TOKEN) return {reason:'not-configured'};
  const origin = cloudRunnerOrigin(env.SPACECLOUD_RUNNER_URL);
  const token = env.SPACECLOUD_WORKER_TOKEN;
  // Do not trim or transform secrets, and refuse characters invalid in a Bearer header.
  if (!origin || typeof token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{32,512}$/.test(token)) return {reason:'invalid-config'};
  return {origin,token};
}

async function sendWake({origin,token}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),WAKE_TIMEOUT_MS);
  try {
    const response = await fetch(origin + '/run', {
      method:'POST', redirect:'manual', signal:controller.signal,
      headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json','Cache-Control':'no-store'},
      body:'{}'
    });
    // Only acknowledge the cloud queue; its independent Cron executes browser work.
    if (!response.ok) return {ok:false,scheduled:false,reason:'unavailable'};
    return {ok:true,scheduled:true};
  } catch {
    // A wake failure must leave the durable job and reservation hold intact for later retry.
    return {ok:false,scheduled:false,reason:'unavailable'};
  } finally { clearTimeout(timeout); }
}

/**
 * With waitUntil, `ok` means dispatch was scheduled, not that an external block was verified.
 * Callers still gate checkout and release on authenticated, verified worker receipts.
 */
export async function wakeCloudRunner(env,{waitUntil} = {}) {
  const config = runnerConfig(env);
  if (config.reason) return {ok:false,scheduled:false,reason:config.reason};
  const task = sendWake(config);
  if (typeof waitUntil === 'function') {
    try {
      waitUntil(task);
      return {ok:true,scheduled:true};
    } catch {
      // If the execution context cannot retain work, await this same dispatch once.
    }
  }
  return task;
}
