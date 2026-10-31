# Handoff — pi-pytool on Windows

Built and gated on Linux (pi 1.4.0, Python 3.14.3, uv, bun 1.3.14). Every Windows-specific path below was
written from measurements taken on a Windows box by the reference implementation (`references/pi-repl-py`),
**not executed by this port**. Sections 2–3 are the only code that has to change before the gates can run
there; 4–7 are the measurements that decide whether the port is real.

## 1. What is proven, and where

| Claim | Linux evidence | Windows status |
| --- | --- | --- |
| `pytool` registers beside `read/bash/edit/write`; `setActiveTools` never called | load gate, in-process + CLI | written, unmeasured |
| kernel warm-boots at `session_start`, whole tree dies with the session | load gate (`ps` census → 0) | census is POSIX-only, see W1 |
| names, imports and object handles survive cells | integration gate (4 tests) | expected to pass unchanged |
| aborted cell: interrupt cuts it, kernel intact | integration gate (1.4 s) | needs re-measure, §6 |
| cell parked past the grace → `KernelReaped`, next cell gets a fresh kernel + reset notice | integration gate | fixture is POSIX-shaped, see W2 |
| bridge death settles the running cell | unit gate (fake bridge) | expected to pass |
| output caps mark the loss and count it | unit + integration | expected to pass |
| `taskkill /PID <root> /T /F` clears launcher → bridge → ipykernel chain | none | **§5, the one that matters** |
| Windows interrupt via `win32_interrupt_event` | none | **§6** |

## 2. W1 — process census must become platform-aware (blocks the leak gate)

`test/pytool-load.test.ts` counts python with `ps -eo args`, which does not exist on Windows. Replace
`pythonishCount()`:

```ts
function pythonishCount(): number {
	if (process.platform === "win32") {
		const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
		return out.split("\n").filter((l) => /"python(\.exe)?"/i.test(l) || /pythonw/i.test(l)).length;
	}
	const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
	return out.split("\n").filter((l) => l.includes("bridge.py") || l.includes("ipykernel")).length;
}
```

Two notes. On Windows the census counts *all* python on the machine, so compare against a baseline taken
in the same test and keep the machine otherwise idle. And `Bun.spawn(["pi", ...])` in that file will likely
fail on Windows: npm's `pi` is a `.cmd` shim, and spawn without a shell does not resolve it. Use
`["cmd", "/c", "pi", ...]` and re-check that RPC stdin piping still works through the shim.

## 3. W2 — the reap fixture is POSIX-shaped

`test/pytool-integration.test.ts` makes a cell ignore the interrupt by installing a swallowing `SIGINT`
handler, because on POSIX a bare `time.sleep` *is* cut by the signal. On Windows there are no signals in that
sense: the interrupt is an event handle, and `time.sleep(10)` parked in C is already the parked case. Make
the fixture choose its cell:

```ts
const parkedCell = process.platform === "win32"
	? "import time\ntime.sleep(10)"
	: "import signal\nsignal.signal(signal.SIGINT, lambda *a: None)\nimport time\ntime.sleep(10)";
```

The `survivor = 7` half of that test (interrupt lands, kernel keeps its names) should hold on Windows with
the loop-of-0.05 s-sleeps cell — that is exactly the case the reference measured at ~0.2 s.

## 4. Run the gates there

```powershell
git clone <remote> && cd pi-pytool
npm install                      # postinstall builds %USERPROFILE%\.pi\agent\pytool\venv
npm run -s typecheck
bun test pytool-units            # no kernel: routing, caps, ladder — expect 17 pass unchanged
bun test pytool-integration      # live ipykernel: persistence, abort, reap, caps
bun test pytool-load             # needs W1 + the cmd /c fix
```

Install-time facts to confirm, not assume:

- venv lands at `%USERPROFILE%\.pi\agent\pytool\venv` with `Scripts\python.exe` (uv-created venvs have no
  pip of their own — installs route through `uv` when it is on PATH, `pip` otherwise).
- `pywin32` is installed there and probed as the import name `win32com`, not the pip name. Its absence is a
  warning, not a failed install; for this tool on Windows it is the point, so treat the warning as a blocker
  for §7.
