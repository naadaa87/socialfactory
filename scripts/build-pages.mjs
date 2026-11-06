import {readdir,rm,mkdir,copyFile,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=join(root,'.pages-dist');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const folders=new Set(['css','fonts','images','js','magazine','product','video','toss-front-plugin','spacecloud-collector']);
for(const entry of await readdir(root,{withFileTypes:true})){
 if(entry.isDirectory() && folders.has(entry.name))await cp(join(root,entry.name),join(out,entry.name),{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|\.profile|\.env|\.dev.vars)(?:$|\/)/.test(p)});
 else if(entry.isFile() && (/\.(html|xml|ico|svg|png|webmanifest)$/.test(entry.name)||['robots.txt','_headers','_redirects','_routes.json'].includes(entry.name)))await copyFile(join(root,entry.name),join(out,entry.name));
}
console.log('Pages static assets prepared; server source and private runtime files excluded.');
