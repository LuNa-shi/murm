import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'integrations/agensh'))
import seymour_inputs
from manifest import public_source_digest


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


class SeymourInputs(unittest.TestCase):
    def test_owner_only_objects_are_copied_readably_and_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            lib = tmp / 'library'
            lib.mkdir()
            source = lib / 'Public.olean'
            source.write_bytes(b'public object')
            source.chmod(0o600)
            copies = tmp / 'public'
            seymour_inputs.copy_libraries([lib], copies)
            actual = copies / '0'
            self.assertEqual(seymour_inputs.library_digest(lib),
                             seymour_inputs.library_digest(actual, worker_copy=True))
            copied = actual / source.name
            self.assertEqual(copied.stat().st_mode & 0o777, 0o444)
            self.assertEqual(source.stat().st_mode & 0o777, 0o600)
            copied.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'read-only and readable'):
                seymour_inputs.library_digest(actual, worker_copy=True)
            copied.write_bytes(b'changed')
            copied.chmod(0o444)
            self.assertNotEqual(seymour_inputs.library_digest(lib),
                                seymour_inputs.library_digest(actual, worker_copy=True))
            (lib / 'link').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'Symlink'):
                seymour_inputs.copy_libraries([lib], tmp / 'other')

    def test_pinned_sources_exclude_working_tree_and_untracked_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            git(root, 'init', '-q')
            src = root / 'Mathlib'
            src.mkdir()
            (src / 'Public.lean').write_text('def public := 1')
            git(root, 'add', 'Mathlib')
            git(root, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'fixture')
            pin = git(root, 'rev-parse', 'HEAD')
            (src / 'Public.lean').write_text('changed')
            (src / 'Private.lean').write_text('private fixture')
            public = root / 'export'
            seymour_inputs.export_mathlib(root, pin, public)
            self.assertEqual([p.name for p in public.iterdir()], ['Public.lean'])
            self.assertEqual((public / 'Public.lean').read_text(), 'def public := 1')
            before = public_source_digest(public)
            (public / 'Extra.lean').write_text('extra')
            self.assertNotEqual(before, public_source_digest(public))
            (public / 'link').symlink_to(src)
            with self.assertRaises(ValueError):
                public_source_digest(public)

    def test_context_manifest_rejected_before_any_private_files_are_opened(self):
        problem = {'id': 'oai_seymour_second_neighborhood', 'problem_file': seymour_inputs.TARGET,
                   'source_sha256': seymour_inputs.TARGET_HASH, 'context_manifest': 'extra.json',
                   'declaration_name': 'OAI.SeymourSecondNeighborhood.exists_goodVertex'}
        with self.assertRaisesRegex(ValueError, 'only the original'):
            seymour_inputs.validate({'problems': [problem]}, Path('/nonexistent-test-fixture'))

    def test_timeout_stops_compiler_child_before_returning(self):
        run_build = runpy.run_path(str(ROOT / 'integrations/agensh/seymour-lean-check'))['run_build']
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            stub = ("import subprocess,time,pathlib,sys; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                    "pathlib.Path('child.pid').write_text(str(p.pid)); time.sleep(60)")
            with self.assertRaises(subprocess.TimeoutExpired):
                run_build([sys.executable, '-c', stub], tmp, os.environ, timeout=1)
            pid = (tmp / 'child.pid').read_text()
            status = Path('/proc') / pid / 'stat'
            if status.exists():
                self.assertIn(status.read_text().split()[2], ('Z', 'X'))

    def test_module_root_and_source_only_build(self):
        if not os.environ.get('AGENSH_TEST_LEAN_ROOT'):
            self.skipTest('set AGENSH_TEST_LEAN_ROOT to a pinned local toolchain')
        lean = Path(os.environ['AGENSH_TEST_LEAN_ROOT']).resolve(strict=True)
        check = runpy.run_path(str(ROOT / 'integrations/agensh/seymour-lean-check'))['main']
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp).resolve()
            git(repo, 'init', '-q')
            root = (repo / seymour_inputs.TARGET).parent
            root.mkdir(parents=True)
            (repo / seymour_inputs.TARGET).write_text('theorem original : True := by trivial\n')
            (root / 'Helper.lean').write_text('theorem doneHere : True := by trivial\n')
            parent = root / 'Parent.lean'
            parent.write_text('import Helper\ntheorem useHere : True := doneHere\n')
            libs = repo / 'empty-libs'
            libs.mkdir()
            git(repo, 'add', 'benchmarks')
            previous = Path.cwd()
            try:
                os.chdir(root.parent)
                with patch.dict(check.__globals__, LEAN=lean, LIBRARIES=libs):
                    self.assertEqual(check('ComparatorChallenges/Parent.lean'), 0)
                    reserved = root / 'Leanc.lean'
                    reserved.write_text('def localValue := 1')
                    with self.assertRaisesRegex(ValueError, 'reserved Lean module'):
                        check('ComparatorChallenges/Parent.lean')
                    reserved.unlink()
                    stale = repo / 'Stray.lean'
                    stale.write_text('def stray := 1')
                    git(repo, 'add', 'Stray.lean')
                    with self.assertRaisesRegex(ValueError, 'outside the canonical'):
                        check('ComparatorChallenges/Parent.lean')
                    stale.unlink()
                    # Even an existing object in the worker tree cannot grant
                    # the invalid parent-relative module name to the checker.
                    subprocess.run([str(lean / 'bin/lean'), '-R', '.', '-o',
                                    'ComparatorChallenges/Helper.olean', 'ComparatorChallenges/Helper.lean'], check=True)
                    parent.write_text('import ComparatorChallenges.Helper\ntheorem useHere : True := doneHere\n')
                    self.assertNotEqual(check('ComparatorChallenges/Parent.lean'), 0)
                    (root / 'Helper.lean').unlink()
                    parent.write_text('import Helper\ntheorem useHere : True := doneHere\n')
                    self.assertNotEqual(check('ComparatorChallenges/Parent.lean'), 0)
                    outside = repo / 'outside.lean'
                    outside.write_text('def outside := 1')
                    (root / 'Helper.lean').symlink_to(outside)
                    with self.assertRaisesRegex(ValueError, 'Symlink'):
                        check('ComparatorChallenges/Parent.lean')
                    with self.assertRaisesRegex(ValueError, 'regular Lean source'):
                        check(str(outside))
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
