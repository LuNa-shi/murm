"""Prepare a fresh native team checkout/profile. Starting the driver is a separate step."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlsplit, urlunsplit
import sys
sys.dont_write_bytecode = True
from manifest import snapshot
import seymour_inputs

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / 'integrations' / 'agensh'
UPSTREAM = ROOT / 'third_party' / 'agensh'
PIN = '2dae4e14a653da48549fd9aa093f834841475d6c'
SEYMOUR = 'oai_seymour_second_neighborhood'
MATRIX = {'putnam_2025_b1': (2, '0.5', 'gpt-6.1-sol', '1.4.0'),
          'flt10_q20_reducible_cofixed': (4, '8', 'gpt-6.1-sol', '1.4.0'),
          SEYMOUR: (4, '4', 'gpt-6.2-sol', '1.3.0')}


def mount(source, target):
    return {'type': 'bind', 'source': str(Path(source).resolve(strict=True)), 'target': target,
            'read_only': True, 'bind': {'create_host_path': False}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('deployment', 'fixture', 'run-dir', 'provider-catalog'):
        parser.add_argument('--' + option, required=True, type=Path)
    parser.add_argument('--task', choices=MATRIX, required=True)
    parser.add_argument('--worker-image', required=True)
    parser.add_argument('--profile-suffix', required=True)
    parser.add_argument('--research-seconds', type=int, help='Remaining wall seconds in the approved pilot allowance')
    args = parser.parse_args()
    workers, hours, model, version = MATRIX[args.task]
    deployment = json.loads(args.deployment.read_text())
    if args.task == SEYMOUR:
        seymour_inputs.validate(deployment, args.fixture)
    if args.research_seconds is not None:
        if args.task != 'putnam_2025_b1' or not 0 < args.research_seconds <= 1800:
            raise ValueError('Only the short pilot may use a reduced window')
        hours = str(args.research_seconds / 3600)
    run = args.run_dir.resolve()
    if not run.is_relative_to(ROOT / 'experiments'):
        raise ValueError('Keep private state in the ignored experiments directory')
    os.umask(0o077)
    run.mkdir(parents=True, exist_ok=False)
    checkout = run / 'upstream'
    # Container service UIDs need to read the public upstream SQL and scripts.
    os.umask(0o022)
    subprocess.run(['git', 'clone', '--no-hardlinks', '--quiet', str(UPSTREAM), checkout], check=True)
    subprocess.run(['git', 'checkout', '--quiet', '--detach', PIN], cwd=checkout, check=True)
    shutil.copytree(HERE / 'lean-proof', checkout / 'tasks/lean-proof')
    os.umask(0o077)
    provider = json.loads(args.provider_catalog.read_text())['providers']['gpt_proxy']
    if provider['api'] != 'openai-responses' or model not in {m['id'] for m in provider['models']}:
        raise ValueError('Provider must support the approved Responses model')
    base = urlsplit(provider['baseUrl'])
    if base.scheme not in ('http', 'https') or not base.hostname or base.username or base.password or base.query or base.fragment or not base.path.endswith('/v1'):
        raise ValueError('Expected an explicit Responses v1 URL')
    headers = provider.get('headers', {})
    if any(not isinstance(v, str) or not v or v.startswith(('$', '!')) for v in [provider['apiKey'], *headers.values()]):
        raise ValueError('Supply resolved provider credentials in the private catalog')
    route = run / 'route.json'
    route.write_text(json.dumps({**{k: provider.get(k, {}) for k in ('apiKey', 'headers', 'baseUrl')}, 'model': model}))
    # gen_env writes only a local placeholder credential; the actual one stays in route.json.
    env = dict(os.environ, LLM_UPSTREAM=urlunsplit(base._replace(path=base.path[:-3])), LLM_UPSTREAM_TOKEN='local-transport',
               TASKS=args.task, PROFILE_SUFFIX=args.profile_suffix, WORKERS=str(workers), LLM_MODEL=model,
               REASONING_EFFORT='high', WORKER_MEMORY='8g', WORKER_CPUS='4')
    if args.task == SEYMOUR:
        # Native Pi uses floor(0.95 * PROMPT_TOKENS) as the model's context window.
        env.update(REASONING_EFFORT='medium', PROMPT_TOKENS='526316', OUTPUT_TOKENS='128000')
    subprocess.run(['bash', 'tasks/programbench/scripts/gen_env.sh', '--agent-harness', 'pi',
                    '--harness-version', version], cwd=checkout, env=env, check=True)
    profile_path, = checkout.glob('.env.programbench-*')
    profile = profile_path.name.removeprefix('.env.')
    lines = profile_path.read_text().splitlines()
    image = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.worker_image], text=True).strip()
    updates = {'AGENT_IMAGE': args.worker_image, 'AGENSH_PACK': 'lean-proof', 'AGENSH_MAX_MODEL_TOKENS': '0'}
    for key, name in [('MINI_ROUTER_IMAGE', 'mini-router'), ('BOARD_IMAGE', 'board')]:
        tag = f'swarmenv/agensh-{name}:157-2dae4e1'
        subprocess.run(['docker', 'image', 'inspect', tag], check=True, stdout=subprocess.DEVNULL)
        updates[key] = tag
    updates['BOOTSTRAP_IMAGE'] = 'swarmenv/agensh-bootstrap:157-2dae4e1'
    updates['SECRET_SERVICE_IMAGE'] = 'swarmenv/agensh-secret-service:157-2dae4e1'
    lines = [line for line in lines if line.partition('=')[0] not in updates]
    profile_path.write_text('\n'.join(lines + [f'{k}={v}' for k, v in updates.items()]) + '\n')
    checker = deployment['final_tree_checker']
    diagnostic = 'seymour-lean-check' if args.task == SEYMOUR else 'lean-check'
    lean = Path(checker['leanRoot'])
    volumes = ([mount(lean / name, '/opt/lean/' + name) for name in ('bin', 'lib')]
               if args.task == SEYMOUR else [mount(lean, '/opt/lean')])
    volumes.append(mount(HERE / diagnostic, '/usr/local/bin/lean-check'))
    if args.task == SEYMOUR:
        # Agensh's model metadata hardcodes 16k. Use the baseline catalog value
        # while keeping the upstream ACP loop, prompt composition and router.
        config = (checkout / 'agent/pi/config.py').read_text()
        needle = "'maxTokens': 16384"
        if config.count(needle) != 1:
            raise ValueError('Unexpected native Pi model metadata template')
        matched = run / 'pi-config.py'
        matched.write_text(config.replace(needle, "'maxTokens': 128000"))
        matched.chmod(0o644)
        volumes.append(mount(matched, '/opt/omcgitea/pi/config.py'))
    libraries = []
    for i, lib in enumerate(checker['libraryRoots']):
        target = f'/opt/lean-libraries/{i}'
        volumes.append(mount(lib, target))
        libraries.append(target)
    # Keep the mathlib sources available to search without importing Git history, other problems or prior proofs.
    mathlib = next(Path(p) for p in checker['libraryRoots'] if Path(p).parents[3].name == 'mathlib')
    source = mathlib.parents[3] / 'Mathlib'
    if args.task == SEYMOUR:
        source = run / 'public-mathlib'
        seymour_inputs.export_mathlib(mathlib.parents[3], seymour_inputs.MATHLIB, source)
    volumes.append(mount(source, '/opt/mathlib-source/Mathlib'))
    services = {f'agent-worker{i}': {'environment': {'AGENSH_LEAN_LIBRARIES': ':'.join(libraries)},
                                      'volumes': volumes} for i in range(1, workers + 1)}
    clock = run / 'clock'
    clock.mkdir()
    services['gitea'] = {'environment': {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.logAllRefUpdates',
                                           'GIT_CONFIG_VALUE_0': 'always'}}
    services['egress-proxy'] = {'volumes': [mount(route, '/run/agensh-provider/route.json'),
                                            mount(clock, '/run/agensh-clock'),
                                            mount(HERE / 'provider_transport.py', '/opt/provider_transport.py')],
                                'command': ['python3', '/opt/provider_transport.py']}
    overlay = run / 'math-compose.json'
    overlay.write_text(json.dumps({'services': services}, indent=2))
    launch = dict(SWARMENV_ROOT=str(ROOT), AGENSH_DEPLOYMENT=str(args.deployment.resolve(strict=True)),
                  AGENSH_FIXTURE_ROOT=str(args.fixture.resolve(strict=True)), AGENSH_PACK='lean-proof', TASK=args.task,
                  PROFILE=profile, HOURS=hours, OUT_DIR=str(run / 'out'), COMPOSE_EXTRA_FILES=str(overlay))
    (run / 'launch.json').write_text(json.dumps(launch, indent=2))
    (run / 'identity.json').write_text(json.dumps(dict(upstream=PIN, image=image, workers=workers, hours=hours,
                                                        harness='pi', version=version, provider='gpt_proxy', model=model)))
    (run / 'input-manifest.json').write_text(json.dumps(snapshot(run), sort_keys=True, indent=2))
    print(f'Prepared {profile}: {workers} Pi workers, {hours} research hours')


if __name__ == '__main__':
    main()
