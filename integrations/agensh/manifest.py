"""Fingerprint inputs without saving credentials or source text in the manifest."""
import hashlib
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def public_source_digest(root):
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Invalid public Mathlib source mount')
    h = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not (path.is_dir() or path.is_file() and path.suffix == '.lean'):
            raise ValueError('Unexpected entry in public Mathlib snapshot')
        if path.is_file():
            h.update(str(path.relative_to(root)).encode() + b'\0' + bytes.fromhex(digest(path)))
    return h.hexdigest()


def snapshot(run):
    checkout = run / 'upstream'
    launch = json.loads((run / 'launch.json').read_text())
    git = lambda *args: subprocess.check_output(['git', '-C', checkout, *args], text=True).strip()
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Modified upstream tracked files')
    source = Path(launch['AGENSH_FIXTURE_ROOT'])
    dep = json.loads(Path(launch['AGENSH_DEPLOYMENT']).read_text())
    problem = next(p for p in dep['problems'] if p['id'] == launch['TASK'])
    files = {'launch': run / 'launch.json', 'overlay': run / 'math-compose.json', 'route': run / 'route.json',
             'profile': checkout / ('.env.' + launch['PROFILE']), 'deployment': launch['AGENSH_DEPLOYMENT'],
             'lock': dep['final_tree_checker']['artifactLock'], 'target': source / problem['problem_file']}
    if (run / 'pi-config.py').exists():
        files['pi-config'] = run / 'pi-config.py'
    if problem.get('context_manifest'):
        files['context_manifest'] = Path(dep['benchmark_context_root']) / problem['context_manifest']
    for p in (checkout / 'tasks/lean-proof').rglob('*'):
        if p.is_file():
            files['pack/' + str(p.relative_to(checkout / 'tasks/lean-proof'))] = p
    for p in HERE.iterdir():
        if p.is_file():
            files['integration/' + p.name] = p
    profile = dict(line.split('=', 1) for line in files['profile'].read_text().splitlines()
                   if line and line[0] != '#' and '=' in line)
    tags = [profile[k] for k in ('AGENT_IMAGE', 'MINI_ROUTER_IMAGE', 'BOARD_IMAGE', 'BOOTSTRAP_IMAGE', 'SECRET_SERVICE_IMAGE')]
    tags += ['python:3.13-slim', 'mysql:8.4', 'mattermost/mattermost-team-edition:10.6', 'nginx:1.27-alpine',
             'docker.gitea.com/gitea:1.22.6', 'gitea/act_runner:0.2.11']
    ids = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', *tags], text=True).splitlines()
    extra = {'public_mathlib_sha256': public_source_digest(run / 'public-mathlib')} if launch['TASK'] == 'oai_seymour_second_neighborhood' else {}
    return {**extra, 'upstream': git('rev-parse', 'HEAD'), 'fixture_commit': subprocess.check_output(
        ['git', '-C', source, 'rev-parse', 'HEAD'], text=True).strip(),
        'images': dict(zip(tags, ids, strict=True)), 'files': {k: digest(v) for k, v in files.items()}}
