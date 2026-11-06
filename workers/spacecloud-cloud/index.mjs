import { launch,connect,endpointURLString } from '@cloudflare/playwright';
import { createRunner } from './runner.mjs';
import { persistentConnector } from './connection.mjs';
const runner=createRunner({launch,connect:persistentConnector(connect,endpointURLString)});
export default {
  fetch(request,env){return runner.fetch(request,env);},
  scheduled(controller,env,ctx){ctx.waitUntil(runner.scheduled(env));}
};
