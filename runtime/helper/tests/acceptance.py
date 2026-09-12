#!/usr/bin/env python3
"""Run the same real-helper behavior suite on an explicitly selected platform.
Connection coordinates are command-line inputs and never written to reports.
"""
import argparse
import base64
import json
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import tempfile
import threading
import time


def b64(data):
    return base64.b64encode(data).decode()


class RemoteError(Exception):
    def __init__(self, error):
        super().__init__(error["code"])
        self.error = error


class Client:
    def __init__(self, command, hello):
        self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.seq = 0
        self.responses = {}
        self.events = []
        self.cv = threading.Condition()
        self.dead = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()
        self.send(0, "runtime.hello", hello)
        try:
            self.hello = self.result(0)
        except BaseException:
            self.disconnect()
            raise

    def _read(self):
        def exact(n):
            data = b""
            while len(data) < n:
                chunk = self.child.stdout.read(n - len(data))
                if not chunk:
                    raise EOFError()
                data += chunk
            return data
        try:
            while True:
                n, = struct.unpack(">I", exact(4))
                assert 0 < n <= 2 * 1024 * 1024
                msg = json.loads(exact(n))
                with self.cv:
                    if "id" in msg:
                        self.responses.setdefault(msg["id"], []).append(msg)
                    else:
                        self.events.append(msg)
                    self.cv.notify_all()
        except (EOFError, OSError):
            pass
        finally:
            with self.cv:
                self.dead = True
                self.cv.notify_all()

    def send(self, ident, method, params):
        data = json.dumps({"id": ident, "method": method, "params": params}, separators=(",", ":")).encode()
        self.child.stdin.write(struct.pack(">I", len(data)) + data)
        self.child.stdin.flush()
        self.seq = max(self.seq, ident)
        return ident

    def request(self, method, **params):
        return self.result(self.send(self.seq + 1, method, params))

    def result(self, ident, timeout=10):
        end = time.monotonic() + timeout
        with self.cv:
            while not self.responses.get(ident):
                if self.dead:
                    raise AssertionError("transport ended before response")
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise AssertionError("request timed out")
                self.cv.wait(remaining)
            msg = self.responses[ident].pop(0)
        if "error" in msg:
            raise RemoteError(msg["error"])
        return msg["result"]

    def disconnect(self):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
        self.thread.join(timeout=2)


def expect(code, fn):
    try:
        fn()
    except RemoteError as e:
        assert e.error["code"] == code, (code, e.error)
    else:
        raise AssertionError("expected " + code)


def eventually(fn, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.04)
    raise AssertionError("condition timed out")


