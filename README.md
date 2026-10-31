# pi-pytool

A [pi](https://pi.dev) extension that adds one tool, `pytool`: a **session-persistent Python kernel** the
agent can call like any other tool. Variables, imports, loaded data, open files and live object handles
stay alive for the whole session. Only output comes back to the conversation.

```
✓ pytool · app = connect("DraftSight.Application")
✓ pytool · sheet = app.ActiveSheet()
✓ pytool · sheet.Line(0, 0, 40, 0)          · <Line object …>
```

`app` is still a live COM proxy in cell three. Nothing was re-connected and nothing re-dispatched.

## Why

pi's code mode is stateless per call: every invocation starts a fresh interpreter. That is free until the
work has state that is expensive or impossible to rebuild — a loaded dataset, a database transaction, a
live COM apartment. Driving DraftSight over `win32com` is the founding case: re-acquiring that connection
per call costs an interpreter start, `import win32com.client`, typelib dispatch warm-up and a fresh COM
apartment, roughly 0.3–1.5 s paid once per tool call, so a drawing built over 50 turns pays it 50 times.

Two purposes, in order:

1. **Persistent connections** — COM/Office/DraftSight, DB sessions, anything with a handle.
2. **Data exploration** — a namespace that accumulates instead of a script that reloads.

## This is not pi-repl-py

`pytool` is **one tool among the agent's others**. The reference extension collapses the model's tool
surface to its own `execute` at `session_start`; this one calls `setActiveTools` nowhere. `read`, `bash`,
`edit`, `write`, `fabric_exec` and MCP tools stay exactly where they were, and `pytool` registers beside
them.

Everything that only made sense once the tool owned the session is out:

| Left out | Why |
| --- | --- |
| tool-surface takeover | the point of the fork: the agent keeps its other tools |
| namespace snapshots (`cloudpickle`, restore, fork inheritance, state dirs) | a pywin32 COM proxy, an open DWG and a DB connection cannot be pickled — the snapshot could never revive the handles this tool exists for. A rebuilt kernel starts empty and says so. |
| helper preloading (`~/.pi/agent/pi-repl/helpers`) | `pip install --python $PI_PYTHON` into the kernel's own interpreter does the same job with one protocol, and sibling skills (draftsight-com) already ship as packages |
| skills-block and prompt injection | pi owns the prompt; `pytool` contributes only its own tool description and guidelines |
| custom TUI render + expression preview (~700 lines) | pi's default tool rendering is enough |
| `bash(...)`/`read(...)` callables inside the kernel | retired in the reference too; the other tools are right outside |

What stayed, because it is load-bearing: the stdio-bridge protocol, the interpreter ladder, the output
caps, the interrupt/abort/reap semantics, and the Windows process-tree kill.

## Install

```bash
pi install git:github.com/3DAlgoLab/pi-pytool
```

`postinstall` builds the venv the kernel needs at `~/.pi/agent/pytool/venv` (`uv` when present, `pip`
otherwise; `pywin32` on Windows). If `python3` or the network is missing it says so plainly instead of
half-building. On a clone: `npm install`, or `npm run setup-venv` alone. `PYTOOL_SKIP_VENV=1` defers it.

## Use

Start `pi` and send Python to `pytool`. Nothing to switch on; the kernel warms in the background at
`session_start`, so the first cell waits on a boot that already started.

- `pytool({ code, maxOutputChars? })` — stdout, stderr and the last-expression value come back.
- A cell that raises reports the traceback and the kernel keeps everything it had.
- `/pytool` is read-only diagnostics: interpreter and which rule picked it, the three process roles with
  their pids, the live names in the namespace, the output cap.

| Variable | Effect |
| --- | --- |
| `PYTOOL_PYTHON`, `PI_PYTHON` | pin the interpreter, trusted without probing (`PI_PYTHON` is the shared contract with sibling skills, and the kernel exports the winner as `PI_PYTHON`) |
| `PYTOOL_TIMEOUT_MS` | silence watchdog: interrupt a cell after this long with no output; `0` (off) by default |
| `PYTOOL_ABORT_GRACE_MS` | how long an aborted cell gets before the kernel is reaped (`5000`) |
| `PYTOOL_MAX_OUTPUT_CHARS` | per-cell output cap, `46080`; `4096` per line, cuts marked. A caller with one budget shared across many nested results sets this once; one call can override it with `maxOutputChars` |
| `PYTOOL_BOOT_TIMEOUT_MS` | deadline for a kernel that boots but never answers (`90000`) |
| `PYTOOL_SKIP_VENV=1` | skip the venv build at install time |

## Interrupts, measured

Aborting a cell (Ctrl-C, or the harness cancelling the call) sends an interrupt, which takes effect at the
next Python bytecode boundary and cannot enter a blocking call. Measured on Windows, Python 3.14: a loop of
`time.sleep(0.05)` dies ~0.2 s after the signal; one `time.sleep(3)` finishes its 3 s first. A cell parked
inside a single C call — a hung COM/RPC, a socket read — never regains a boundary, so after
`PYTOOL_ABORT_GRACE_MS` the kernel is killed and the result says `KernelReaped`: every live handle it held
died with it, and the next cell boots an empty kernel. The engine survives its kernel.

The rule that follows from that, and the one guideline this tool adds to the prompt: **write COM work as
many short calls.** Forty COM calls are interruptible between each; one `Rebuild()` is not interruptible at
all.

## Layout

```
bridge.py            the Python side: jupyter_client + ipykernel, one JSON line per op
src/engine/
  python-locate.ts   pin > managed venv > PATH, each non-pin probed for ipykernel/jupyter_client
  kernel.ts          spawn the bridge, route events by id, cap output, kill the process tree
  index.ts           boot, cell queue, abort grace, reset notice, teardown
src/extension/
  prompt.ts          the tool's own description, snippet, guidelines
  diagnostics.ts     /pytool output
scripts/setup-venv.mjs  the managed venv, uv-aware, platform-aware
```

Three processes matter, and more on Windows: a venv `python.exe` is a launcher stub that re-execs, so a live
session there is a chain of launcher → bridge → ipykernel-launcher → the interpreter that holds the COM
proxies. Killing the bridge alone orphans that last one, holding your document open with nobody left to
release it, so teardown is always a tree kill (`taskkill /PID <root> /T /F`, `kill(-pid)` on POSIX).

## Tests

```bash
bun test pytool-units              # no kernel: routing, caps, interpreter ladder, model-facing text
bun test pytool-integration        # real ipykernel: persistence, abort, reap, caps

# the filter is the file-name stem: bun matches patterns by substring, which would otherwise also
# reach the vendored tests under references/
npm run typecheck
```

## Status

- Built and gated on Linux (pi 1.4.0, Python 3.14).
- **Windows: written to the measured rules of the reference (Win32 interrupt event handle, tree kill,
  `Scripts/python.exe`, `py -3`, `pywin32` in the managed venv) but not yet run there.** The acceptance that
  has to be measured on that machine: `tasklist` python count unchanged after a session, `$PI_PYTHON`
  resolving into the same venv `draftsight-com` installs into, and a live DraftSight `connect()` → geometry
  → kill kernel → reconnect smoke.

## Not

- Not a sandbox: the kernel runs with your permissions.
- Not a replacement for the other tools: file and shell work stays outside it.
- Not durable across restarts: the namespace lives as long as the kernel does.

## License

MIT.
