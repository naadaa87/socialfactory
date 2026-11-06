export function readConfig(env=process.env, base=process.cwd()) {
  const origin=new URL(env.API_ORIGIN || 'http://127.0.0.1:8766');
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('API_ORIGIN must be an HTTPS origin (localhost HTTP is permitted).');
  const token=env.SPACECLOUD_WORKER_TOKEN || '';
  if (token.length < 32) throw new Error('SPACECLOUD_WORKER_TOKEN must contain at least 32 characters.');
  return {origin:origin.origin,token,allowWrites:env.SPACECLOUD_ALLOW_WRITES === 'true',
    profile:env.SPACECLOUD_PROFILE_DIR || base+'/.profile',accountLabel:env.SPACECLOUD_ACCOUNT_LABEL || '소셜팩토리 건대 (초특가)',
    headless:env.SPACECLOUD_HEADLESS === 'true',pollMs:Math.max(1000,Math.min(30000,Number(env.SPACECLOUD_POLL_MS)||3000))};
}

export class QueueClient {
  constructor(config,fetcher=(...args)=>globalThis.fetch(...args)) { this.config=config;this.fetcher=fetcher; }
  async request(body) {
    const response=await this.fetcher(this.config.origin+'/api/internal/spacecloud-sync',{
      // Completion may also check capacity and issue the provider request or
      // refresh iCal after release. The runner's overall deadline still applies.
      method:body ? 'POST' : 'GET',redirect:'manual',signal:AbortSignal.timeout(body?.action==='complete'?45000:20000),
      headers:{Authorization:'Bearer '+this.config.token,...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    if(!response.ok)throw Object.assign(new Error('Queue request rejected ('+response.status+').'),{code:'queue-http-'+response.status});
    let result;try {result=await response.json();}catch {throw Object.assign(new Error('Queue response was not JSON.'),{code:'queue-json-'+response.status});}
    if (result?.ok !== true) throw Object.assign(new Error('Queue request rejected ('+response.status+').'),{code:'queue-response'});
    return result;
  }
  async claim() { return (await this.request()).job; }
  async maintenance() { return this.request({action:'maintenance'}); }
  async heartbeat(job) { return this.request({action:'heartbeat',job_id:job.job_id ?? job.id,lease_token:job.lease_token}); }
  async complete(job,result) { return this.request({action:'complete',job_id:job.job_id ?? job.id,lease_token:job.lease_token,...result}); }
  async snapshot(snapshot) { return this.request({action:'snapshot',...snapshot}); }
}
