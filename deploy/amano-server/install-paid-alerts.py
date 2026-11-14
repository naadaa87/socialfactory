#!/usr/bin/env python3
"""Extend the live relay in place and preserve its other deployed integrations."""
from pathlib import Path
import argparse, datetime, hashlib, hmac, json, os, re, shutil, subprocess, time, urllib.request

HERE=Path(__file__).resolve().parent
AMANO=Path('/opt/megaspot-amano')
RELAY=Path('/opt/megaspot-aligo/server.mjs')
ENV=Path('/etc/megaspot-aligo.env')
TIMER=Path('/etc/systemd/system/megaspot-amano-tick.timer.d/socialfactory-24h.conf')
BASE={
 AMANO/'alerts.mjs':'0ec53958954217f5e89c0974d81ccb11425eec77b766d1592bc83e8bd62e88f7',
 AMANO/'socialfactory.mjs':'d87f59a61cc918726691593b726f120ef2faa31f94ecc27bf5930b2f58637bda',
 AMANO/'server.mjs':'8bbccde9fd19197b78754beccfea4b549189a7ae57fe432acce60f5baae6b2b4',
 RELAY:'60a8a27d4cc204fde39c1ab071656c9281d4632f206b232f0e13ba33fdc572fb',
}

def extend_relay(text):
 replacements=[
  ("  'socialfactory-admin/status':[],", "  'socialfactory-paid-admin/send':['receiver','msg'],\n  'socialfactory-paid-admin/status':[],\n  'socialfactory-admin/status':[],"),
  ("  if(v.path==='socialfactory-admin/status')", "  const paidReceivers=[...new Set((env.SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim()).filter(s=>adminReceivers.includes(s)))];\n  if(v.path==='socialfactory-paid-admin/status')return json({ready:!!paidReceivers.length,receiver_last4:paidReceivers.map(s=>s.slice(-4))});\n  if(v.path==='socialfactory-admin/status')"),
  ("const socialfactorySMS=v.path==='socialfactory-admin/send',", "const paidAdminSMS=v.path==='socialfactory-paid-admin/send',socialfactorySMS=v.path==='socialfactory-admin/send'||paidAdminSMS,"),
  ("const staffMessage=socialfactorySMS?", "const staffMessage=paidAdminSMS?paidReceivers.includes(data.receiver)&&data.msg?.startsWith('[소셜팩토리 주차권 결제 완료]\\n')&&data.msg.endsWith('https://socialfactory.co.kr/admin#parking')&&Buffer.byteLength(data.msg,'utf8')<=2000:socialfactorySMS?"),
  ("title:", "title:paidAdminSMS?'소셜팩토리 주차권 결제 알림':"),
 ]
 for old,new in replacements:
  if text.count(old)!=1:raise RuntimeError('Relay extension anchor changed')
  text=text.replace(old,new,1)
 return text

def extend_server(text):
 old="return socialfactoryControl(request,env,store,clientFactory,()=>cycleBusy);"
 new="""return socialfactoryControl(request,env,store,clientFactory,()=>cycleBusy,async paymentOid=>{
  if(cycleBusy)return {ok:true,busy:true};
  cycleBusy=true;
  try{return await runSocialfactory({env,store,clientFactory,paymentOid});}
  finally{cycleBusy=false;}
 });"""
 if text.count(old)!=1:raise RuntimeError('Socialfactory dispatch anchor changed')
 return text.replace(old,new,1)

def run(*args):
 return subprocess.run(args,check=True,capture_output=True,text=True).stdout

def environment():
 result={}
 for line in ENV.read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   key,value=line.split('=',1);result[key.strip()]=value.strip().strip('"\'')
 return result

