#!/usr/bin/env python3
"""Upload acceptance artifacts over system OpenSSH; no SFTP or remote compiler.
The destination must be an existing directory dedicated to this test run.
"""
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import shlex
import subprocess


def upload(host, destination, artifacts):
    target = PurePosixPath(destination)
    if not target.is_absolute() or ".." in target.parts or destination == "/":
        raise ValueError("destination must be an explicit absolute test directory")
    ssh = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host]
    subprocess.run(ssh + ["test -d " + shlex.quote(str(target))], check=True)
    for name, source in artifacts.items():
        data = Path(source).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        path = shlex.quote(str(target / name))
        command = f"umask 077; cat > {path} && chmod 700 {path} && sha256sum {path}"
        result = subprocess.run(ssh + [command], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        if result.stdout.decode().split()[0] != digest:
            raise RuntimeError("uploaded artifact checksum mismatch: " + name)
        print(name + " sha256=" + digest, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--helper", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--rg", required=True)
    args = parser.parse_args()
    upload(args.ssh, args.destination, {"dsh-remote": args.helper, "dsh-remote-fixture": args.fixture, "rg": args.rg})
