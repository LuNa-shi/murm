"""Public inputs of the challenge-only Seymour arm matched to EXP-02."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

TARGET = 'benchmarks/openai-math-12/lean/ComparatorChallenges/SeymourSecondNeighborhood.lean'
TARGET_HASH = 'fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98'
FIXTURE = 'fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a'
MATHLIB = 'd13f23b723b8a846827a245b89c10fc7d3f11612'
LOCK = 'f0a85f1886c8fc546dfb925a9133908e1e69ff96c8bd4ddd80d303c4adadf891'


def validate(deployment, fixture):
    problem, = (p for p in deployment['problems'] if p['id'] == 'oai_seymour_second_neighborhood')
    expected = {'id': 'oai_seymour_second_neighborhood', 'problem_file': TARGET, 'source_sha256': TARGET_HASH,
                'declaration_name': 'OAI.SeymourSecondNeighborhood.exists_goodVertex'}
    if (any(problem.get(k) != v for k, v in expected.items()) or problem.get('context_manifest') is not None or
            deployment.get('benchmark') != 'openai_math_v1' or deployment.get('fixture_commit') != FIXTURE or
            deployment.get('mathlib_version') != MATHLIB or deployment.get('instructions_path')):
        raise ValueError('Seymour workers may receive only the original EXP-02 challenge')
    if hashlib.sha256((fixture / TARGET).read_bytes()).hexdigest() != TARGET_HASH:
        raise ValueError('Seymour challenge digest mismatch')
    checker = dict(deployment['final_tree_checker'])
    lock = json.loads(Path(checker.pop('artifactLock')).read_text())
    digest = lock.pop('sha256')
    canonical = json.dumps(lock, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    if digest != LOCK or hashlib.sha256(canonical).hexdigest() != LOCK or checker != lock['configuration']:
        raise ValueError('Worker mounts must come from the exact EXP-02 checker lock')


def export_mathlib(repo, revision, destination):
    # Only committed public Lean sources enter the worker bind mount. A shared
    # dependency checkout may also contain ignored and operator-private files.
    destination.mkdir(mode=0o755)
    destination.chmod(0o755)
    git = ['git', '--no-replace-objects', '-C', str(repo), 'archive', revision, 'Mathlib']
    with subprocess.Popen(git, stdout=subprocess.PIPE) as proc:
        try:
            with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
                for item in archive:
                    path = Path(item.name)
                    if path.parts[:1] != ('Mathlib',) or '..' in path.parts:
                        raise ValueError('Invalid path in pinned Mathlib source tree')
                    if item.isdir():
                        directory = destination.joinpath(*path.parts[1:])
                        directory.mkdir(exist_ok=True)
                        directory.chmod(0o755)
                    elif path.suffix == '.lean':
                        if not item.isreg():
                            raise ValueError('Expected regular Mathlib Lean source')
                        target = destination.joinpath(*path.parts[1:])
                        with target.open('xb') as out, archive.extractfile(item) as src:
                            shutil.copyfileobj(src, out)
                        target.chmod(0o444)
        finally:
            proc.stdout.close()
        if proc.wait() != 0:
            raise ValueError('Cannot export the pinned public Mathlib sources')


def library_digest(root, *, worker_copy=False):
    """Hash library paths and file contents independently of owner read permissions."""
    h = hashlib.sha256()
    for entry in [root, *sorted(root.rglob('*'))]:
        relative = entry.relative_to(root).as_posix().encode()
        if entry.is_symlink():
            raise ValueError('Symlink in public compiled library')
        if entry.is_dir():
            if worker_copy and entry.stat().st_mode & 0o777 != 0o755:
                raise ValueError('Worker library directories must be traversable')
            h.update(b'd\0' + relative + b'\0')
        elif entry.is_file():
            if worker_copy and entry.stat().st_mode & 0o777 != 0o444:
                raise ValueError('Worker library files must be read-only and readable')
            with entry.open('rb') as stream:
                h.update(b'f\0' + relative + b'\0' + hashlib.file_digest(stream, 'sha256').digest())
        else:
            raise ValueError('Expected a regular public library file')
    return h.hexdigest()


def copy_libraries(roots, destination):
    destination.mkdir(mode=0o755)
    destination.chmod(0o755)
    for index, src in enumerate(roots):
        dst = destination / str(index)
        # Preserve symlinks as entries so the digest check can reject them.
        shutil.copytree(src, dst, symlinks=True, copy_function=shutil.copyfile)
        for path in [dst, *dst.rglob('*')]:
            if path.is_symlink():
                raise ValueError('Symlink in public compiled library')
            path.chmod(0o755 if path.is_dir() else 0o444)

def probe_worker(image, volumes, challenge):
    # Run the shipped command with the same unprivileged UID as native Pi.
    command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--user', '10000:10000',
               '--cpus', '2', '--memory', '8g', '--entrypoint', 'sh']
    for item in volumes:
        if not item['read_only']:
            raise ValueError('Expected read-only diagnostic mounts')
        command.extend(['--mount', f"type=bind,src={item['source']},dst={item['target']},readonly"])
    script = """set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
git init -q
parent=$(dirname "$1")
mkdir -p "$parent"
cat >"$1"
printf '%s\n' 'import Mathlib.Data.Fintype.Card' 'example : Fintype.card (Fin 2) = 2 := by decide' >"$parent/WorkerProbe.lean"
git add .
lean-check "$parent/WorkerProbe.lean"
"""
    with tempfile.TemporaryDirectory(prefix='agensh-uid-probe-') as directory:
        cid = Path(directory) / 'container-id'
        try:
            subprocess.run([*command, '--cidfile', str(cid), image, '-ec', script, 'probe', TARGET],
                           input=challenge.read_bytes(), check=True, timeout=180)
        except BaseException:
            # Docker CLI termination does not guarantee the daemon stopped the build.
            if cid.is_file() and (container := cid.read_text().strip()):
                subprocess.run(['docker', 'rm', '-f', container], timeout=30, check=False,
                               stdout=subprocess.DEVNULL)
            raise
