"""Run the native driver, opening model egress at its first wake and fencing it at cutoff."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from manifest import snapshot

run = Path(sys.argv[1]).resolve(strict=True)
launch = json.loads((run / 'launch.json').read_text())
identity = json.loads((run / 'identity.json').read_text())
if (launch['HOURS'], identity['workers'], launch['TASK']) not in {
    ('0.5', 2, 'putnam_2025_b1'), ('8', 4, 'flt10_q20_reducible_cofixed')
}:
    raise SystemExit('Run matrix differs from Issue #157')
profile = launch['PROFILE']
checkout = run / 'upstream'
bits = dict(line.split('=', 1) for line in (checkout / ('.env.' + profile)).read_text().splitlines()
            if '=' in line and not line.startswith('#'))
if (bits['AGENT_HARNESS'], bits['LLM_MODEL'], int(bits['AGENSH_WORKERS'])) != ('pi', 'gpt-6.1-sol', identity['workers']):
    raise SystemExit('Runtime profile differs from the approved Pi team')
image = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', bits['AGENT_IMAGE']], text=True).strip()
if image != identity['image']:
    raise SystemExit('Worker image drifted after staging')
if snapshot(run) != json.loads((run / 'input-manifest.json').read_text()):
    raise SystemExit('Staged source, runtime, deployment, fixture or image identity drifted')
clock = run / 'clock'
(clock / 'started').touch(exist_ok=False)
process = subprocess.Popen(['bash', 'scripts/team_run.sh', '--pack', 'lean-proof'], cwd=checkout,
                           env={**{k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS') if k in os.environ},
                                **launch, 'AGENSH_PLANNING': '0'}, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, errors='replace')
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda number, _: process.send_signal(number))
try:
    for line in process.stdout:
        print(line, end='', flush=True)
        if line.startswith('[agensh] waking ') and not (clock / 'deadline').exists():
            start = time.time()
            (clock / 'wake.json').write_text(json.dumps({'wake_unix': start, 'hours': launch['HOURS']}) + '\n')
            tmp = clock / 'deadline.tmp'
            tmp.write_text(str(start + float(launch['HOURS']) * 3600))
            tmp.replace(clock / 'deadline')
    sys.exit(process.wait())
finally:
    (clock / 'deadline').unlink(missing_ok=True)
