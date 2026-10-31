#!/usr/bin/env python3
"""pytool bridge: owns ipykernel and the Jupyter protocol; talks to the TS host over one stdio pipe.

Protocol (JSON lines; host -> bridge on stdin, bridge -> host on stdout):
  in:  {"op":"boot"}                                        first message, before anything
       {"op":"exec","id":str,"code":str}                     run a cell (streams + one result)
       {"op":"listNames","id":str}                           current public names
       {"op":"interrupt"}                                    KeyboardInterrupt in the kernel
       {"op":"shutdown","id":str}                            graceful teardown, then exit 0
  out: {"type":"ready","pid":int,"kernel_pid":int}           kernel up
       {"type":"stream","id":str,"name":"stdout"|"stderr","text":str}
       {"type":"result","id":str,"status":"ok"|"error"|"aborted",   cell settled
              "result":str?,"error":{"name":str,"message":str,"stack":[str]}?}
       {"type":"reply","id":str,"names":[str]}               listNames
       {"type":"error","id":str?,"message":str}              protocol-level failure
       {"type":"dying","message":str?}                       best-effort before exit(1)

Deliberately absent, versus a general-purpose REPL host: namespace snapshots, helper preloading, and
tool callables inside the kernel. pytool is one tool among the agent's others. Recovery after a killed
kernel is a fresh, empty interpreter said out loud, because the handles this tool exists to keep -- a
pywin32 COM proxy, an open document, a database connection -- cannot be pickled and revived anyway.

The bridge is single-threaded over the kernel (one op at a time); the host serializes ops anyway. A
stdin reader thread only relays lines; all kernel I/O stays on the main thread. When the kernel dies the
bridge exits and the host treats that exit as kernel death. stdin EOF (host gone) shuts it down cleanly.
"""
import json
import os
import queue
import sys
import threading

from jupyter_client import KernelManager
from jupyter_client.kernelspec import NoSuchKernel

NAMES_MIME = "application/vnd.pytool.names+json"
READY_TIMEOUT_S = 30
# ipython's own bookkeeping; never a name the session defined.
SKIP_NAMES = ["In", "Out", "get_ipython", "exit", "quit", "open", "__pytool_r", "__pytool_n"]


def names_code():
    return ("import json as _js\n"
            + "__pytool_skip = set(" + json.dumps(SKIP_NAMES) + ")\n"
            + "__pytool_n = sorted(n for n in globals() if not n.startswith('_') and n not in __pytool_skip)\n"
            + "get_ipython().display_pub.publish({" + json.dumps(NAMES_MIME) + ": _js.dumps(__pytool_n)})\n")


def use_utf8_stdio():
    """Pin the protocol pipe to UTF-8 instead of the OS locale codec.

    The host writes protocol lines as UTF-8 (Node default), but text-mode stdin uses the locale codec,
    which is cp949 on a Korean Windows box (measured). Decoding UTF-8 as cp949 mangles cell source
    before json.loads sees it: a print("재질") cell arrived as U+FFFD U+C631 U+F9DE U+FFFD, so any
    Hangul, CJK, degree sign or Ø typed into a cell reached the kernel as garbage. Strict on stdin so a
    genuinely bad byte is a logged protocol error rather than silent corruption; the outbound side is
    already ASCII-safe through json.dumps, and is pinned only to keep the contract explicit.
    """
    for name, errors in (("stdin", "strict"), ("stdout", "backslashreplace")):
        stream = getattr(sys, name, None)
        try:
            stream.reconfigure(encoding="utf-8", errors=errors)
        except (AttributeError, ValueError, OSError):
            pass


