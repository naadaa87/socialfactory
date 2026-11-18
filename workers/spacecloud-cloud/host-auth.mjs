// Match the official host app's credentials:include requests using only its
// already encrypted server profile. Never read the person's browser profile.
export function hostAPIHeaders(state,path,token,{now=Date.now()}={}) {
  const url=new URL(path,'https://api.spacecloud.kr');
  if(url.origin!=='https://api.spacecloud.kr' || !url.pathname.startsWith('/partner/'))throw new Error('host-api-origin');
  const headers={Authorization:token,Accept:'application/json'};
  const cookies=(state?.cookies||[]).filter(cookie=>{
    const domain=String(cookie.domain||'').toLowerCase(),bare=domain.replace(/^\./,'');
    const domainMatches=domain.startsWith('.')?(url.hostname===bare||url.hostname.endsWith('.'+bare)):url.hostname===bare;
    const path=String(cookie.path||'/');
    return domainMatches && (bare==='spacecloud.kr'||bare==='api.spacecloud.kr') &&
      (url.pathname===path||url.pathname.startsWith(path.endsWith('/')?path:path+'/')) &&
      (!Number.isFinite(cookie.expires)||cookie.expires<=0||cookie.expires*1000>now) &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) && typeof cookie.value==='string' &&
      !/[\x00-\x20\x7f;,]/.test(cookie.value);
  }).sort((a,b)=>String(b.path||'/').length-String(a.path||'/').length);
  if(cookies.length)headers.Cookie=cookies.map(cookie=>cookie.name+'='+cookie.value).join('; ');
  return headers;
}
