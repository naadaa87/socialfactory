#!/usr/bin/env python3
"""Extend the existing authenticated parking server; keep Socialfactory automation off."""
from pathlib import Path
import subprocess, shutil, hashlib, json, re, hmac, urllib.request, datetime, os
ROOT=Path(__file__).resolve().parents[2]
LIVE=Path('/opt/megaspot-amano')
BASE={'server.mjs':'f7b750f94bbedc24b1697ff2ccdc5f7712cef314b0f55229925c9be64d5a4b01','client.mjs':'6db765cb1e1f56d1fe25c168313b2bdfdff535a4aaf66fe9ef4f8a9c0c08df3f'}
if os.geteuid()!=0:raise SystemExit('Root is required for the existing service installation.')
for name,digest in BASE.items():
 if hashlib.sha256((LIVE/name).read_bytes()).hexdigest()!=digest:raise SystemExit('Existing server changed; review before deploying: '+name)
def environment(path):
 values={}
 for line in path.read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1);values[k.strip()]=v.strip().strip('"').strip("'")
 return values
mega_secret=environment(Path('/etc/megaspot-aligo.env'))['ALIGO_RELAY_SECRET']
sf_secret=Path('/etc/caddy/socialfactory-aligo.secret').read_text().strip()
if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',sf_secret):raise SystemExit('Existing Socialfactory signing key format needs review.')
def rpc(url,secret,header,action='status'):
 body=json.dumps({'action':action,'time':int(datetime.datetime.now().timestamp()*1000)},separators=(',',':')).encode()
 r=urllib.request.Request(url,data=body,headers={'Content-Type':'application/json',header:hmac.new(secret.encode(),body,hashlib.sha256).hexdigest()})
 with urllib.request.urlopen(r,timeout=30) as response:return json.load(response)
before=rpc('http://127.0.0.1:8790/v1/amano',mega_secret,'X-Megaspot-Signature')
if before.get('busy'):raise SystemExit('Existing registration cycle is busy. Wait for completion before restarting.')
if not before.get('configured'):raise SystemExit('Existing Amano account must be connected first.')
backup=Path('/root/backups/socialfactory-amano-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir(parents=True,mode=0o700)
changes=[LIVE/'server.mjs',LIVE/'client.mjs',LIVE/'socialfactory.mjs',Path('/etc/caddy/Caddyfile'),Path('/etc/caddy/socialfactory-amano.caddy'),Path('/etc/megaspot-amano-socialfactory.env'),Path('/etc/systemd/system/megaspot-amano.service.d/socialfactory.conf')]
saved={}
for i,p in enumerate(changes):
 saved[p]=p.exists()
 if p.exists():shutil.copy2(p,backup/str(i))
def run(*args):
 p=subprocess.run(args,capture_output=True,text=True)
 (backup/'installation.log').open('a').write('COMMAND '+args[0]+'\n'+p.stdout+p.stderr+'\n')
 if p.returncode:raise RuntimeError('Installation command failed: '+args[0])
try:
 for name in ['server.mjs','client.mjs','socialfactory.mjs']:shutil.copy2(ROOT/'deploy/amano-server'/name,LIVE/name)
 Path('/etc/megaspot-amano-socialfactory.env').write_text('SOCIALFACTORY_RELAY_SECRET='+sf_secret+'\n');os.chmod('/etc/megaspot-amano-socialfactory.env',0o600)
 drop=Path('/etc/systemd/system/megaspot-amano.service.d/socialfactory.conf');drop.parent.mkdir(parents=True,exist_ok=True);drop.write_text('[Service]\nEnvironmentFile=/etc/megaspot-amano-socialfactory.env\n')
 shutil.copy2(ROOT/'deploy/amano-server/socialfactory-amano.caddy','/etc/caddy/socialfactory-amano.caddy')
 config=Path('/etc/caddy/Caddyfile');text=config.read_text();anchor='import /etc/caddy/megaspot-amano.caddy'
 if anchor not in text:raise RuntimeError('Existing Caddy host layout changed.')
 if 'import /etc/caddy/socialfactory-amano.caddy' not in text:config.write_text(text.replace(anchor,anchor+'\n    import /etc/caddy/socialfactory-amano.caddy',1))
 run('/usr/bin/node','--check',str(LIVE/'server.mjs'));run('/usr/bin/node','--check',str(LIVE/'client.mjs'));run('/usr/bin/node','--check',str(LIVE/'socialfactory.mjs'))
 run('/usr/bin/caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile')
 run('/usr/bin/systemctl','daemon-reload');run('/usr/bin/systemctl','restart','megaspot-amano');run('/usr/bin/systemctl','reload','caddy')
 # systemd reports active before the application's listening socket is ready.
 import time
 for attempt in range(20):
  try:after=rpc('http://127.0.0.1:8790/v1/amano',mega_secret,'X-Megaspot-Signature');break
  except Exception:
   if attempt==19:raise
   time.sleep(.25)
 sf=rpc('https://relay.naranhistory.com/socialfactory/amano',sf_secret,'X-Socialfactory-Signature')
 if after.get('configured')!=before.get('configured') or after.get('enabled')!=before.get('enabled') or not sf.get('configured') or sf.get('enabled'):raise RuntimeError('Post-deployment state differs from the reviewed configuration.')
 run('/usr/bin/systemctl','is-active','megaspot-amano','megaspot-amano-tick.timer','caddy')
 print(json.dumps({'ok':True,'backup':str(backup),'megaspot_unchanged':True,'socialfactory_configured':sf['configured'],'socialfactory_enabled':sf['enabled']}))
except Exception:
 for i,p in enumerate(changes):
  if saved[p]:shutil.copy2(backup/str(i),p)
  elif p.exists():p.unlink()
 subprocess.run(['/usr/bin/systemctl','daemon-reload'],capture_output=True)
 subprocess.run(['/usr/bin/systemctl','restart','megaspot-amano'],capture_output=True)
 subprocess.run(['/usr/bin/systemctl','reload','caddy'],capture_output=True)
 raise SystemExit('Installation rolled back. Private diagnostic log: '+str(backup/'installation.log'))
