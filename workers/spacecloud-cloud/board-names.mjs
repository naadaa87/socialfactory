import { reservationBoardName, validBoardName } from '../../functions/_lib/reservation-board-name.js';
import { ROOMS } from '../../integrations/spacecloud-worker/spacecloud-ui.mjs';
const API='https://api.spacecloud.kr',HOST='https://partner.spacecloud.kr';
const TABLE=`CREATE TABLE IF NOT EXISTS cloud_board_names (reservation_id TEXT PRIMARY KEY, board_name TEXT, checked_at INTEGER NOT NULL, retry_at INTEGER NOT NULL)`;
const keys=value=>Array.isArray(value)?value.map(keys):value && typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase(),keys(v)])):value;
const diagnostic=(code,detail={})=>console.info('spacecloud-board-names',code,detail);
const DAY=86400000,TTL=DAY,FAILURE_TTL=60000,LIMIT=6;

export async function enrichBoardNames(env,snapshots,state,{fetcher=fetch,now=Date.now(),live=()=>{}}={}) {
  // Full names and contact details never enter storage, calendar payloads or logs.
  // Read only the same venue's confirmed reservation IDs; keep occupancy independent.
  try {
    const entry=state?.origins?.find(x=>x.origin===HOST)?.localStorage?.find(x=>x.name==='spacecloud__userInfo');
    const user=JSON.parse(entry?.value||'null');
    if(!user?.accessToken){diagnostic('host-auth-unavailable');return;}
    const today=new Date(now+9*3600000).toISOString().slice(0,10);
    const until=new Date(now+9*3600000+7*DAY).toISOString().slice(0,10);
    const candidates=new Map();
    for(const scope of snapshots)for(const event of scope.events||[]) {
      if(event.kind==='reservation' && event.date>=today && event.date<=until && /^[0-9]{1,20}$/.test(event.id) && ROOMS[scope.space])
        candidates.set(event.id,{...event,space:scope.space});
    }
    if(!candidates.size)return;
    await env.STATE_DB.prepare(TABLE).run();
    const cached=new Map();
    const ids=[...candidates.keys()];
    for(let offset=0;offset<ids.length;offset+=90) {
      const chunk=ids.slice(offset,offset+90);
      const rows=await env.STATE_DB.prepare(`SELECT reservation_id,board_name,retry_at FROM cloud_board_names WHERE reservation_id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
      for(const row of rows.results||[])cached.set(row.reservation_id,row);
    }
    await env.STATE_DB.prepare('CREATE TABLE IF NOT EXISTS cloud_board_name_backoff (id INTEGER PRIMARY KEY CHECK(id=1), retry_at INTEGER NOT NULL)').run();
    const backoff=await env.STATE_DB.prepare('SELECT retry_at FROM cloud_board_name_backoff WHERE id=1').first();
    const deadline=Date.now()+20000;
    const pending=(backoff?.retry_at>now?[]:ids).filter(id=>!cached.has(id)||cached.get(id).retry_at<=now).slice(0,LIMIT);
    let cursor=0,stopped=false;
    await Promise.all(Array.from({length:Math.min(2,pending.length)},async()=>{
      while(cursor<pending.length && !stopped && Date.now()<deadline) {
        const id=pending[cursor++],event=candidates.get(id);let name=null,retryAt=now+FAILURE_TTL;
        try {
          live();
          const response=await fetcher(API+'/partner/reservations/'+id,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{Authorization:user.accessToken,Accept:'application/json'}});
          if(response.status===429||response.status===401){
            diagnostic('lookup-paused',{status:response.status});
            stopped=true;
            const raw=response.headers.get('retry-after'),seconds=Number(raw);
            const delay=response.status===429 && raw?(Number.isFinite(seconds)?seconds*1000:Date.parse(raw)-now):FAILURE_TTL;
            const retryAt=now+Math.max(FAILURE_TTL,Number.isFinite(delay)?delay:FAILURE_TTL);
            await env.STATE_DB.prepare('INSERT INTO cloud_board_name_backoff(id,retry_at) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)').bind(retryAt).run();
            continue;
          }
          if(response.status===200) {
            const detail=keys(await response.json());live();
            const space=detail.space;
            if(String(detail.id)===id && space?.space_name===(env.SPACECLOUD_ACCOUNT_LABEL||'소셜팩토리 건대 (초특가)') &&
              typeof space.product_name==='string' && space.product_name.startsWith(Number(event.space.slice(1))+'번룸 '))
              name=reservationBoardName(detail.user_info?.name);
            if(name)retryAt=now+TTL;
            else diagnostic('detail-not-matched',{id_matches:String(detail.id)===id,venue_matches:space?.space_name===(env.SPACECLOUD_ACCOUNT_LABEL||'소셜팩토리 건대 (초특가)'),has_room:typeof space?.product_name==='string',has_name:typeof detail.user_info?.name==='string'});
          }
          else diagnostic('detail-http',{status:response.status});
        } catch(error) { diagnostic('detail-unavailable',{type:error?.name==='TimeoutError'?'timeout':'lookup'}); }
        const previous=cached.get(id)?.board_name;
        const boardName=name || (validBoardName(previous)?previous:null);
        await env.STATE_DB.prepare(`INSERT INTO cloud_board_names(reservation_id,board_name,checked_at,retry_at) VALUES(?1,?2,?3,?4)
          ON CONFLICT(reservation_id) DO UPDATE SET board_name=excluded.board_name,checked_at=excluded.checked_at,retry_at=excluded.retry_at`).bind(id,boardName,now,retryAt).run();
        cached.set(id,{board_name:boardName,retry_at:retryAt});
      }
    }));
    for(const scope of snapshots)for(const event of scope.events||[]) {
      const name=cached.get(event.id)?.board_name;
      if(event.kind==='reservation' && validBoardName(name))event.board_name=name;
    }
    if(pending.length)diagnostic('lookup-complete',{requested:pending.length,available:[...cached.values()].filter(x=>validBoardName(x.board_name)).length});
    await env.STATE_DB.prepare('DELETE FROM cloud_board_names WHERE checked_at<?1').bind(now-32*DAY).run();
  } catch { diagnostic('cache-unavailable'); }
}