class Suite:
    def __init__(self, args):
        self.args = args
        self.helper = args.helper if args.ssh else str(Path(args.helper).resolve())
        self.fixture = args.fixture if args.ssh else str(Path(args.fixture).resolve())
        self.prefix = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.ssh] if args.ssh else []
        self.root = self.run(["mktemp", "-d", "/tmp/dsh-accept.XXXXXXXX"]).strip() if args.ssh else tempfile.mkdtemp(prefix="dsh-accept.", dir="/tmp")
        self.runtime = self.root + "/runtime"
        self.client = None
        self.passed = []

    def command(self, argv):
        return self.prefix + [shlex.join(argv)] if self.prefix else argv

    def run(self, argv):
        return subprocess.check_output(self.command(argv), text=True, stderr=subprocess.PIPE)

    def start(self, name="runtime", grace=None, lease=5000):
        grace = self.args.grace_ms if grace is None else grace
        self.grace_ms = grace
        self.runtime = self.root + "/" + name
        self.run([self.helper, "start", "--runtime-dir", self.runtime,
                  "--grace-ms", str(grace), "--lease-ms", str(lease)])

    def connect(self, resume=None):
        hello = {"api": 2, "world": "acceptance", "required": ["process.pty", "runtime.resume"]}
        if resume:
            hello.update(runtime=resume["runtime"], token=resume["token"])
        client = Client(self.command([self.helper, "connect", "--socket", self.runtime + "/socket"]), hello)
        client.seq = client.hello["requestHighWater"]
        self.client = client
        self.root = self.run(["realpath", self.root]).strip()
        return client

    def write(self, path, data, expected=None):
        c = self.client
        upload = c.request("fs.beginWrite", path=path, expected=expected or {"kind": "any"}, maxBytes=max(1, len(data)))["upload"]
        for offset in range(0, len(data), 32768):
            c.request("fs.writeChunk", upload=upload, offset=offset, data=b64(data[offset:offset + 32768]))
        return c.request("fs.commitWrite", upload=upload)

    def read(self, path, maximum=1024 * 1024):
        opened = self.client.request("fs.read", path=path, maxBytes=maximum)
        data = self.consume(opened["stream"])
        self.client.request("stream.close", stream=opened["stream"])
        return data

    def consume(self, stream, offset=0, timeout=10):
        result = bytearray()
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            snap = self.client.request("stream.read", stream=stream, offset=offset)
            assert not snap["gap"], snap
            result.extend(base64.b64decode(snap["data"]))
            offset = snap["next"]
            if snap["mode"] == "raw":
                self.client.request("stream.ack", stream=stream, offset=offset)
            if snap["eof"] and offset == snap["produced"]:
                assert snap["error"] is None, snap
                return bytes(result)
            time.sleep(0.01)
        raise AssertionError("output consumption timed out")

    def spawn(self, *args, **params):
        spec = dict(argv=[self.fixture, *args], cwd=self.root,
                    stdout={"mode": "collect", "maxBytes": 65536},
                    stderr={"mode": "collect", "maxBytes": 65536}, graceMs=150, drainMs=1000)
        spec.update(params)
        return self.client.request("process.spawn", **spec)

    def status(self, proc):
        return self.client.request("process.status", process=proc["process"])

    def done(self, proc):
        return eventually(lambda: (s if (s := self.status(proc))["closed"] and s["cleanupComplete"] else None))

    def release(self, proc):
        self.done(proc)
        self.client.request("process.release", process=proc["process"])

    def case(self, name, fn):
        fn()
        self.passed.append(name)
        print("PASS " + name, flush=True)

    def handshake(self):
        c = self.client
        expect("INVALID_ARGUMENT", lambda: c.request("runtime.shutdown", deadlineMs=-1))
        assert c.request("runtime.ping")["runtime"] == c.hello["runtime"]
        command = self.command([self.helper, "connect", "--socket", self.runtime + "/socket"])
        expect("INCOMPATIBLE_VERSION", lambda: Client(command, {"api": 1, "world": "acceptance"}))
        expect("UNSUPPORTED", lambda: Client(command, {"api": 2, "world": "acceptance", "required": ["not-implemented"]}))
        expect("SESSION_BUSY", lambda: Client(command, {"api": 2, "world": "acceptance"}))
        credentials = c.hello
        c.disconnect()
        eventually(lambda: c.dead)
        expect("SESSION_MISMATCH", lambda: Client(command, {"api": 2, "world": "acceptance", "runtime": credentials["runtime"], "token": "wrong"}))
        self.connect(credentials)

    def filesystem(self):
        c = self.client
        path = self.root + "/nested/space λ.bin"
        data = b"a\x00\xff\r\n" + bytes(range(256)) * 300
        result = self.write(path, data, {"kind": "absent"})
        assert result["committed"]
        assert result["metadata"]["version"] == c.request("fs.stat", path=path)["version"]
        assert self.read(path) == data
        expect("TOO_LARGE", lambda: c.request("fs.read", path=path, maxBytes=len(data) - 1))
        assert self.read(path, len(data)) == data
        assert "fs.read-range" in c.hello["capabilities"]
        for offset, length in [(17, 70000), (len(data) - 3, 20), (len(data) + 1, 10), (0, 0)]:
            opened = c.request("fs.readRange", path=path, offset=offset, length=length)
            assert self.consume(opened["stream"]) == data[offset:offset + length]
            c.request("stream.close", stream=opened["stream"])
        expect("INVALID_ARGUMENT", lambda: c.request("fs.readRange", path=path, offset=-1, length=1))
        expect("NOT_REGULAR_FILE", lambda: c.request("fs.readRange", path=self.root, length=1))
        expect("CREATE_CONFLICT", lambda: self.write(path, b"bad", {"kind": "absent"}))
        version = c.request("fs.stat", path=path)["version"]
        self.write(path, b"updated", {"kind": "version", "version": version})
        expect("STALE_VERSION", lambda: self.write(path, b"bad", {"kind": "version", "version": version}))
        assert self.read(path) == b"updated"
        assert c.request("fs.stat", path=self.root + "/missing") is None
        expect("INVALID_ARGUMENT", lambda: c.request("fs.resolve", path="nested/space λ.bin"))
        assert c.request("fs.resolve", path="nested/space λ.bin", cwd=self.root)["path"] == path
        names = [e["name"] for e in c.request("fs.list", path=self.root + "/nested")["entries"]]
        assert names == sorted(names)
        expect("NOT_REGULAR_FILE", lambda: c.request("fs.read", path=self.root, maxBytes=10))
        expect("NOT_REGULAR_FILE", lambda: c.request("fs.read", path="/dev/null", maxBytes=10))
        self.run(["ln", "-s", "nested", self.root + "/link"])
        assert c.request("fs.resolve", path=self.root + "/link/space λ.bin", cwd=self.root)["path"] == path
        self.write(self.root + "/link/space λ.bin", b"link target")
        assert c.request("fs.stat", path=self.root + "/link", follow=False)["kind"] == "symlink"
        assert self.read(path) == b"link target"
        self.run(["mkfifo", self.root + "/fifo"])
        expect("NOT_REGULAR_FILE", lambda: c.request("fs.read", path=self.root + "/fifo", maxBytes=10))
        # Two staged edits share an observation; exactly one publishes.
        version = c.request("fs.stat", path=path)["version"]
        uploads = [c.request("fs.beginWrite", path=path, expected={"kind": "version", "version": version})["upload"] for _ in range(2)]
        for upload in uploads:
            c.request("fs.writeChunk", upload=upload, offset=0, data=b64(b"race"))
        c.request("fs.commitWrite", upload=uploads[0])
        expect("STALE_VERSION", lambda: c.request("fs.commitWrite", upload=uploads[1]))
        c.request("fs.abortWrite", upload=uploads[1])

    def pipes(self):
        c = self.client
        data = bytes(range(256)) * 31
        proc = self.spawn("echo", stdin={"data": b64(data)})
        assert self.done(proc)["rootExit"]["code"] == 0
        assert self.consume(proc["outputs"][0]["stream"]) == data
        assert self.consume(proc["outputs"][1]["stream"]) == b"\x00\xff\xfe!"
        self.release(proc)
        proc = self.spawn("argv", "$(echo unsafe)", "a b", "*")
        self.done(proc)
        assert json.loads(self.consume(proc["outputs"][0]["stream"])) == ["$(echo unsafe)", "a b", "*"]
        self.release(proc)
        proc = self.spawn("env", "ACCEPT_VALUE", "ACCEPT_TOKEN", "DSH_ACCEPT", "PATH",
                          env={"ACCEPT_VALUE": "target", "ACCEPT_TOKEN": "deliberate", "DSH_ACCEPT": "explicit", "PATH": None})
        self.done(proc)
        assert json.loads(self.consume(proc["outputs"][0]["stream"])) == {"ACCEPT_VALUE": "target", "ACCEPT_TOKEN": "deliberate", "DSH_ACCEPT": "explicit", "PATH": None}
        self.release(proc)
        expect("NOT_FOUND", lambda: c.request("process.spawn", argv=["/nonexistent/dsh-fixture"], cwd=self.root))
        expect("INVALID_ARGUMENT", lambda: c.request("process.resolveExecutable", command="./relative", cwd=self.root))

    def input_ordering(self):
        c = self.client
        proc = self.spawn("echo", stdin="pipe")
        ids = []
        data = [bytes([n]) * 1000 for n in range(20)]
        for part in data:
            ids.append(c.send(c.seq + 1, "process.write", {"process": proc["process"], "data": b64(part)}))
        close = c.send(c.seq + 1, "process.closeStdin", {"process": proc["process"]})
        for ident in ids:
            assert c.result(ident)["written"] == 1000
        c.result(close)
        self.done(proc)
        assert self.consume(proc["outputs"][0]["stream"]) == b"".join(data)
        self.release(proc)

    def collection(self):
        c = self.client
        proc = self.spawn("burst", "20000", stdout={"mode": "collect", "maxBytes": 17, "spillBytes": 20000})
        self.done(proc)
        snap = c.request("process.readOutput", stream=proc["outputs"][0]["stream"], offset=0)
        assert snap["gap"] and snap["offset"] == 19983 and snap["produced"] == 20000
        assert len(base64.b64decode(snap["data"])) == 17
        spill = self.read(snap["spill"])
        assert len(spill) == 20000 and spill[-17:] == base64.b64decode(snap["data"])
        self.release(proc)
        proc = self.spawn("burst", "20001", stdout={"mode": "collect", "maxBytes": 17, "spillBytes": 20000})
        self.done(proc)
        snap = c.request("stream.read", stream=proc["outputs"][0]["stream"], offset=0)
        assert snap["spill"] is None and snap["gap"]
        self.release(proc)

    def backpressure_resume(self):
        c = self.client
        marker = self.root + "/burst.done"
        proc = self.spawn("burst", "1048576", marker, stdout={"mode": "raw", "maxBytes": 4096}, drainMs=5000)
        stream = proc["outputs"][0]["stream"]
        eventually(lambda: c.request("stream.read", stream=stream)["produced"] == 4096)
        time.sleep(0.15)
        assert c.request("fs.stat", path=marker) is None
        assert c.request("stream.read", stream=stream)["produced"] == 4096
        assert c.request("runtime.ping", value="responsive")["value"] == "responsive"
        credentials = c.hello
        c.disconnect()
        c = self.connect(credentials)
        assert c.hello["runtime"] == credentials["runtime"]
        assert c.request("stream.read", stream=stream)["produced"] == 4096
        data = self.consume(stream, timeout=30)
        expected = bytes(n % 251 for n in range(8192)) * 128
        assert data == expected
        assert self.done(proc)["rootExit"]["code"] == 0
        assert self.read(marker) == b"complete"
        self.release(proc)

    def dedup(self):
        c = self.client
        marker = self.root + "/dedup.txt"
        params = {"argv": [self.fixture, "append", marker], "cwd": self.root,
                  "stdout": {"mode": "collect"}, "stderr": {"mode": "collect"}}
        ident = c.seq + 1
        c.send(ident, "process.spawn", params)
        first = c.result(ident)
        c.send(ident, "process.spawn", params)
        assert c.result(ident) == first
        credentials = c.hello
        c.disconnect()
        c = self.connect(credentials)
        c.send(ident, "process.spawn", params)
        assert c.result(ident) == first
        self.done(first)
        assert self.read(marker) == b"once\n"
        c.send(ident, "process.spawn", {**params, "argv": [self.fixture, "append", marker + "wrong"]})
        expect("REQUEST_CONFLICT", lambda: c.result(ident))
        self.release(first)
        for _ in range(260):
            c.request("runtime.ping")
        c.send(ident, "process.spawn", params)
        expect("REQUEST_EXPIRED", lambda: c.result(ident))
        assert self.read(marker) == b"once\n"

    def termination(self):
        c = self.client
        marker = self.root + "/hold.ready"
        proc = self.spawn("hold", "ignore", marker)
        eventually(lambda: c.request("fs.stat", path=marker))
        result = c.request("process.terminate", process=proc["process"])
        assert result["accepted"]
        state = self.done(proc)
        assert state["termSent"] and state["killSent"] and state["rootExit"]["signal"] == 9
        self.release(proc)
        marker = self.root + "/tree.ready"
        proc = self.spawn("tree", marker, drainMs=200)
        eventually(lambda: c.request("fs.stat", path=marker))
        state = eventually(lambda: (s if (s := self.status(proc))["closed"] else None))
        assert state["rootExit"]["code"] == 0 and not state["cleanupComplete"]
        out = c.request("stream.read", stream=proc["outputs"][0]["stream"])
        assert out["error"]["code"] == "OUTPUT_INCOMPLETE"
        c.request("process.terminate", process=proc["process"])
        self.release(proc)

    def pty(self):
        c = self.client
        proc = self.spawn("pty", mode="pty", rows=27, cols=91, env={"TERM": "xterm"})
        stream = proc["outputs"][0]["stream"]
        initial = eventually(lambda: (s if b"TTY 1 27 91" in base64.b64decode((s := c.request("stream.read", stream=stream))["data"]) else None))
        assert c.request("pty.foreground", process=proc["process"])["group"] == proc["pid"]
        assert c.request("pty.foreground", process=proc["process"])["inputWaiting"] == "unknown"
        c.request("pty.resize", process=proc["process"], rows=40, cols=100)
        c.request("process.write", process=proc["process"], data=b64(b"size\n"))
        eventually(lambda: b"SIZE 40 100" in base64.b64decode(c.request("stream.read", stream=stream)["data"]))
        expect("INVALID_ARGUMENT", lambda: c.request("process.closeStdin", process=proc["process"]))
        sent = c.request("process.signal", process=proc["process"], target="foreground", signal="INT")
        assert sent["signalSent"]
        self.consume(stream)
        assert self.done(proc)["rootExit"]["signal"] == 2
        self.release(proc)

    def cancellation(self):
        c = self.client
        proc = self.spawn("hold", stdin="pipe")
        # Repeated writes fill the OS pipe; cancel only the blocked write operation.
        pending = None
        for _ in range(80):
            ident = c.seq + 1
            c.send(ident, "process.write", {"process": proc["process"], "data": b64(b"x" * 32768)})
            try:
                c.result(ident, timeout=0.1)
            except AssertionError as e:
                assert str(e) == "request timed out"
                pending = ident
                break
        assert pending is not None
        result = c.request("runtime.cancel", request=pending)
        assert result["status"] == "accepted"
        expect("CANCELLED", lambda: c.result(pending))
        assert not self.status(proc)["cleanupComplete"]
        c.request("process.terminate", process=proc["process"])
        self.release(proc)

    def search(self):
        if not self.args.rg:
            raise AssertionError("search acceptance requires a managed ripgrep artifact")
        rg = self.args.rg if self.args.ssh else str(Path(self.args.rg).resolve())
        path = self.root + "/search"
        self.write(path + "/a.txt", b"remote-only needle\n")
        proc = self.client.request("process.spawn", argv=[rg, "--no-config", "--json", "needle", path], cwd=self.root,
                                   stdout={"mode": "collect"}, stderr={"mode": "collect"})
        assert self.done(proc)["rootExit"]["code"] == 0
        assert b'"type":"match"' in self.consume(proc["outputs"][0]["stream"])
        self.release(proc)
        for pattern, code in [("missing-pattern", 1), ("[", 2)]:
            proc = self.client.request("process.spawn", argv=[rg, "--no-config", pattern, path], cwd=self.root,
                                       stdout={"mode": "collect"}, stderr={"mode": "collect"})
            assert self.done(proc)["rootExit"]["code"] == code
            self.release(proc)

    def lease(self):
        self.client.request("runtime.shutdown", deadlineMs=5000)
        self.client.disconnect()
        self.start("leased", lease=500)
        c = self.connect()
        proc = self.spawn("hold")
        credentials = c.hello
        eventually(lambda: c.dead, timeout=2)
        c.disconnect()
        c = self.connect(credentials)
        assert self.status(proc)["rootExit"] is None
        c.request("process.terminate", process=proc["process"])
        self.release(proc)

    def grace_cleanup(self):
        c = self.client
        credentials = c.hello
        proc = self.spawn("hold")
        c.disconnect()
        time.sleep(self.grace_ms / 1000 + 0.7)
        # Connection failure is a failure to resume, never a new local execution.
        child = subprocess.run(self.command([self.helper, "connect", "--socket", self.runtime + "/socket"]), input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert child.returncode != 0
        self.start("replacement")
        c = self.connect()
        assert c.hello["runtime"] != credentials["runtime"]
        expect("UNKNOWN_RESOURCE", lambda: c.request("process.status", process=proc["process"]))

    def cleanup(self):
        if self.client and not self.client.dead:
            try:
                self.client.request("runtime.shutdown", deadlineMs=5000)
            finally:
                self.client.disconnect()
        if self.args.ssh:
            self.run(["rm", "-rf", "--", self.root])
        else:
            shutil.rmtree(self.root, ignore_errors=True)

    def execute(self):
        try:
            self.start()
            c = self.connect()
            assert c.hello["platform"] == ("macos" if self.args.platform == "macos" else "linux")
            for name in ["handshake", "filesystem", "pipes", "input_ordering", "collection", "backpressure_resume", "dedup", "termination", "pty", "cancellation", "search", "lease", "grace_cleanup"]:
                self.case(name, getattr(self, name))
            report = {"platform": self.args.platform, "os": c.hello["platform"], "arch": c.hello["arch"], "api": c.hello["api"], "graceMs": self.args.grace_ms, "passed": self.passed,
                      "unverified": ["DSH adapter composition", "restricted-account permission failures", "arbitrary escaped descendants"],
                      "search": "passed" if self.args.rg else "unverified: no uploaded artifact provided"}
            if self.args.report:
                Path(self.args.report).write_text(json.dumps(report, indent=2) + "\n")
        finally:
            self.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", required=True)
    parser.add_argument("--fixture", default="runtime/helper/target/debug/dsh-remote-fixture")
    parser.add_argument("--platform", choices=["macos", "linux-container", "linux-embedded"], required=True)
    parser.add_argument("--ssh")
    parser.add_argument("--rg")
    parser.add_argument("--report")
    parser.add_argument("--grace-ms", type=int, default=1800, help="runtime grace budget; include full SSH setup time for nested or high-latency transports")
    Suite(parser.parse_args()).execute()