class Bridge:
    def __init__(self):
        self.km = None
        self.kc = None
        self.requests = queue.Queue()
        self.op_id = None           # id of the exec currently streaming, for stream routing
        self.op_payload_mime = None  # private MIME awaited for an internal cell (listNames)

    # ----- IO -----

    def emit(self, msg):
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()

    def _stdin_reader(self):
        # BufferedReader.read(n) blocks until n bytes arrive; line iteration returns per line
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.requests.put(json.loads(line))
            except Exception as e:
                self.emit({"type": "error", "message": "bad request line: %s" % e})
                self.requests.put({"op": "shutdown", "id": "bad-line"})
        self.requests.put({"op": "__eof__"})

    # ----- kernel lifecycle -----

    def kernel_pid(self):
        """The ipykernel subprocess pid, or None before it is up. jupyter_client 8 keeps it on the
        provisioner; older releases put it on the manager."""
        if self.km is None:
            return None
        provisioner = getattr(self.km, "provisioner", None)
        pid = getattr(provisioner, "pid", None) if provisioner is not None else None
        return pid or getattr(self.km, "pid", None)

    def start_kernel(self):
        km = KernelManager(kernel_name="python3")
        try:
            km.start_kernel()
        except NoSuchKernel:
            km = KernelManager(kernel_name="python3", kernel_cmd=[
                sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"])
            km.start_kernel()
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=READY_TIMEOUT_S)
        except Exception:
            km.shutdown_kernel(now=True)
            raise
        self.km, self.kc = km, kc

    def stop_kernel(self):
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        try:
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass

    # ----- cells -----

    def run_cell(self, code, emit_stream, payload_mime=None, emit_id=None):
        """Run one cell; settle on shell reply AND iopub idle (a reply alone can beat big output).
        Returns {status, result?, error?}. Exits the bridge when the kernel died."""
        kc = self.kc
        msg_id = kc.execute(code, silent=False, store_history=False,
                            user_expressions={}, allow_stdin=False, stop_on_error=True)
        self.op_id = msg_id
        self.op_payload_mime = payload_mime
        result = None
        error = None
        payload = None
        quiet_for = 0.0
        try:
            while True:
                # pending interrupts/shutdowns act within one poll cadence
                self._drain_control_queue()
                try:
                    msg = kc.get_iopub_msg(timeout=0.25)
                except Exception:
                    # timeout: poll the heartbeat instead of timing out the whole bridge
                    quiet_for += 0.25
                    if quiet_for >= 2.0:
                        if not self.kernel_alive():
                            self.emit({"type": "dying", "message": "kernel heartbeat lost"})
                            sys.exit(1)
                        quiet_for = 0.0
                    continue
                if msg.get("parent_header", {}).get("msg_id") != msg_id:
                    continue
                quiet_for = 0.0
                ctype = msg["msg_type"]
                content = msg["content"]
                if ctype == "stream":
                    if emit_stream:
                        self.emit({"type": "stream", "id": emit_id or msg_id,
                                   "name": "stderr" if content.get("name") == "stderr" else "stdout",
                                   "text": content.get("text") or ""})
                elif ctype == "execute_result":
                    data = content.get("data") or {}
                    if "text/plain" in data:
                        result = data["text/plain"]
                    payload = self._take_payload(content)
                elif ctype == "display_data":
                    payload = self._take_payload(content)
                elif ctype == "error":
                    error = {
                        "name": content.get("ename") or "Error",
                        "message": content.get("evalue") or "",
                        "stack": content.get("traceback") or [],
                    }
                elif ctype == "status" and content.get("execution_state") == "idle":
                    break
        except SystemExit:
            raise
        except Exception as e:
            if not self.kernel_alive():
                self.emit({"type": "dying", "message": "kernel died mid-cell"})
                sys.exit(1)
            raise
        status = "ok"
        reply = None
        for _ in range(20):
            try:
                candidate = kc.get_shell_msg(timeout=10)
            except Exception:
                break
            if candidate.get("parent_header", {}).get("msg_id") == msg_id:
                reply = candidate
                break
            # stale reply from an earlier op (a late kernel_info, or an "incomplete input" error
            # flushed by this request): drain it, keep looking
        if reply:
            status = reply.get("content", {}).get("status", "ok")
        if status != "aborted" and error is not None:
            # iopub error wins over an "ok" reply (ipykernel: compile-phase failures reply ok)
            status = "error"
        if status == "error" and error is None:
            c = reply.get("content", {})
            error = {"name": c.get("ename") or "Error", "message": c.get("evalue") or "cell failed", "stack": []}
        if status == "aborted" and error is None:
            error = {"name": "KeyboardInterrupt", "message": "cell interrupted", "stack": []}
        self.op_id = None
        self.op_payload_mime = None
        return {"status": status, "result": result, "error": error, "payload": payload}

    def _take_payload(self, content):
        data = content.get("data") or {}
        mime = self.op_payload_mime
        if mime is not None and mime in data:
            return data[mime]
        return None

    def _drain_control_queue(self):
        # control-plane ops may jump the queue mid-cell; anything else is left in order
        while True:
            try:
                op = self.requests.get_nowait()
            except queue.Empty:
                break
            if op["op"] == "interrupt":
                self.interrupt()
            elif op["op"] in ("shutdown", "__eof__"):
                self.stop_kernel()
                sys.exit(0)
            else:
                self.requests.put(op)
                break

    def interrupt(self):
        if os.name == "nt" and self._interrupt_windows():
            return
        # BlockingKernelClient has no interrupt() in jupyter_client 8.x; send the control-channel
        # request the kernel's poller acts on.
        msg = self.kc.session.msg("interrupt_request", content={})
        self.kc.control_channel.send(msg)

    def _interrupt_windows(self):
        """Interrupt a Windows kernel, which does not honour the control-channel request: ipykernel logs
        "Interrupt message not supported on Windows" and the cell keeps running, leaving the host's
        watchdog one option only -- a kill that throws the namespace away.

        When jupyter_client launched the kernel it created a Win32 event (handed to the kernel as
        JPY_INTERRUPT_EVENT, where ParentPollerWindows waits on it) and attached the handle to the
        kernel's Popen. Setting that event leaves the kernel -- and every handle it holds -- alive.

        What it does not do is enter the running cell. The event makes ipykernel call interrupt_main(),
        which raises KeyboardInterrupt at the cell's *next bytecode boundary*: measured on Windows, a loop
        of 0.05s sleeps dies ~0.2s after the event while a single time.sleep(3) runs the full 3s first. A
        cell parked inside one C call (a hung DraftSight RPC, a socket read) never regains a boundary and
        is unaffected -- only killing the kernel reclaims that, and the host says so rather than reporting
        a clean abort.
        """
        try:
            proc = getattr(getattr(self.km, "provisioner", None), "process", None)
            handle = getattr(proc, "win32_interrupt_event", None) if proc else None
            if handle:
                from jupyter_client.win_interrupt import send_interrupt

                send_interrupt(handle)
                return True
            # No handle on this launcher: let jupyter_client route the kernel spec's interrupt_mode.
            self.km.interrupt_kernel()
            return True
        except Exception as e:
            sys.stderr.write("windows interrupt unavailable: %s\n" % e)
            return False

    def kernel_alive(self):
        try:
            return self.km.is_alive()
        except Exception:
            return False

    # ----- ops -----

    def op_exec(self, op):
        res = self.run_cell(op["code"], emit_stream=True, emit_id=op["id"])
        out = {"type": "result", "id": op["id"], "status": res["status"]}
        if res["result"] is not None:
            out["result"] = res["result"]
        if res["error"] is not None:
            out["error"] = res["error"]
        self.emit(out)

    def op_names(self, op):
        res = self.run_cell(names_code(), emit_stream=False, payload_mime=NAMES_MIME)
        names = json.loads(res["payload"]) if res["payload"] is not None else []
        self.emit({"type": "reply", "id": op["id"], "names": names})

    # ----- main loop -----

    def serve(self):
        threading.Thread(target=self._stdin_reader, daemon=True).start()
        boot = self.requests.get()
        if boot.get("op") == "__eof__":
            return
        if boot.get("op") != "boot":
            self.emit({"type": "error", "message": "first op must be boot"})
            sys.exit(1)
        try:
            self.start_kernel()
        except Exception as e:
            self.emit({"type": "error", "message": "boot failed: %s" % e})
            sys.exit(1)
        # Three pids matter on Windows: the venv launcher we were spawned as, this bridge process, and
        # the ipykernel child that actually runs cells and holds live handles (COM proxies die with it).
        # jupyter_client 8 moved the kernel pid to km.provisioner.pid; the old km.pid is gone.
        self.emit({"type": "ready", "pid": os.getpid(), "kernel_pid": self.kernel_pid()})
        while True:
            op = self.requests.get()
            o = op.get("op")
            if o == "__eof__":
                self.stop_kernel()
                sys.exit(0)
            try:
                if o == "exec":
                    self.op_exec(op)
                elif o == "listNames":
                    self.op_names(op)
                elif o == "interrupt":
                    self.interrupt()
                elif o == "shutdown":
                    self.stop_kernel()
                    sys.exit(0)
                else:
                    self.emit({"type": "error", "id": op.get("id"), "message": "unknown op: %s" % o})
            except Exception as e:
                self.emit({"type": "error", "id": op.get("id"), "message": "%s" % e})


def main():
    # Before the stdin reader thread starts: every protocol line, including cell source,
    # is decoded through this.
    use_utf8_stdio()
    try:
        Bridge().serve()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
