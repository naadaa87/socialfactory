import test from 'node:test';
import assert from 'node:assert/strict';
import {hostAPIHeaders} from '../host-auth.mjs';

test('saved credentials are sent only to the matching official API domain, path and lifetime',()=>{
 const cookie={name:'session',value:'PRIVATE',domain:'.spacecloud.kr',path:'/',expires:-1,secure:true};
 const cookies=[cookie,{...cookie,name:'api',domain:'api.spacecloud.kr',path:'/partner'},
  {...cookie,name:'host',domain:'partner.spacecloud.kr'},
  {...cookie,name:'foreign',domain:'.evil.test'},
  {...cookie,name:'lookalike',domain:'.cloud.kr'},
  {...cookie,name:'expired',expires:1},
  {...cookie,name:'wrongPath',path:'/partner-other'},
  {...cookie,name:'badValue',value:'a; injected=x'}];
 const headers=hostAPIHeaders({cookies},'/partner/users/get_token','TOKEN',{now:2000});
 assert.equal(headers.Cookie,'api=PRIVATE; session=PRIVATE');
 assert.equal(headers.Authorization,'TOKEN');
 assert.throws(()=>hostAPIHeaders({cookies},'https://evil.test/partner/users/get_token','TOKEN'));
 assert.throws(()=>hostAPIHeaders({cookies},'/other','TOKEN'));
 assert.equal(hostAPIHeaders({cookies:[]},'/partner/reservations/1','TOKEN').Cookie,undefined);
});
