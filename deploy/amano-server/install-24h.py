#!/usr/bin/env python3
"""Extend the existing shared timer without restarting the registration server."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess

TIMER = 'megaspot-amano-tick.timer'
TARGET = Path('/etc/systemd/system/megaspot-amano-tick.timer.d/socialfactory-24h.conf')
SOURCE = Path(__file__).with_name('socialfactory-24h.conf')


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run as root on the existing Amano server')
    run('systemctl', 'is-active', '--quiet', 'megaspot-amano', TIMER)
    desired = SOURCE.read_bytes()
    if desired.count(b'OnCalendar=') != 2 or b'OnCalendar=*-*-* *:*:00 Asia/Seoul' not in desired:
        raise RuntimeError('Unexpected timer configuration')
    # Validate the exact calendar with the host systemd before any write.
    calendar = '*-*-* *:*:00 Asia/Seoul'
    checks = {}
    for at in ['2026-11-06 18:01:00 Asia/Seoul', '2026-11-07 01:31:00 Asia/Seoul',
               '2026-11-08 03:01:00 Asia/Seoul', '2026-12-25 22:31:00 Asia/Seoul']:
        checks[at] = run('systemd-analyze', 'calendar', '--base-time=' + at, '--iterations=3', calendar).strip()
    before = TARGET.read_bytes() if TARGET.exists() else None
    if before == desired:
        print(json.dumps({'ok': True, 'already_installed': True, 'calendar': calendar, 'checks': checks}))
        return
    backup = Path('/root/backups/socialfactory-24h-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, mode=0o700)
    if before is not None:
        (backup / TARGET.name).write_bytes(before)
    (backup / 'timer-before.txt').write_text(run('systemctl', 'cat', TIMER))
    try:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE, TARGET)
        TARGET.chmod(0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', TIMER)
        run('systemctl', 'is-active', '--quiet', 'megaspot-amano', TIMER)
        actual = run('systemctl', 'show', TIMER, '--property=TimersCalendar')
        if '*-*-* *:*:00' not in actual or 'Mon..Fri' in actual:
            raise RuntimeError('Unexpected active schedule')
    except Exception:
        if before is None:
            TARGET.unlink(missing_ok=True)
        else:
            TARGET.write_bytes(before)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', TIMER)
        raise
    print(json.dumps({'ok': True, 'backup': str(backup), 'calendar': calendar,
                      'checks': checks, 'active_schedule': actual.strip()}))


if __name__ == '__main__':
    main()
