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
from stage import MATRIX, SEYMOUR
from threading import Timer

run = Path(sys.argv[1]).resolve(strict=True)
launch = json.loads((run / 'launch.json').read_text())
identity = json.loads((run / 'identity.json').read_text())
hours = float(launch['HOURS'])
allowed_pilot = launch['TASK'] == 'putnam_2025_b1' and identity['workers'] == 2 and 0 < hours <= 0.5
allowed_long = launch['TASK'] == 'flt10_q20_reducible_cofixed' and identity['workers'] == 4 and hours == 8
seymour = launch['TASK'] == SEYMOUR and identity['workers'] == 4 and hours == 4
if not (allowed_pilot or allowed_long or seymour):
    raise SystemExit('Run matrix differs from Issue #157')
profile = launch['PROFILE']
checkout = run / 'upstream'
bits = dict(line.split('=', 1) for line in (checkout / ('.env.' + profile)).read_text().splitlines()
            if '=' in line and not line.startswith('#'))
if (bits['AGENT_HARNESS'], bits['LLM_MODEL'], int(bits['AGENSH_WORKERS'])) != ('pi', MATRIX[launch['TASK']][2], identity['workers']):
    raise SystemExit('Runtime profile differs from the approved Pi team')
image = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', bits['AGENT_IMAGE']], text=True).strip()
if image != identity['image']:
    raise SystemExit('Worker image drifted after staging')
if snapshot(run) != json.loads((run / 'input-manifest.json').read_text()):
    raise SystemExit('Staged source, runtime, deployment, fixture or image identity drifted')
if seymour:
    # Before any worker is mounted, verify the live compiler and library bytes
    # against the original artifact lock in the operator verifier namespace.
    subprocess.run(['node', str(Path(__file__).with_name('domain.mjs')), 'preflight'],
                   env={**os.environ, **launch, 'AGENSH_TASK': SEYMOUR}, check=True)
clock = run / 'clock'
(clock / 'started').touch(exist_ok=False)
launch_time = time.time()
(clock / 'launch.json').write_text(json.dumps({'launch_unix': launch_time}) + '\n')
def close_window():
    # Finalize through the native control watcher so export and Judge still run.
    out = Path(launch['OUT_DIR']) / launch['TASK']
    if out.is_dir():
        (out / 'control').write_text('finalize\n')

timer = Timer(hours * 3600, close_window) if seymour else None
if timer:
    timer.daemon = True
    timer.start()
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
            tmp.write_text(str((launch_time if seymour else start) + hours * 3600))
            tmp.replace(clock / 'deadline')
    sys.exit(process.wait())
finally:
    if timer:
        timer.cancel()
    (clock / 'deadline').unlink(missing_ok=True)
