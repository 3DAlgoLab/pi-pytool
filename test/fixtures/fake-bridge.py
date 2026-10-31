#!/usr/bin/env python3
"""A stand-in for bridge.py used by the unit tests: the same protocol, no ipykernel.

The cell's source selects the behaviour, so one tiny program covers every routing case the host has to
get right: multi-frame streams settled by one result, an error line carrying the exec id, and a bridge
that dies mid-cell.
"""
import json
import sys


def emit(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        op = json.loads(line)
        kind = op.get("op")
        if kind == "boot":
            emit({"type": "ready", "pid": 4242, "kernel_pid": 4243})
        elif kind == "exec":
            code, oid = op["code"], op["id"]
            if code == "stream":
                emit({"type": "stream", "id": oid, "name": "stdout", "text": "one\n"})
                emit({"type": "stream", "id": oid, "name": "stdout", "text": "two\n"})
                emit({"type": "stream", "id": oid, "name": "stderr", "text": "bad\n"})
                emit({"type": "result", "id": oid, "status": "ok", "result": "42"})
            elif code == "big":
                emit({"type": "stream", "id": oid, "name": "stdout", "text": "x" * 5000})
                emit({"type": "result", "id": oid, "status": "ok"})
            elif code == "refused":
                emit({"type": "error", "id": oid, "message": "op refused"})
            elif code == "die":
                emit({"type": "stream", "id": oid, "name": "stdout", "text": "partial"})
                sys.exit(1)
            elif code == "noise":
                sys.stdout.write("not json at all\n")
                sys.stdout.flush()
                emit({"type": "result", "id": oid, "status": "ok", "result": "survived"})
            else:
                emit({"type": "result", "id": oid, "status": "ok"})
        elif kind == "listNames":
            emit({"type": "reply", "id": op["id"], "names": ["df", "app"]})
        elif kind == "shutdown":
            sys.exit(0)


if __name__ == "__main__":
    main()
