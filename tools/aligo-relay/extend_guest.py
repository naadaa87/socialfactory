#!/usr/bin/env python3
"""소셜팩토리의 인증 문자·템플릿 승인 조회만 기존 인증키로 추가합니다."""
import os,json,re,shutil,datetime,urllib.request
from pathlib import Path
from install import command,adapt,normalize_groups,private_write,service_ids,MAIN,SNIPPET,SECRET
PATHS={'/socialfactory/aligo/sms','/socialfactory/aligo/templates'}
def prune(value):
 if isinstance(value,dict):return {k:prune(v) for k,v in value.items()}
 if isinstance(value,list):return [prune(v) for v in value if not(isinstance(v,dict) and any(set(m.get('path',[]))&PATHS for m in v.get('match',[])))]
 return value

def main():
 if os.geteuid()!=0:raise RuntimeError('root required')
 old_main=MAIN.read_bytes();old_snippet=SNIPPET.read_bytes();old=adapt(MAIN)
 active=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5))
 if old!=active:raise RuntimeError('disk/runtime mismatch')
 if prune(old)!=old:raise RuntimeError('guest paths already exist; inspect without overwriting')
 secret=SECRET.read_text().strip()
 if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',secret):raise RuntimeError('invalid relay secret')
 before=service_ids()
 if before.count('ActiveState=active')!=2:raise RuntimeError('existing services not healthy')
 extra='\n'
 for name,path,host,upstream in [('sms','/socialfactory/aligo/sms','apis.aligo.in','/send/'),('templates','/socialfactory/aligo/templates','kakaoapi.aligo.in','/akv10/template/list/')]:
  extra+='''@socialfactory_%s {
 path %s
 method POST
 header Authorization "Bearer %s"
 header Content-Type application/x-www-form-urlencoded*
}
handle @socialfactory_%s {
 request_body {
  max_size 32KB
 }
 reverse_proxy https://%s {
  rewrite %s
  header_up Host %s
  header_up -Authorization
  header_up -Cookie
  header_down -Server
  lb_retries 0
  transport http {
   dial_timeout 5s
   response_header_timeout 8s
   read_timeout 8s
   write_timeout 8s
  }
 }
}
'''%(name,path,secret,name,host,upstream,host)
 proposed=old_snippet+extra.encode();candidate=SNIPPET.with_name('.socialfactory-guest-candidate.caddy');main_candidate=MAIN.with_name('.Caddyfile.guest-candidate')
 backup=Path('/root/socialfactory-guest-backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700);shutil.copy2(SNIPPET,backup/SNIPPET.name)
 private_write(candidate,proposed,0o640,True);private_write(main_candidate,old_main.replace(str(SNIPPET).encode(),str(candidate).encode()),0o640,True)
 changed=False
 try:
  new=adapt(main_candidate)
  if normalize_groups(prune(new))!=normalize_groups(old):raise RuntimeError('existing routes changed')
  command(['runuser','-u','caddy','--','caddy','validate','--config',str(main_candidate),'--adapter','caddyfile'])
  if MAIN.read_bytes()!=old_main or SNIPPET.read_bytes()!=old_snippet:raise RuntimeError('concurrent config change')
  os.replace(candidate,SNIPPET);changed=True;command(['systemctl','reload','caddy'])
  loaded=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5))
  if normalize_groups(prune(loaded))!=normalize_groups(old) or service_ids()!=before:raise RuntimeError('post-apply verification failed')
 except Exception:
  if changed:private_write(SNIPPET,old_snippet,0o640,True);command(['systemctl','reload','caddy'])
  raise
 finally:candidate.unlink(missing_ok=True);main_candidate.unlink(missing_ok=True)
 print(json.dumps({'installed':True,'existing_routes_preserved':True,'services_not_restarted':True,'paths':sorted(PATHS)}))
if __name__=='__main__':
 try:main()
 except Exception as e:print('stopped: '+str(e));raise SystemExit(1)
