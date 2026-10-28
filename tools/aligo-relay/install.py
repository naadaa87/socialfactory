#!/usr/bin/env python3
"""기존 Caddy 경로를 보존해 소셜팩토리 전용 경로만 추가합니다. 비밀값은 출력하지 않습니다."""
import datetime
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import urllib.request

MAIN = Path('/etc/caddy/Caddyfile')
SNIPPET = Path('/etc/caddy/socialfactory-aligo.caddy')
SECRET = Path('/etc/caddy/socialfactory-aligo.secret')
IMPORT = '\n\timport /etc/caddy/socialfactory-aligo.caddy\n'
PATH = '/socialfactory/aligo/send'


def command(args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        # Caddy 오류에 설정 줄과 비밀이 포함될 수 있어 원문은 출력하지 않습니다.
        raise RuntimeError('명령 실패: ' + args[0])
    return result.stdout


def adapt(path):
    return json.loads(command(['caddy', 'adapt', '--config', str(path), '--adapter', 'caddyfile']))


def prune_new_route(value):
    if isinstance(value, dict):
        return {key: prune_new_route(item) for key, item in value.items()}
    if isinstance(value, list):
        return [prune_new_route(item) for item in value if not (
            isinstance(item, dict) and any(PATH in match.get('path', []) for match in item.get('match', []))
        )]
    return value


def normalize_groups(config):
    # adapt가 매번 붙이는 group 번호 자체는 달라도 됩니다. 그룹 간 동등 관계는 보존합니다.
    groups = {}

    def visit(value):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key == 'group' and isinstance(item, str):
                    result[key] = groups.setdefault(item, 'group-' + str(len(groups)))
                else:
                    result[key] = visit(item)
            return result
        if isinstance(value, list):
            return [visit(item) for item in value]
        return value

    return visit(config)


def private_write(path, data, mode=0o600, caddy_group=False):
    with path.open('wb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
    if caddy_group:
        os.chown(path, 0, grp.getgrnam('caddy').gr_gid)


def service_ids():
    return command(['systemctl', 'show', 'caddy', 'naranhi-commerce', '-p', 'Id', '-p', 'MainPID', '-p', 'ActiveState']).decode()


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root로 실행해야 합니다')
    original = MAIN.read_bytes()
    if SNIPPET.exists() or SECRET.exists() or IMPORT.strip().encode() in original:
        raise RuntimeError('이미 설치된 파일이 있어 자동으로 덮어쓰지 않습니다')
    old = adapt(MAIN)
    if prune_new_route(old) != old:
        raise RuntimeError('동일한 전용 경로가 이미 있습니다')
    active = json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/', timeout=5))
    if old != active:
        raise RuntimeError('디스크 설정과 실행 설정이 다릅니다. 자동 변경을 중단합니다')
    if b'log_credentials' in original or '"should_log_credentials": true' in json.dumps(old):
        raise RuntimeError('인증 헤더 로그 설정을 먼저 확인해야 합니다')
    match = list(re.finditer(rb'(?m)^relay\.naranhistory\.com\s*\{\s*$', original))
    if len(match) != 1:
        raise RuntimeError('예상한 단일 호스트 블록이 아닙니다')
    before_services = service_ids()
    if before_services.count('ActiveState=active') != 2:
        raise RuntimeError('기존 서비스가 정상 실행 중이 아닙니다')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/root/socialfactory-aligo-backup-' + stamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(MAIN, backup / 'Caddyfile')
    private_write(backup / 'adapted-before.json', json.dumps(old).encode())
    private_write(backup / 'service-ids-before.txt', before_services.encode())
    secret = secrets.token_urlsafe(32)
    template = Path(__file__).with_name('relay.caddy').read_text()
    private_write(SECRET, secret.encode())
    private_write(SNIPPET, template.replace('__SOCIALFACTORY_RELAY_SECRET__', secret).encode(), 0o640, True)
    candidate = MAIN.with_name('.Caddyfile.socialfactory-candidate')
    offset = match[0].end()
    proposed = original[:offset] + IMPORT.encode() + original[offset:]
    private_write(candidate, proposed, 0o640, True)
    changed = False
    try:
        updated = adapt(candidate)
        if normalize_groups(prune_new_route(updated)) != normalize_groups(old):
            raise RuntimeError('기존 경로에 차이가 발견되어 변경을 중단합니다')
        command(['runuser', '-u', 'caddy', '--', 'caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'])
        if MAIN.read_bytes() != original:
            raise RuntimeError('설정이 동시에 수정되어 변경을 중단합니다')
        os.replace(candidate, MAIN)
        changed = True
        command(['systemctl', 'reload', 'caddy'])
        loaded = json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/', timeout=5))
        if loaded != updated or normalize_groups(prune_new_route(loaded)) != normalize_groups(old):
            raise RuntimeError('반영된 설정 검증 실패')
        if service_ids() != before_services:
            raise RuntimeError('서비스 상태 또는 PID 변경 발견')
    except Exception:
        if changed:
            shutil.copy2(backup / 'Caddyfile', MAIN)
            command(['systemctl', 'reload', 'caddy'])
        SNIPPET.unlink(missing_ok=True)
        SECRET.unlink(missing_ok=True)
        raise
    finally:
        candidate.unlink(missing_ok=True)
    print(json.dumps({'installed': True, 'existing_routes_unchanged': True, 'services_not_restarted': True,
                      'before_sha256': hashlib.sha256(original).hexdigest(), 'backup': str(backup)}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('중단: ' + str(error), file=sys.stderr)
        sys.exit(1)
