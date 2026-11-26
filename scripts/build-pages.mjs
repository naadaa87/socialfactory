import {readdir,rm,mkdir,copyFile,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=join(root,'.pages-dist');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const folders=new Set(['css','fonts','images','js','magazine','product','rooms','for','video','toss-front-plugin','spacecloud-collector']);
for(const entry of await readdir(root,{withFileTypes:true})){
 if(entry.isDirectory() && folders.has(entry.name))await cp(join(root,entry.name),join(out,entry.name),{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|\.profile|\.env|\.dev.vars)(?:$|\/)/.test(p)});
 else if(entry.isFile() && (/\.(html|xml|ico|svg|png|webmanifest)$/.test(entry.name)||['robots.txt','llms.txt','_headers','_redirects','_routes.json'].includes(entry.name)||/^[0-9a-f]{32}\.txt$/.test(entry.name)))await copyFile(join(root,entry.name),join(out,entry.name));
}
// 사이트맵 수정일: 본문이 바뀐 페이지만 배포일로 고칩니다 (scripts/seo.mjs). 실패해도 배포는 그대로 진행합니다.
try{
 const {stampSitemap,loadMemory}=await import('./seo.mjs');const {readFile,writeFile}=await import('node:fs/promises');const {existsSync,readFileSync}=await import('node:fs');
 const src=await readFile(join(root,'sitemap.xml'),'utf8');
 const r=stampSitemap(src,{read:rel=>existsSync(join(root,rel))?readFileSync(join(root,rel),'utf8'):null,memory:loadMemory()});
 if(r.xml!==src)await writeFile(join(out,'sitemap.xml'),r.xml);
 console.log(`Sitemap lastmod refreshed for ${r.changed.length} page(s).`);
}catch(e){console.warn('Sitemap lastmod step skipped:',e&&e.message);}
console.log('Pages static assets prepared; server source and private runtime files excluded.');
