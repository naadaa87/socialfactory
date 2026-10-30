// A hard deadline covers both fetch and JSON decoding, including transports that
// ignore AbortSignal. A late response cannot complete the caller after timeout.
export async function boardRequest(url, { timeoutMs=15000, fetcher=fetch, ...init }={}) {
  const controller=new AbortController();
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      reject(Object.assign(new Error('board-timeout'),{code:'timeout'}));
      controller.abort();
    },timeoutMs);
  });
  const operation=Promise.resolve().then(()=>fetcher(url,{...init,signal:controller.signal})).then(async response=>{
    if(!response.ok) throw Object.assign(new Error('board-http'),{code:'http',status:response.status});
    return response.json();
  });
  try{return await Promise.race([operation,deadline]);}
  finally{clearTimeout(timer);}
}
