#!/usr/bin/env python3
"""Private lock transitions for selftest-sweep.sh; never recursively delete."""
import ctypes
import datetime
import fcntl
import json
import os
import re
import socket
import stat
import sys
import uuid

MARKER = "wheelhouse-selftest-sweep"
FILES = {MARKER, "pid", "started"}
HOST = socket.gethostname()


class Refused(Exception):
    pass


def identity(st):
    return f"{st.st_dev}:{st.st_ino}"


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value):
        raise Refused("invalid start time")
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise Refused("invalid start time")
    return value


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def read_file(parent, name):
    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISREG(st.st_mode) or st.st_size > 16384:
        raise Refused(f"{name} is not a bounded regular file")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        if identity(os.fstat(fd)) != identity(st):
            raise Refused(f"{name} changed while reading")
        return os.read(fd, 16385).decode("utf-8"), identity(st)
    finally:
        os.close(fd)


def inspect(parent, name):
    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(st.st_mode):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            if identity(os.fstat(fd)) != identity(st):
                raise Refused("directory changed while opening")
            if set(os.listdir(fd)) != FILES:
                raise Refused("entries must be exactly marker, pid, started")
            raw, marker_id = read_file(fd, MARKER)
            marker = json.loads(raw)
            if not isinstance(marker, dict) or set(marker) != {"kind", "version", "pid", "hostname", "started", "token"}:
                raise Refused("invalid marker fields")
            if marker["kind"] != MARKER or type(marker["version"]) is not int or marker["version"] != 1:
                raise Refused("invalid marker kind/version")
            if type(marker["pid"]) is not int or not 0 < marker["pid"] <= 2147483647:
                raise Refused("invalid marker pid")
            if marker["hostname"] != HOST:
                raise Refused("marker hostname is not this host")
            if not isinstance(marker["token"], str) or not re.fullmatch(r"[0-9a-f]{32}", marker["token"]):
                raise Refused("invalid marker token")
            timestamp(marker["started"])
            pid, pid_id = read_file(fd, "pid")
            started, started_id = read_file(fd, "started")
            if pid != str(marker["pid"]) + "\n" or started != marker["started"] + "\n":
                raise Refused("pid/started do not agree with marker")
            return identity(st), marker, {MARKER: marker_id, "pid": pid_id, "started": started_id}
        finally:
            os.close(fd)
    if stat.S_ISREG(st.st_mode):
        # Compatibility only: the old atomic file always had one numeric pid.
        raw, file_id = read_file(parent, name)
        fields = {}
        for line in raw.splitlines():
            key, sep, value = line.partition("=")
            if not sep or key not in {"pid", "started", "root", "pattern"} or key in fields:
                raise Refused("invalid legacy lock fields")
            fields[key] = value
        if not re.fullmatch(r"[0-9]+", fields.get("pid", "")) or not 0 < int(fields["pid"]) <= 2147483647:
            raise Refused("legacy lock needs pid=<digits>")
        if "started" in fields:
            timestamp(fields["started"])
        return file_id, {"pid": int(fields["pid"]), "started": fields.get("started", ""), "token": None}, None
    raise Refused("not a directory or legacy regular lock file")


def remove_validated(parent, name, snapshot):
    # All new transitions hold the same parent-directory flock. Recheck the
    # entire record before touching any member; never follow links or rm -rf.
    if inspect(parent, name) != snapshot:
        raise Refused("lock changed before removal")
    lock_id, marker, members = snapshot
    if members is None:
        os.unlink(name, dir_fd=parent)
        return
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        if identity(os.fstat(fd)) != lock_id:
            raise Refused("directory identity changed before removal")
        for member, expected in members.items():
            if identity(os.stat(member, dir_fd=fd, follow_symlinks=False)) != expected:
                raise Refused(f"{member} changed before removal")
        if set(os.listdir(fd)) != FILES:
            raise Refused("directory entries changed before removal")
        for member in members:
            os.unlink(member, dir_fd=fd)
        # An unexpected added entry makes rmdir fail, never deletes that entry.
        if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != lock_id:
            raise Refused("directory name changed before removal")
        os.rmdir(name, dir_fd=parent)
    finally:
        os.close(fd)


def rename_exclusive(parent, source, dest):
    lib = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        fn, flag = lib.renameatx_np, 4  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        fn, flag = lib.renameat2, 1  # RENAME_NOREPLACE
    else:
        raise Refused("atomic directory publication unsupported on this platform")
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(parent, os.fsencode(source), parent, os.fsencode(dest), flag):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def publish(parent, name, pid, token):
    candidate = "." + name + "." + uuid.uuid4().hex + ".new"
    os.mkdir(candidate, 0o700, dir_fd=parent)
    fd = os.open(candidate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    candidate_id = identity(os.fstat(fd))
    written = {}
    try:
        started = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        marker = {"kind": MARKER, "version": 1, "pid": pid, "hostname": HOST, "started": started, "token": token}
        for member, content in [("pid", str(pid) + "\n"), ("started", started + "\n"), (MARKER, json.dumps(marker) + "\n")]:
            out = os.open(member, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            written[member] = identity(os.fstat(out))
            with os.fdopen(out, "w") as stream:
                stream.write(content)
        rename_exclusive(parent, candidate, name)
        print(candidate_id)
    finally:
        # Clean only this invocation's private candidate, and only its recorded
        # files. Successful rename leaves no candidate at this name.
        try:
            st = os.stat(candidate, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            st = None
        if st is not None and identity(st) == candidate_id:
            for member, expected in written.items():
                if identity(os.stat(member, dir_fd=fd, follow_symlinks=False)) == expected:
                    os.unlink(member, dir_fd=fd)
            os.rmdir(candidate, dir_fd=parent)
        os.close(fd)


def parent_fd(path):
    # /tmp may legitimately alias /private/tmp. Resolve once in the shell, then
    # walk that physical parent without following any subsequent symlink swap.
    parts = os.path.dirname(path).split("/")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts:
            if not part:
                continue
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def main():
    op, path, pid, token, owned = sys.argv[1:]
    if op not in {"acquire", "release"}:
        raise Refused("unknown operation")
    name = os.path.basename(path)
    if name in {"", ".", ".."} or not os.path.isabs(path):
        raise Refused("invalid lock path")
    parent = parent_fd(path)
    try:
        # This advisory mutex has no guard file to orphan or accidentally
        # delete. It serializes all new transitions in the physical parent.
        fcntl.flock(parent, fcntl.LOCK_EX)
        try:
            st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            st = None
        if op == "release":
            if st is None or identity(st) != owned:
                return 0  # Never remove a replacement, even with our pid.
            snapshot = inspect(parent, name)
            if snapshot[1]["token"] != token or snapshot[1]["pid"] != int(pid):
                raise Refused("owned lock marker changed")
            remove_validated(parent, name, snapshot)
            return 0
        if st is not None:
            snapshot = inspect(parent, name)
            holder = snapshot[1]
            if alive(holder["pid"]):
                print(f"pid={holder['pid']} started={holder['started']}")
                return 1
            print(f"selftest-sweep: removing stale lock {path} held by dead pid {holder['pid']}", file=sys.stderr)
            remove_validated(parent, name, snapshot)
        publish(parent, name, int(pid), token)
        return 0
    finally:
        os.close(parent)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Refused, OSError, ValueError, KeyError, AttributeError) as error:
        print(f"STOP: {sys.argv[2]} is not a selftest-sweep lock ({error})", file=sys.stderr)
        sys.exit(2)