- `pi install ./pi-pytool` afterwards, then `/pytool` in a real session.

## 5. The four-process chain and the leak measurement

A venv `python.exe` on Windows is a launcher stub that re-execs, and `jupyter_client` spawns ipykernel
through that same stub. A live session is therefore:

```
launcher (child.pid, the one we spawned) → bridge (bridgePid, reported by bridge "ready")
        → ipykernel launcher → interpreter (kernelPid — holds the COM proxies)
```

`kill()` calls `taskkill /PID <child.pid> /T /F` (`src/engine/kernel.ts:93`), which is the only thing that
reaches the leaf; `detached` is deliberately false on Windows (`kernel.ts:135`) because there are no process
groups, so the tree kill is the whole teardown story. `/pytool` prints the roles and, when the launcher pid
differs from the bridge pid, the exact `taskkill` line.

Manual measurement, do it even after W1:

```powershell
tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH | Measure-Object -Line   # baseline
# start pi, run: pytool cells `x = 1`, a COM connect, /pytool, then exit pi
```

**Pass:** the count returns to the baseline within ~2 s of pi exiting, and no `python.exe` survives whose
parent is gone (`wmic process where "name='python.exe'" get ProcessId,ParentProcessId` is the check). A
surviving ipykernel is the failure this design exists to avoid: it keeps the COM apartment and the document
lock with nobody left to release them.

Also verify the graceful half before the violent half: on normal exit the bridge answers the `shutdown` op
and ipykernel exits on its own within the 2 s window (`kernel.ts:501`), so `taskkill` should not be needed.
If `taskkill` is doing all the work every time, the bridge is not reaching its kernel — capture bridge
stderr.

## 6. Interrupt semantics — re-measure, do not trust the reference numbers

The mechanism is in `bridge.py:_interrupt_windows`: it takes `km.provisioner.process.win32_interrupt_event`
and calls `jupyter_client.win_interrupt.send_interrupt(handle)`; if that handle is missing it falls back to
`km.interrupt_kernel()` and writes `windows interrupt unavailable: …` to bridge stderr. **Seeing that line
means the fallback is in use and the interrupt is probably a no-op** — ipykernel logs "Interrupt message not
supported on Windows" for the control-channel request. That is the first thing to check if aborts look dead.

What the event can and cannot do: it makes ipykernel call `interrupt_main()`, which raises
`KeyboardInterrupt` at the cell's **next bytecode boundary**. It cannot enter a blocking C call.

Abort in pi with Ctrl-C (or the harness cancelling the call). Record real numbers in the table.

| cell | expectation | reference measurement | measured here |
| --- | --- | --- | --- |
| `for _ in range(200): time.sleep(0.05)` | cut fast, names intact | ~0.2 s | |
| `time.sleep(3)` | runs its 3 s, then dies | 3 s | |
| `time.sleep(10)` with grace 1.5 s | `aborted` + `KernelReaped`, next cell says `<pytool_kernel_reset>` | — | |
| a real hung COM call (`app.Rebuild()` on a wedged drawing) | never regains a boundary → reaped | — | |

Set the grace low for the last two: `set PYTOOL_ABORT_GRACE_MS=1500` before starting pi. Then confirm the
next cell carries the reset notice and a `NameError` for a name that existed before — the namespace is gone
and the model must be told.

## 7. COM smoke — the founding use case

Prerequisite: DraftSight running, and the `draftsight-com` skill's package installed **into the kernel's own
interpreter**. The kernel exports the interpreter it chose as `PI_PYTHON`, which is the shared contract with
that skill — this is the exact failure the skill documents today (package installed into the wrong
interpreter, import fails silently):

```powershell
/pytool                                  # read the `python:` line; that is $env:PI_PYTHON's value
uv pip install --editable --python $env:PI_PYTHON references\draftsight-com
```

Then in one pi session:

1. `from win32com.client import Dispatch; app = Dispatch("DraftSight.Application")` — cell 1.
2. `app.ActiveSheet()` and one `sheet.Line(0, 0, 40, 0)` — cell 2, using `app` from cell 1. **This is the
   whole product: no reconnect, no re-dispatch.** Geometry must appear in the drawing.
