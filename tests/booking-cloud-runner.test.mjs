import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudRunnerOrigin,wakeCloudRunner} from '../functions/_lib/spacecloud-runner.js';

const origin='https://spacecloud-runner.socialfactory.workers.dev';
const secret='local-test-worker-secret-0123456789abcdef';
const settings=extra=>({SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_RUNNER_URL:origin,SPACECLOUD_WORKER_TOKEN:secret,...extra});
async function withFetch(mock,run){const previous=globalThis.fetch;globalThis.fetch=mock;try{return await run();}finally{globalThis.fetch=previous;}}

test('wake configuration accepts only an exact HTTPS workers.dev worker origin',async()=>{
  assert.equal(cloudRunnerOrigin(origin),origin);
  for(const value of [undefined,'',' '+origin,origin+'/',origin+'/run',origin+'?token=private',origin+'#fragment','http://spacecloud-runner.socialfactory.workers.dev','https://private@spacecloud-runner.socialfactory.workers.dev','https://spacecloud-runner.socialfactory.workers.dev:443','https://spacecloud-runner.socialfactory.workers.dev:8443','https://workers.dev','https://socialfactory.workers.dev','https://spacecloud-runner.socialfactory.workers.dev.evil.test','https://127.0.0.1','https://localhost','https://[::1]','https://10.0.0.1','https://custom.socialfactory.co.kr'])assert.equal(cloudRunnerOrigin(value),null,String(value));
  let calls=0;
  await withFetch(async()=>{calls++;throw new Error('must not call');},async()=>{
    assert.equal((await wakeCloudRunner(settings({SPACECLOUD_RUNNER_URL:'https://evil.test'}))).reason,'invalid-config');
    assert.equal((await wakeCloudRunner(settings({SPACECLOUD_WORKER_TOKEN:'short'}))).reason,'invalid-config');
    assert.equal((await wakeCloudRunner(settings({SPACECLOUD_WORKER_TOKEN:secret+'\r\nInjected: secret'}))).reason,'invalid-config');
    assert.equal((await wakeCloudRunner(settings({SPACECLOUD_WORKER_TOKEN:''}))).reason,'not-configured');
    assert.equal((await wakeCloudRunner(settings({SPACECLOUD_SYNC_ENABLED:'false'}))).reason,'disabled');
    assert.equal((await wakeCloudRunner(settings({SPACECLOUD_SYNC_ENABLED:true}))).reason,'disabled');
    assert.equal((await wakeCloudRunner(undefined)).reason,'disabled');
  });
  assert.equal(calls,0);
});

test('wake sends a bounded authenticated POST without a token in URL or returned result',async()=>{
  const calls=[];
  await withFetch(async(url,options)=>{calls.push({url,options});return new Response('private runner response',{status:202});},async()=>{
    const result=await wakeCloudRunner(settings());assert.deepEqual(result,{ok:true,scheduled:true});
    assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes(origin));
  });
  assert.equal(calls.length,1);assert.equal(calls[0].url,origin+'/run');assert(!calls[0].url.includes(secret));
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+secret);assert.deepEqual(JSON.parse(calls[0].options.body),{});
  assert(calls[0].options.signal instanceof AbortSignal);assert.equal(calls[0].options.signal.aborted,false);
});

test('failed or rejected wakes return safely and never mutate booking storage or expose provider errors',async()=>{
  let calls=0;const env=settings({DB:new Proxy({},{get(){throw new Error('booking storage must remain untouched');}})});
  await withFetch(async()=>{calls++;return new Response(secret,{status:503});},async()=>{
    assert.deepEqual(await wakeCloudRunner(env),{ok:false,scheduled:false,reason:'unavailable'});
  });
  await withFetch(async()=>{calls++;throw new Error(origin+'?secret='+secret);},async()=>{
    const result=await wakeCloudRunner(env);assert.deepEqual(result,{ok:false,scheduled:false,reason:'unavailable'});
    assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes(origin));
  });
  assert.equal(calls,2);
});

test('waitUntil retains the dispatch and returns before the runner acknowledges it',async()=>{
  let finish,retained;
  await withFetch(()=>new Promise(resolve=>{finish=resolve;}),async()=>{
    const result=await wakeCloudRunner(settings(),{waitUntil:promise=>{retained=promise;}});
    assert.deepEqual(result,{ok:true,scheduled:true});assert(retained instanceof Promise);
    finish(new Response(null,{status:202}));assert.deepEqual(await retained,{ok:true,scheduled:true});
  });
});

test('waitUntil failures and runner outages settle the same dispatch without a duplicate or rejection',async()=>{
  let calls=0,retained;
  await withFetch(async()=>{calls++;throw new Error('offline');},async()=>{
    const queued=await wakeCloudRunner(settings(),{waitUntil:promise=>{retained=promise;}});
    assert.deepEqual(queued,{ok:true,scheduled:true});assert.deepEqual(await retained,{ok:false,scheduled:false,reason:'unavailable'});
    const awaited=await wakeCloudRunner(settings(),{waitUntil:()=>{throw new Error('closed context');}});
    assert.deepEqual(awaited,{ok:false,scheduled:false,reason:'unavailable'});
  });
  assert.equal(calls,2);
});

test('a runner that never acknowledges is aborted after ten seconds and leaves a retryable failure',async()=>{
  const previousSetTimeout=globalThis.setTimeout,previousClearTimeout=globalThis.clearTimeout;
  let expire,delay,signal,cleared=false;
  globalThis.setTimeout=(fn,ms)=>{expire=fn;delay=ms;return 123;};
  globalThis.clearTimeout=id=>{assert.equal(id,123);cleared=true;};
  try {
    await withFetch((url,options)=>new Promise((resolve,reject)=>{
      signal=options.signal;signal.addEventListener('abort',()=>reject(new Error('request aborted')),{once:true});
    }),async()=>{
      const task=wakeCloudRunner(settings());assert.equal(signal.aborted,false);assert.equal(delay,10000);
      expire();assert.equal(signal.aborted,true);
      assert.deepEqual(await task,{ok:false,scheduled:false,reason:'unavailable'});assert.equal(cleared,true);
    });
  }finally{globalThis.setTimeout=previousSetTimeout;globalThis.clearTimeout=previousClearTimeout;}
});
