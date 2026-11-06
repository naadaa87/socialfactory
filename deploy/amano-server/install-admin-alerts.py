#!/usr/bin/env python3
"""Install only reviewed runtime files; never send a test message or register a car."""
from pathlib import Path
import argparse
import datetime
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request

HERE = Path(__file__).resolve().parent
AMANO = Path('/opt/megaspot-amano')
RELAY = Path('/opt/megaspot-aligo/server.mjs')
ENV = Path('/etc/megaspot-aligo.env')
BASE = {
    AMANO / 'alerts.mjs': 'ff5794afcf75c9d2f791ef1fa446a778c01d2beb8d2549596d58049ebe1a94a8',
    AMANO / 'socialfactory.mjs': '15ce4601cf5dde66cfb1cbee7a569d47b36b323b282131fd78e2fa2fee63d908',
    AMANO / 'tick.mjs': '0a0afffa7d7907a84410c9a5da7460daa91dafc582a0689002b0f0e80ac3cc78',
    RELAY: '9326a1552df2c92264fa371b4ae7572b0ff92270871707b0392ee803c0fbde4f',
}


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def environment():
    values = {}
    for line in ENV.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            values[k.strip()] = v.strip().strip('"\'')
    return values


def rpc(port, path, secret, header, payload):
    body = json.dumps({**payload, 'time': int(time.time() * 1000)}, separators=(',', ':')).encode()
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=body, headers={
        'Content-Type': 'application/json', header: hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receiver-last4', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'\d{4}', args.receiver_last4):
        raise RuntimeError('Root and an approved recipient suffix are required')
    for path, digest in BASE.items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Runtime source changed; review before deploying: ' + str(path))
    env = environment()
    allowed = [p.strip() for p in env.get('ALIGO_PARKING_ADMIN_RECEIVERS', '').split(',')]
    matches = [p for p in allowed if re.fullmatch(r'01[016789]\d{7,8}', p) and p.endswith(args.receiver_last4)]
    if len(matches) != 1:
        raise RuntimeError('Recipient must uniquely match the existing administrator allowlist')
    secret = env['ALIGO_RELAY_SECRET']
    sf_secret = Path('/etc/caddy/socialfactory-aligo.secret').read_text().strip()
    status = lambda: rpc(8790, '/v1/amano', secret, 'X-Megaspot-Signature', {'action': 'status'})
    sf_status = lambda: rpc(8790, '/v1/socialfactory-amano', sf_secret, 'X-Socialfactory-Signature', {'action': 'status'})
    before, sf_before = status(), sf_status()
    if before.get('busy') or not before.get('configured'):
        raise RuntimeError('Wait for the active registration cycle to finish')
    run('systemctl', 'is-active', '--quiet', 'megaspot-amano', 'megaspot-aligo', 'megaspot-amano-tick.timer')
    backup = Path('/root/backups/socialfactory-admin-alerts-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, mode=0o700)
    for i, path in enumerate([*BASE, ENV]):
        shutil.copy2(path, backup / str(i))
    sources = {AMANO / name: HERE / name for name in ['alerts.mjs', 'socialfactory.mjs', 'tick.mjs']}
    sources[RELAY] = HERE / 'aligo-relay.mjs'
    # Compile every proposed module before stopping the scheduler.
    for source in sources.values():
        run('/usr/bin/node', '--check', str(source))
    changed = False
    run('systemctl', 'stop', 'megaspot-amano-tick.timer')
    try:
        if status().get('busy'):
            raise RuntimeError('A registration cycle started before the timer was stopped')
        for path, digest in BASE.items():
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Concurrent runtime change detected')
        if ENV.read_bytes() != (backup / str(len(BASE))).read_bytes():
            raise RuntimeError('Concurrent environment change detected')
        changed = True
        for target, source in sources.items():
            shutil.copyfile(source, target)
        text = ENV.read_text()
        text = re.sub(r'^SOCIALFACTORY_PARKING_ADMIN_RECEIVERS=.*\n?', '', text, flags=re.M)
        ENV.write_text(text.rstrip() + '\nSOCIALFACTORY_PARKING_ADMIN_RECEIVERS=' + matches[0] + '\n')
        ENV.chmod(0o600)
        run('systemctl', 'restart', 'megaspot-aligo')
        run('systemctl', 'restart', 'megaspot-amano')
        for attempt in range(30):
            try:
                after, sf_after = status(), sf_status()
                relay = rpc(8787, '/v1/aligo', secret, 'X-Megaspot-Signature', {
                    'path': 'socialfactory-admin/status', 'data': {},
                    'request_id': '00000000-0000-4000-a000-000000000000'})
                break
            except Exception:
                if attempt == 29:
                    raise
                time.sleep(.25)
        for key in ['configured', 'enabled']:
            if after.get(key) != before.get(key) or sf_after.get(key) != sf_before.get(key):
                raise RuntimeError('Registration settings changed unexpectedly')
        if not relay.get('ready') or relay.get('receiver_last4') != [args.receiver_last4] or not sf_after.get('error_alerts_enabled') or sf_after.get('error_alert_receivers') != [args.receiver_last4]:
            raise RuntimeError('Administrator alert route or recipient verification failed')
        run('systemctl', 'start', 'megaspot-amano-tick.timer')
        run('systemctl', 'is-active', '--quiet', 'megaspot-amano', 'megaspot-aligo', 'megaspot-amano-tick.timer')
        schedule = run('systemctl', 'show', 'megaspot-amano-tick.timer', '--property=TimersCalendar')
        if '*-*-* *:00/5:00' not in schedule or 'Mon..Fri' in schedule:
            raise RuntimeError('The 24-hour timer schedule must be preserved')
        print(json.dumps({'ok': True, 'backup': str(backup), 'receiver_last4': [args.receiver_last4],
                          'error_alerts_enabled': True, 'registration_settings_preserved': True,
                          'test_messages_sent': 0, 'relay_status_ready': relay['ready']}))
    except Exception:
        if changed:
            for i, path in enumerate([*BASE, ENV]):
                shutil.copy2(backup / str(i), path)
            run('systemctl', 'restart', 'megaspot-aligo')
            run('systemctl', 'restart', 'megaspot-amano')
        raise
    finally:
        run('systemctl', 'start', 'megaspot-amano-tick.timer')


if __name__ == '__main__':
    main()
