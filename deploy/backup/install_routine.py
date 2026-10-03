"""Explicit root install of hourly pilot backup controller; never starts timers.

Run only from a root-owned reviewed staging directory. No credential rotation,
cloud permissions, restore, application restart or deployment policy mutation.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

import backup as b
import notify
import routine

FILES = ['backup.py', 'notify.py', 'routine.py',
         'systemd/citygo-backup-routine.service.template',
         'systemd/citygo-backup-routine.timer',
         'systemd/citygo-backup-routine-check.service.template',
         'systemd/citygo-backup-routine-check.timer']


def install():
    b.require(os.geteuid() == 0, 'root-required')
    source = b.protected(Path(__file__).resolve().parent, directory=True, private=False)
    data = {name: b.protected(source / name, private=False).read_bytes() for name in FILES}
    digest = hashlib.sha256(b''.join(name.encode() + b'\0' + data[name] for name in sorted(data))).hexdigest()
    destination = Path('/opt/citygo') / ('backup-routine-' + digest[:16])
    config = b.load_config('/etc/citygo/backup.json')
    b.require(config['project'] == 'citygo-pilot' and config['state_dir'] == '/var/lib/citygo-backup', 'pilot-layout')
    b.assert_operation_idle(Path(config['state_dir']))
    mail_path = Path('/etc/citygo/backup-mail.json')
    mail = notify.load(mail_path)
    b.require(mail['state_dir'] == '/var/lib/citygo-backup-email', 'mail-layout')
    mail['enabled'] = True
    receipt = Path(mail['state_dir']) / 'notification.json'
    if receipt.exists():
        b.require(b.read_json(b.protected(receipt))['channel'] == notify.fingerprint(mail), 'mail-channel-changed')
    target = Path('/etc/citygo/backup-routine.json')
    b.require(not target.exists() and not destination.exists(), 'already-installed')
    for name in ('citygo-backup.timer', 'citygo-backup-check.timer'):
        result = subprocess.run(['systemctl', 'is-enabled', name], capture_output=True)
        b.require(result.stdout.strip() not in (b'enabled', b'enabled-runtime'), 'trial-timer-enabled')
    destination.mkdir(mode=0o700)
    for name, content in data.items():
        path = destination / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(content)
        path.chmod(0o600)
    ops = Path('/var/lib/citygo-backup-routine')
    ops.mkdir(mode=0o700, exist_ok=True)
    b.protected(ops, directory=True)
    pins = {k: config[k] for k in routine.PIN_FIELDS - {'recipient_sha256'}}
    pins['recipient_sha256'] = hashlib.sha256(config['recipient'].encode()).hexdigest()
    policy = dict(version=1, enabled=True, backup_config='/etc/citygo/backup.json',
                  mail_config=str(mail_path), state_dir=str(ops), pins=pins)
    # Preserve the previous disabled-mail configuration for operator rollback.
    if not mail_path.with_suffix('.before-routine.json').exists():
        shutil.copyfile(mail_path, mail_path.with_suffix('.before-routine.json'))
        mail_path.with_suffix('.before-routine.json').chmod(0o600)
    b.atomic_json(mail_path, mail)
    b.atomic_json(target, policy)
    for name in FILES[3:]:
        unit = Path('/etc/systemd/system') / Path(name).name.removesuffix('.template')
        b.require(not unit.exists(), 'unit-already-present')
        unit.write_text(data[name].decode().replace('CONTROLLER_PATH', str(destination)), encoding='utf-8')
        unit.chmod(0o644)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    b.atomic_json(ops / 'installation.json', {'controller': str(destination), 'sha256': digest})
    print('Installed controller: ' + str(destination))
    print('Timers NOT started. Verify a service run before enabling timers.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-install-and-email', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        b.require(args.allow_install_and_email, 'explicit-approval')
        install()
    except Exception:
        print('CityGo routine installation failed; inspect protected configuration (details hidden).', file=sys.stderr)
        sys.exit(1)
