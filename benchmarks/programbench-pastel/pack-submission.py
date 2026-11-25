#!/usr/bin/env python3
"""Package a frozen Pastel source tree for the pinned ProgramBench evaluator."""
import argparse
import gzip
import hashlib
import json
import stat
import tarfile
from pathlib import Path

INSTANCE = "sharkdp__pastel.b60e899"
MAX_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 4096


def freeze(source: Path, run_directory: Path) -> dict:
    source = source.resolve(strict=True)
    destination = run_directory.resolve() / INSTANCE / "submission.tar.gz"
    if not source.is_dir() or destination.is_relative_to(source):
        raise ValueError("Provide a frozen source directory and a separate run directory")
    paths = []
    size = 0
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if ".git" in relative.parts or "__pycache__" in relative.parts or relative.as_posix() == "executable":
            continue
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError(f"Unsupported submission entry {relative}")
        paths.append((path, relative.as_posix(), info.st_size, info.st_mode))
        size += info.st_size
        if size > MAX_BYTES or len(paths) > MAX_ENTRIES:
            raise ValueError("Frozen submission exceeds its size or file limit")
    if not any(item[1] == "compile.sh" for item in paths):
        raise ValueError("Frozen submission needs an ordinary root-level compile.sh")
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if destination.parent.is_symlink():
        raise ValueError("Submission directory must not be a symbolic link")
    with destination.open("xb") as target:
        try:
            with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
                with tarfile.open(mode="w|", fileobj=compressed) as archive:
                    for path, name, nbytes, file_mode in paths:
                        info = tarfile.TarInfo(name)
                        info.size = nbytes
                        info.mode = 0o755 if file_mode & 0o111 else 0o644
                        with path.open("rb") as content:
                            archive.addfile(info, content)
        except BaseException:
            destination.unlink()
            raise
    with destination.open("rb") as archive:
        digest = hashlib.file_digest(archive, "sha256").hexdigest()
    return {"instance": INSTANCE, "sha256": digest, "files": len(paths), "sourceBytes": size}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("run_directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(freeze(args.source, args.run_directory)))
