"""Linux PTY driver used by the installed CLI acceptance tests."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time

F1 = b"\x1bOP"
F2 = b"\x1bOQ"
F3 = b"\x1bOR"
F4 = b"\x1bOS"
F5 = b"\x1b[15~"
F6 = b"\x1b[17~"
F7 = b"\x1b[18~"
F8 = b"\x1b[19~"
F9 = b"\x1b[20~"
ENTER = b"\r"
DOWN = b"\x1b[B"
END = b"\x1b[F"
ESC = b"\x1b"
INTERRUPT = b"\x03"


class Terminal:
    def __init__(self, arguments, cwd, env, rows=24, columns=80, tty_in=True, tty_out=True):
        self.master, self.slave = pty.openpty()
        os.set_blocking(self.master, False)
        self.before = termios.tcgetattr(self.slave)
        self.output = bytearray()
        self.mark = 0
        self.resize(rows, columns)

        def attach():
            os.setsid()
            fcntl.ioctl(self.slave, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            arguments, cwd=cwd, env=env, stdin=self.slave if tty_in else subprocess.PIPE,
            stdout=self.slave if tty_out else subprocess.PIPE, stderr=self.slave,
            preexec_fn=attach, pass_fds=(self.slave,),
        )

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            if self.process.poll() is None:
                self.process.send_signal(signal.SIGTERM)
                try:
                    self.finish(143, timeout=45, restored=False)
                except (AssertionError, subprocess.TimeoutExpired, OSError):
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            if self.master is not None:
                os.close(self.master)
            os.close(self.slave)
            for stream in [self.process.stdin, self.process.stdout]:
                if stream is not None:
                    stream.close()
        transcript = os.environ.get("MURM_TUI_TEST_TRANSCRIPT")
        if transcript:
            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
            descriptor = os.open(transcript, flags, 0o600)
            with os.fdopen(descriptor, "wb") as evidence:
                evidence.write(self.output)

    def resize(self, rows, columns):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, timeout=0.05):
        if self.master is None or not select.select([self.master], [], [], timeout)[0]:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EIO):
                return
            raise
        self.output.extend(data)
        if len(self.output) > 8 * 1024 * 1024:
            raise AssertionError("PTY output limit exceeded")

    def wait(self, text, timeout=15):
        return self.wait_any((text,), timeout)

    def wait_any(self, texts, timeout=15):
        needles = [text.encode() if isinstance(text, str) else text for text in texts]
        until = time.monotonic() + timeout
        while True:
            matches = [(found, needle) for needle in needles if (found := self.output.find(needle, self.mark)) >= 0]
            if matches:
                found, needle = min(matches)
                self.mark = found + len(needle)
                return needle
            if time.monotonic() >= until:
                preview = bytes(self.output[max(0, len(self.output) - 2300):])
                raise AssertionError(f"Missing PTY text {needles!r}. Recent output: {preview!r}")
            self.pump(min(0.1, until - time.monotonic()))

    def key(self, keys):
        if isinstance(keys, str):
            keys = keys.encode()
        until = time.monotonic() + 10
        while keys:
            if time.monotonic() >= until or self.process.poll() is not None:
                raise AssertionError('CLI stopped accepting terminal input')
            _, writable, _ = select.select([], [self.master], [], 0.5)
            if not writable:
                self.pump()
                continue
            try:
                count = os.write(self.master, keys[:4096])
            except BlockingIOError:
                continue
            keys = keys[count:]
            self.pump(0)

    def paste(self, text):
        self.key(b"\x1b[200~" + text.encode() + b"\x1b[201~")

    def menu(self, index):
        self.key(DOWN * index + ENTER)

    def disconnect(self):
        os.close(self.master)
        self.master = None

    def finish(self, code, timeout=20, restored=True):
        until = time.monotonic() + timeout
        while self.process.poll() is None:
            if time.monotonic() >= until:
                raise subprocess.TimeoutExpired(self.process.args, timeout)
            if self.master is None:
                time.sleep(0.02)
            else:
                self.pump()
        if self.master is not None:
            for _ in range(5):
                self.pump(0.01)
        assert self.process.returncode == code, (
            self.process.returncode, code, bytes(self.output[-1600:]))
        if restored:
            assert termios.tcgetattr(self.slave) == self.before, "original termios state changed"
            assert b"\x1b[?1049l" in self.output, "alternate screen exit absent"
            assert b"\x1b[?2004l" in self.output, "paste mode restore absent"
            assert b"\x1b[?25h" in self.output, "cursor restore absent"
            assert b"\x1b[?1003h" not in self.output, "mouse protocol was unexpectedly enabled"
            os.write(self.master, b"echo-restored\n")
            assert select.select([self.slave], [], [], 0.25)[0], "canonical input unavailable"
            assert os.read(self.slave, 100) == b"echo-restored\n"
            self.wait("echo-restored", 1)



def install_interrupt_handler():
    def interrupt(*_):
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, interrupt)
