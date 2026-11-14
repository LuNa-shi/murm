"""Host-only helper. Pin a Docker process's namespace/root before changing mounts."""

import ctypes
import os
import re
import stat
import sys


def main():
    pid, container_id, size, inode_limit = sys.argv[1:]
    pid = int(pid)
    size = int(size)
    inode_limit = int(inode_limit)
    if (pid <= 1 or not re.fullmatch(r"[0-9a-f]{64}", container_id)
            or not 16 * 1024**2 <= size <= 4 * 1024**3 or size % 4096
            or not 1024 <= inode_limit <= 262144):
        raise ValueError("invalid bounded workspace settings")
    proc = os.open(f"/proc/{pid}", os.O_PATH)
    with open("cgroup", opener=lambda path, flags: os.open(path, flags, dir_fd=proc)) as info:
        entries = info.read().replace("\n", "/").split("/")
    if container_id not in entries and f"docker-{container_id}.scope" not in entries:
        raise ValueError("Docker process no longer owns the Sandbox")
    namespace = os.open("ns/mnt", os.O_RDONLY, dir_fd=proc)
    root = os.open("root", os.O_PATH, dir_fd=proc)
    host = os.stat("/proc/1/ns/mnt")
    target = os.fstat(namespace)
    if (host.st_dev, host.st_ino) == (target.st_dev, target.st_ino):
        raise ValueError("refusing host mount namespace")
    with open("mountinfo", opener=lambda path, flags: os.open(path, flags, dir_fd=proc)) as info:
        mounts = [line.split(" - ", 1)[0].split() for line in info]
    root_mounts = [fields for fields in mounts if fields[4] == "/"]
    if any(fields[4] == "/workspace" or fields[4].startswith("/workspace/") for fields in mounts):
        raise ValueError("Sandbox workspace must not contain an existing mount")
    if len(root_mounts) != 1 or any(
            field.startswith(("shared:", "master:")) for field in root_mounts[0][6:]):
        raise ValueError("Sandbox root mount must be private")
    workspace = os.stat("workspace", dir_fd=root, follow_symlinks=False)
    if not stat.S_ISDIR(workspace.st_mode):
        raise ValueError("Sandbox workspace must be an ordinary directory")
    if workspace.st_dev != os.fstat(root).st_dev:
        raise ValueError("Sandbox /workspace already has a mount")
    workspace_fd = os.open("workspace", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    try:
        if os.listdir(workspace_fd):
            raise ValueError("Sandbox /workspace is already initialized")
    finally:
        os.close(workspace_fd)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.setns.argtypes = [ctypes.c_int, ctypes.c_int]
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    clone_newns = 0x00020000
    ms_nosuid = 2
    ms_nodev = 4
    if libc.setns(namespace, clone_newns) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    os.fchdir(root)
    os.chroot(".")
    os.chdir("/")
    options = f"size={size},nr_inodes={inode_limit},uid=0,gid=0,mode=0755".encode("ascii")
    if libc.mount(b"tmpfs", b"/workspace", b"tmpfs", ms_nosuid | ms_nodev, options) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))



if __name__ == "__main__":
    main()
