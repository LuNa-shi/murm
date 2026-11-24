"""Mount a Runtime-owned project tmpfs into a pinned Sandbox namespace."""

import ctypes
import os
import re
import stat
import sys

MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_REMOUNT = 32
MS_BIND = 4096
libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.setns.argtypes = [ctypes.c_int, ctypes.c_int]
libc.open_tree.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
libc.move_mount.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]


def checked(result):
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def directory(path):
    os.makedirs(path, mode=0o755, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("shared workspace parent is not root-controlled")


def main():
    action, runtime_key, workspace_key, *args = sys.argv[1:]
    if action not in ("create", "attach", "delete") or not all(re.fullmatch(r"[a-f0-9]{64}", key) for key in (runtime_key, workspace_key)):
        raise ValueError("invalid shared workspace identity")
    parent = f"/run/swarmenv-workspaces/{runtime_key}"
    path = f"{parent}/{workspace_key}"
    if action == "create":
        size, inodes = map(int, args)
        if not 16 * 1024**2 <= size <= 4 * 1024**3 or size % 4096 or not 1024 <= inodes <= 262144:
            raise ValueError("invalid workspace quota")
        for name in ("/run/swarmenv-workspaces", parent):
            directory(name)
        if not os.path.ismount(path):
            directory(path)
            options = f"size={size},nr_inodes={inodes},uid=10001,gid=10001,mode=0755".encode()
            checked(libc.mount(b"tmpfs", os.fsencode(path), b"tmpfs", MS_NOSUID | MS_NODEV, options))
        return
    if action == "delete":
        if os.path.ismount(path):
            checked(libc.umount2(os.fsencode(path), 0))
        if os.path.exists(path):
            os.rmdir(path)
        if os.path.isdir(parent) and not os.listdir(parent):
            os.rmdir(parent)
        return
    pid, container_id, mode = args
    pid = int(pid)
    if pid <= 1 or not re.fullmatch(r"[a-f0-9]{64}", container_id) or mode not in ("read-only", "read-write"):
        raise ValueError("invalid Sandbox mount identity")
    proc = os.open(f"/proc/{pid}", os.O_PATH)
    with open("cgroup", opener=lambda name, flags: os.open(name, flags, dir_fd=proc)) as info:
        entries = info.read().replace("\n", "/").split("/")
    if container_id not in entries and f"docker-{container_id}.scope" not in entries:
        raise ValueError("Docker process no longer owns the Sandbox")
    namespace = os.open("ns/mnt", os.O_RDONLY, dir_fd=proc)
    root = os.open("root", os.O_PATH, dir_fd=proc)
    host = os.stat("/proc/1/ns/mnt")
    target_namespace = os.fstat(namespace)
    if (host.st_dev, host.st_ino) == (target_namespace.st_dev, target_namespace.st_ino):
        raise ValueError("refusing host mount namespace")
    source = libc.open_tree(-100, os.fsencode(path), 1 | os.O_CLOEXEC)
    if source < 0:
        checked(-1)
    if not os.path.ismount(path):
        raise ValueError("shared backing must be a mounted tmpfs")
    workspace = os.open("workspace", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    os.mkdir("project", mode=0o555, dir_fd=workspace)
    checked(libc.setns(namespace, 0x00020000))
    os.fchdir(root)
    os.chroot(".")
    os.chdir("/")
    target_name = b"/workspace/project"
    checked(libc.move_mount(source, b"", -100, target_name, 4))
    # A per-mount read-only bit also restricts the shared UID used by peers.
    if mode == "read-only":
        checked(libc.mount(None, target_name, None, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, None))


if __name__ == "__main__":
    main()
