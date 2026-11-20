"""Public inputs of the challenge-only Seymour arm matched to EXP-02."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

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