def rpc(port,path,secret,header,payload):
 body=json.dumps({**payload,'time':int(time.time()*1000)},separators=(',',':')).encode()
 request=urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=body,headers={
  'Content-Type':'application/json',header:hmac.new(secret.encode(),body,hashlib.sha256).hexdigest()})
 with urllib.request.urlopen(request,timeout=25) as response:return json.load(response)

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--phase',choices=['install','enable'],required=True)
 parser.add_argument('--receiver-last4',action='append',required=True)
 parser.add_argument('--since',required=True)
 args=parser.parse_args()
 if os.geteuid()!=0 or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',args.since):raise RuntimeError('Invalid installation arguments')
 env=environment();allowed=env.get('ALIGO_PARKING_ADMIN_RECEIVERS','').split(',');receivers=[]
 for suffix in args.receiver_last4:
  matches=[p.strip() for p in allowed if re.fullmatch(r'01[016789]\d{7,8}',p.strip()) and p.strip().endswith(suffix)]
  if len(matches)!=1:raise RuntimeError('Recipient must match existing allowlist uniquely')
  receivers+=matches
 secret=env['ALIGO_RELAY_SECRET'];sf_secret=Path('/etc/caddy/socialfactory-aligo.secret').read_text().strip()
 status=lambda:rpc(8790,'/v1/amano',secret,'X-Megaspot-Signature',{'action':'status'})
 sf_status=lambda:rpc(8790,'/v1/socialfactory-amano',sf_secret,'X-Socialfactory-Signature',{'action':'status'})
 before,sf_before=status(),sf_status()
 if before.get('busy'):raise RuntimeError('Wait for the registration cycle to finish')
 sources={AMANO/name:HERE/name for name in ['alerts.mjs','socialfactory.mjs','paid-alerts.mjs']}
 if args.phase=='install':
  for target,digest in BASE.items():
   if hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise RuntimeError('Runtime changed: '+str(target))
  relay=extend_relay(RELAY.read_text())
  server=extend_server((AMANO/'server.mjs').read_text())
 else:
  for target,source in sources.items():
   if target.read_bytes()!=source.read_bytes():raise RuntimeError('Installed source mismatch')
  if 'async paymentOid=>' not in (AMANO/'server.mjs').read_text():raise RuntimeError('Immediate processing route missing')
  # Activation verifies the deployed site's signed payment API without sending.
  body=json.dumps({'action':'payments','since':args.since+' 00:00:00','time':int(time.time()*1000)},separators=(',',':')).encode()
  request=urllib.request.Request('https://socialfactory.co.kr/api/parking/automation/server',data=body,headers={'Content-Type':'application/json','User-Agent':'SocialfactoryParking/1.0 (+https://socialfactory.co.kr)','X-Socialfactory-Signature':hmac.new(sf_secret.encode(),body,hashlib.sha256).hexdigest()})
  with urllib.request.urlopen(request,timeout=25) as response:feed=json.load(response)
  if not feed.get('ok'):raise RuntimeError('Payment feed is not ready')
 paths=[*sources,AMANO/'server.mjs',RELAY,ENV,TIMER]
 backup=Path('/root/backups/socialfactory-paid-'+args.phase+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S'))
 backup.mkdir(parents=True,mode=0o700);existing={}
 for i,path in enumerate(paths):
  existing[path]=path.exists()
  if existing[path]:shutil.copy2(path,backup/str(i))
 run('systemctl','stop','megaspot-amano-tick.timer')
 changed=False
 try:
  if status().get('busy'):raise RuntimeError('Registration cycle is busy')
  if args.phase=='install':
   for target,digest in BASE.items():
    if hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise RuntimeError('Concurrent runtime change')
  if ENV.read_bytes()!=(backup/str(paths.index(ENV))).read_bytes():raise RuntimeError('Concurrent environment change')
  changed=True
  if args.phase=='install':
   for target,source in sources.items():shutil.copyfile(source,target)
   RELAY.write_text(relay)
   (AMANO/'server.mjs').write_text(server)
   shutil.copyfile(HERE/'socialfactory-24h.conf',TIMER)
  text=ENV.read_text()
  for key,value in {'SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS':','.join(dict.fromkeys(receivers)),
   'SOCIALFACTORY_PARKING_PAID_ADMIN_SINCE':args.since+' 00:00:00',
   'SOCIALFACTORY_PARKING_PAID_ADMIN_ENABLED':'1' if args.phase=='enable' else '0'}.items():
   text=re.sub(r'^'+key+r'=.*\n?','',text,flags=re.M)
   text=text.rstrip()+'\n'+key+'='+value+'\n'
  ENV.write_text(text);ENV.chmod(0o600)
  for target in [*sources,AMANO/'server.mjs',RELAY]:run('node','--check',str(target))
  run('systemctl','daemon-reload')
  run('systemctl','restart','megaspot-aligo')
  run('systemctl','restart','megaspot-amano')
  for attempt in range(30):
   try:after,sf_after=status(),sf_status();break
   except Exception:
    if attempt==29:raise
    time.sleep(.25)
  for key in ['configured','enabled']:
   if after.get(key)!=before.get(key) or sf_after.get(key)!=sf_before.get(key):raise RuntimeError('Registration settings changed')
  if sf_after.get('paid_alerts_enabled')!=(args.phase=='enable') or sf_after.get('paid_alert_receivers')!=args.receiver_last4:raise RuntimeError('Paid notification settings mismatch')
  run('systemctl','start','megaspot-amano-tick.timer')
  schedule=run('systemctl','show','megaspot-amano-tick.timer','--property=TimersCalendar')
  if '*-*-* *:*:00' not in schedule:raise RuntimeError('One-minute schedule mismatch')
  print(json.dumps({'ok':True,'phase':args.phase,'backup':str(backup),'paid_alerts_enabled':sf_after['paid_alerts_enabled'],'receiver_last4':sf_after['paid_alert_receivers'],'schedule':schedule.strip()}))
 except Exception:
  if changed:
   for i,path in enumerate(paths):
    if existing[path]:shutil.copy2(backup/str(i),path)
    else:path.unlink(missing_ok=True)
   run('systemctl','daemon-reload');run('systemctl','restart','megaspot-aligo');run('systemctl','restart','megaspot-amano')
  raise
 finally:run('systemctl','start','megaspot-amano-tick.timer')

if __name__=='__main__':main()