3. A trivial cell (`app.Version`) to prove the proxy is still live rather than a stale reference.
4. Kill the kernel (a cell parked past the grace, §6), then reconnect in a new cell. Expect a fresh
   connection and a `KernelReaped`/reset notice in between, and expect DraftSight itself to survive and stay
   operable — no zombie lock, no "application is not responding".

Watch for the classic Windows traps while doing this: 32/64-bit mismatch between the interpreter and the
application, and `MakePath`-style typelib dispatch warm-up. If `Dispatch` works in `python` but not in
`pytool`, the ladder picked a different interpreter than the one the package went into — `/pytool` shows
which, and `PYTOOL_PYTHON` (or `PI_PYTHON`) pins it without probing.

## 8. Windows code paths, what each can do wrong

| site | code | failure signature | smallest fix |
| --- | --- | --- | --- |
| `src/engine/kernel.ts:93` | `taskkill /PID <pid> /T /F`, and on `r.error` it falls through to a plain `child.kill()` | a bridge-only kill **orphans the ipykernel** — the leak this design exists to prevent, silently | log the `taskkill` failure to bridge-visible stderr, and retry with `/T` only (never drop `/T`) |
| `src/engine/kernel.ts:135` | `detached: false`, `windowsHide: true` | a console window per launch, or a group signal that never arrives | keep as is; verify no window appears |
| `src/engine/kernel.ts` `onData` | lines split on `\n` then `.trim()` | CRLF would break JSON parsing | already safe (trim); confirm once by reading a `ready` line in a debug run |
| `bridge.py:224-261` | `win32_interrupt_event` → `send_interrupt`, else `km.interrupt_kernel()` | bridge stderr `windows interrupt unavailable`, or ipykernel's "not supported on Windows"; abort appears to do nothing until the grace kills the kernel | pin the jupyter_client version that supplies the handle; if the provisioner changed, read the handle from the new location |
| `src/engine/python-locate.ts:81-84` | `python3`, `python`, then `py -3` | `python` resolving to the Microsoft Store stub and the probe failing all three | the `py -3` entry is the fix for that; if it still fails, set `PYTOOL_PYTHON` |
| `scripts/setup-venv.mjs:18-26` | `Scripts\python.exe`, `pywin32` as a warn-only extra | COM cells raise `ModuleNotFoundError: win32com` | `uv pip install --python <venv> pywin32`, then re-run the script to see the probe go green |
| encoding | `json.dumps` keeps `ensure_ascii` at its default, so the pipe carries ASCII only; bridge stderr is not pinned | mojibake only in bridge diagnostics, never in cell output | if it ever bites, set `PYTHONIOENCODING=utf-8` on the bridge spawn |

## 9. Not bugs — do not "fix" them on Windows

- No `setActiveTools` anywhere: `pytool` is one tool among the agent's others. That is the fork.
- No snapshots, no state dir, no `--restore`: a pywin32 proxy cannot be pickled, so a rebuilt kernel starts
  empty and says so.
- `~/.pi/agent/pi-repl/helpers` is not read. Sibling packages install into the kernel interpreter instead.
- `/pytool` has no snapshot or fork fields; its `namespace:` line is a live `listNames` read, and `no
  snapshots: a rebuilt kernel starts empty` is a deliberate last line.
- No custom TUI rendering: pi's default tool rendering shows streamed stdout.

## 10. Definition of done

1. `npm run -s typecheck`, `bun test pytool-units`, `bun test pytool-integration`, `bun test pytool-load`
   all green on Windows (W1 and W2 applied).
2. §5 pass: process count back to baseline, graceful shutdown doing most of the work.
3. §6 table filled with measured numbers; if they differ from the reference, update `README.md` "Interrupts,
   measured" and the comment in `bridge.py:_interrupt_windows`.
4. §7 pass end to end against a live DraftSight, including the kill-and-reconnect.
5. Update `README.md` Status: drop the "not yet run there" line, keep the Linux line, and note the Windows
   python/pi versions measured. Append the findings here so the next reader sees them in one place.
