# Handoff — pi-pytool on Windows

Built and gated on Linux (pi 1.4.0, Python 3.14.3, uv, bun 1.3.14). Every Windows-specific path below was
written from measurements taken on a Windows box by the reference implementation (`references/pi-repl-py`).
Sections 2–7 **have since been executed here**: Windows 11 (10.0.26300), pi 1.4.0, Python 3.14.4 64-bit in the
managed venv, bun 1.4.4, node v26.8.2, jupyter_client 8.10.0, ipykernel 7.4.0. The numbers in §5–§7 are this
box's, not the reference's, and §11 records what the run found and what it changed.

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

Measured with `scripts/measure-process-chain.ts` (`npm run measure:process-chain`). It walks the tree by
`ParentProcessId` rather than counting python pids: the venv launcher stub and the bridge share one command
line, so a flat count cannot tell our chain from an unrelated interpreter.

| stage | measured |
| --- | --- |
| baseline | 0 python in the session's tree |
| live session | 4 — launcher → bridge → ipykernel launcher → ipykernel interpreter, confirmed by ppid links |
| normal exit | all 4 gone 507 ms after the `shutdown` op, **before any `taskkill` ran** |
| tree kill | all 4 gone 570 ms after `taskkill /PID <launcher> /T /F` |
| orphans | 0 python whose parent is gone |

**Pass:** the count returns to the baseline within ~2 s of pi exiting, and no `python.exe` survives whose
parent is gone (`wmic process where "name='python.exe'" get ProcessId,ParentProcessId` is the check). A
surviving ipykernel is the failure this design exists to avoid: it keeps the COM apartment and the document
lock with nobody left to release them.

Also verify the graceful half before the violent half: on normal exit the bridge answers the `shutdown` op
and ipykernel exits on its own within the 2 s window (`kernel.ts:501`), so `taskkill` should not be needed.
If `taskkill` is doing all the work every time, the bridge is not reaching its kernel — capture bridge
stderr.

**Measured:** it is not. The graceful half did the whole job — four processes gone in 507 ms with no `taskkill`
invoked. `ready` came back as `{"type": "ready", "pid": 21004, "kernel_pid": 6292}` through a CRLF pipe, so the
`onData` split-and-trim is safe exactly as written. The machine-wide python count stayed at 6 throughout — the
developer's own interpreters — which is why every census here filters on `CommandLine` and never on image name.

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
| `for _ in range(200): time.sleep(0.05)` | cut fast, names intact | ~0.2 s | 488 ms latency, 788 ms elapsed, `KeyboardInterrupt`, names intact |
| `time.sleep(3)` | runs its 3 s, then dies | 3 s | 2.88 s latency, 3.18 s elapsed — it finishes the sleep, then dies |
| `time.sleep(10)` with grace 1.5 s | `aborted` + `KernelReaped`, next cell says `<pytool_kernel_reset>` | — | `KernelReaped` at 1.71 s, names gone, next cell `NameError`, reset notice present |
| a real hung COM call (`app.Rebuild()` on a wedged drawing) | never regains a boundary → reaped | — | not provoked on a wedged drawing; the measured analogue is one `ctypes` call that never returns — `KernelReaped` at 1.72 s |

Set the grace low for the last two: `set PYTOOL_ABORT_GRACE_MS=1500` before starting pi. Then confirm the
next cell carries the reset notice and a `NameError` for a name that existed before — the namespace is gone
and the model must be told.

Reproduce with `npm run measure:interrupts`, which prints the mechanism line and the four rows in one pass.
The mechanism on this box:
`{"jupyter_client": "8.10.0", "ipykernel": "7.4.0", "launcher": "Popen", "win32_interrupt_event": 708, "win_interrupt_module": true, "interrupt_mode": null}`.
The event handle is **present**, so the primary path in `bridge.py:_interrupt_windows` is live and bridge
stderr never showed `windows interrupt unavailable`. No `jupyter_client` pin was needed — §8 row 4 is moot on
8.10.0 / ipykernel 7.4.0.

## 7. COM smoke — the founding use case

Prerequisite: DraftSight running, and `draftsight_com` installed **into the kernel's own interpreter**. The
kernel exports that interpreter as `PI_PYTHON`, and that is the entire contract with the skill. Installing
somewhere else fails silently in the worst way: the install succeeds and the import still fails.

```powershell
/pytool                                  # the `python:` line is $env:PI_PYTHON's value
uv pip install --editable --python $env:PI_PYTHON D:\dev-pi\draftsight-com
```

The package does not live inside this repo — there is no `references\draftsight-com` here, and there never
was one. It has its own checkout, and on this box it is already installed editable as
`draftsight-com 0.5.0` (§11.4).

Then in one pi session:

Measured end to end with `npm run smoke:com` against DraftSight 26.4.0.5067.

1. `app = win32com.client.GetActiveObject('DraftSight.Application')` — cell 1. `Dispatch` is the wrong verb
   for this job: `GetActiveObject` attaches to the instance that is already running, which is the thing whose
   state has to survive.
2. `sh = ds.Sheet(app.GetActiveDocument(), app)` then `sh.line(...)`, `sh.circle(...)` — cell 2, using `app`
   from cell 1 with no reconnect and no re-dispatch. **This is the whole product, and it works.** The
   reference's `app.ActiveSheet()` / `sheet.Line()` / `app.Version` are not this build's COM surface: the real
   path is `GetActiveDocument()` → `GetModel()` → `GetSketchManager()`, and `GetVersion()`. `draftsight_com`
   wraps exactly that, so call the package instead of guessing property names.
3. `app.GetVersion()` in a later cell — a live proxy, not a stale reference.
4. Kill the kernel (a cell parked past the grace, §6), then reconnect in a new cell. Expect a fresh
   connection and a `KernelReaped`/reset notice in between, and expect DraftSight itself to survive and stay
   operable — no zombie lock, no "application is not responding".

Watch for the classic Windows traps while doing this: 32/64-bit mismatch between the interpreter and the
application, and `MakePath`-style typelib dispatch warm-up. If `Dispatch` works in `python` but not in
`pytool`, the ladder picked a different interpreter than the one the package went into — `/pytool` shows
which, and `PYTOOL_PYTHON` (or `PI_PYTHON`) pins it without probing.

**Measured:** inside a cell, `sys.executable` and `os.environ['PI_PYTHON']` name the same managed venv,
64-bit, and `draftsight_com.__file__` resolves to the editable install there — the contract holds, so the
wrong-interpreter failure the skill documents never had a chance to happen. After a `KernelReaped`, a fresh
`GetActiveObject` attached again, the document the dead kernel had been drawing into was **still open in
DraftSight**, and re-exporting it produced a PNG of the same 5326 bytes: the geometry lived in the app, not
in the kernel that died. DraftSight stayed up and operable, and the dead session's proxy is really gone
(`NameError`). Closing the document the kernel created requires activating another document first —
`ds.close_document` refuses to close the active one because that takes the COM server down.

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
4. §7 pass end to end against a live DraftSight, including the kill-and-reconnect. **Done.**
5. Update `README.md` Status: drop the "not yet run there" line, keep the Linux line, and note the Windows
   python/pi versions measured. Append the findings here so the next reader sees them in one place. **Done.**

## 11. Findings from the Windows run (2026-10-31: Windows 11, Python 3.14.4, bun 1.4.4)

1. **Quiet `taskkill` fallbacks have to be locale-independent.** The first cut of the retry treated "process
   not found" as benign by matching English stderr. This box answers in Korean, so every *healthy* graceful
   shutdown — where the chain is supposed to be gone already — printed a warning. `killProcessTree` now asks
   the OS whether the root pid still exists (`pidAlive`) rather than reading a localized sentence. Never match
   localized process-tool text.
2. **`powershell` on PATH here is 5.1, not 7.** `ConvertTo-Json -AsArray` does not exist, and `ConvertTo-Json`
   emits a bare object, not an array, when exactly one process matched. Both bit `measure-process-chain.ts`.
   Anything scripted against `powershell` has to assume 5.1.
3. **The teardown backstop must never fall through to `child.kill()`** (§8 row 1): a bridge-only kill orphans
   the ipykernel. It now retries `taskkill /T /F`, and warns only when the root pid is still alive.
   `test/pytool-units.test.ts` pins the cross-platform half of that — dead pid, no throw, no warning.
4. **`draftsight-com`'s pi extension resolves the wrong interpreter under pytool.** Its candidate list is
   hardcoded to `~/.pi/.venv` and `~/.pi/agent/pi-repl/venv`; the second still exists on this box and
   `~/.pi/agent/pytool/venv` is not in the list at all. Its pin list reads `process.env.PI_PYTHON`, but pytool
   exports `PI_PYTHON` into the *kernel's* environment, never into the pi process — measured unset there. So
   the bootstrap installs the package into a stale venv and reports `ready`. The package-only shape was
   measured working in §7: `uv pip install --python "$PI_PYTHON" --editable <repo>`, verified from inside a
   cell. **Done (2026-10-31):** `draftsight-com` is now a Python package plus a skill file. Its
   `extensions/index.ts`, `package.json`, `package-lock.json` and `tsconfig.json` are deleted (−2,032 lines,
   +153), the distribution is renamed `prime-agent-skill-draftsight-com` → `draftsight-com` (the prefix only
   existed to give the pi package a unique npm-style name), and `SKILL.md` is unchanged as a contract. pi's
   package entry was removed with `pi remove git:github.com/3DAlgoLab/draftsight-com`; the skill is discovered
   through a junction, `~/.pi/agent/skills/draftsight-com` → `D:\dev-pi\draftsight-com`, so `references/`
   still resolves by relative path and there is one copy to maintain. Re-pointed and verified from a real
   pytool cell: `draftsight_com.__version__` 0.5.0, `__file__` in the checkout, `sys.executable` ==
   `PI_PYTHON`, help tree resolved, `app.GetVersion()` → 26.4.0.5067, import fine again on a fresh kernel.
5. Two names in §7's procedure were wrong (`ActiveSheet`, `Line`, `Version`); corrected above against the
   live build. Use `app.GetVersion()`, not `VersionString` — the late-bound IDispatch surface has no
   `VersionString`, which one of my probe cells discovered the hard way.
6. Two `draftsight_com` behaviours worth knowing before running §7 again. `docs.decompile()` anchors its
   output tree to the **package** directory, not the working directory: an editable install unpacks the CHMs
   into your checkout, a wheel install into `site-packages`, so an import that silently resolves to the wrong
   install also silently writes its help tree somewhere else. And the help pages are UTF-8 while this console
   is cp949 — the `ds-docs` CLI reconfigures its own stdout, a script calling `docs.lookup()` directly has to
   do the same or it dies on the first non-breaking space.
7. **A missing package cost the agent four calls it should not have paid** (2026-10-31, measured while plotting
   GELU). The chain was: `ModuleNotFoundError: No module named 'matplotlib'` → a cell to print `sys.executable`
   → `python -m pip install` dying on `No module named pip`, because the managed venv is uv-built and was never
   seeded → `where uv` → only then the install that worked. Nothing in the traceback names the interpreter, and a
   venv without pip is invisible until it bites. Two changes follow.
   - `src/extension/import-hint.ts`: a failed import appends the kernel interpreter, the one install command that
     targets it, and the import-name → pip-name mapping (`PIL` → `pillow`, `yaml` → `pyyaml`, `sklearn` →
     `scikit-learn`, `win32com` → `pywin32`, ...). The installer is *probed*, not guessed: `uv --version` on the
     machine and `find_spec("pip")` on that interpreter, both process-cached and paid only after a cell already
     failed. Dotted names collapse to what is installable (`scipy.optimize` → `scipy`).
   - `scripts/setup-venv.mjs`: `uv venv --seed`, and `ensurePip` repairing an existing venv in place, so
     `"${PY}" -m pip install` works by reflex. Non-fatal — the evaluator does not need pip, and the hint prints
     the uv form when seeding fails. This box's venv is seeded: `find_spec("pip")` is now non-None.
   **A live probe of the new path caught a bug in the first cut**: `probeInstaller` built the command from an
   empty module list, so the hint printed `uv pip install --python "<py>"` and would have installed nothing —
   worse than silence, because it reads as an instruction. The module list is now part of that call, and a unit
   test pins the shape. Gates: 26 unit tests, integration 9, load 2 (real pi CLI boot), typecheck clean.
8. **A cell had no wall clock of its own, so a caller under a deadline it never named lost the cell, the
   kernel, and the evidence at once** (2026-10-31, DraftSight drawing session, v0.3.0). The cells were running
   inside a `fabric_exec` program whose own deadline was shorter than the COM loop. The program died, its
   `AbortSignal` fired, the abort did **not** stop the cell — it was parked inside a COM call — and the engine
   treated the abandoned cell as the caller's choice: the grace timer never armed, no `KernelReaped` was
   raised, and the kernel was left running a cell nobody was waiting for. Then the answer went missing: the cell
   had printed seven progress lines naming the exact call it hung on, and an aborted cell returned an empty
   result, so the one fact that would have changed the next attempt was discarded with it. `maxOutputChars`
   existed per call; nothing did for time, so the only deadline in the system belonged to a caller that had no
   idea it was aborting Python work.
   - `timeoutMs` per call, `PYTOOL_CELL_TIMEOUT_MS` for the session, default `0` (off). A caller already under a
     deadline names a number under it, and the cut then happens inside pytool instead of by abandonment.
   - One cut path (`cutCell`) for both reasons to cut — the caller aborting, and the cell passing its limit —
     both guarded by `hasActiveCell`, so nothing can queue an interrupt against an idle kernel.
   - New result surface: `status: "timeout"`, `timedOut`, and a `<pytool_cell_timeout>` notice that says in one
     line whether the names and the live handles survived, because "it stopped" alone invites the model to
     assume the writes landed and re-apply them. `reapedMessage` now also names which limit fired.
   - The cell output is mirrored as it streams, so a cell that dies mid-flight still returns what it printed.
   - Verified against the shape of the real failure: a yielding cell cut at 400 ms keeps its namespace (`keep`
     → `11` one cell later); a cell parked in C is reaped at its own limit with `before the hang` still in
     `stdout` and the next cell getting `<pytool_reset>`. Gates: 29 unit tests, integration 11, load 2,
     typecheck clean under both tsconfigs.
9. **Uncommitted work in this checkout can vanish under a sync.** Mid-session the tree was reset to
   `@{upstream}` (`git reflog`: `reset: moving to @{upstream}^{commit}`) and test additions that existed only in
   the working tree were gone — `grep -r` over the repo, the npm copy and `D:\dev-pi` found no copy. Treat a
   checkout a syncer may own as volatile: commit test work the moment it passes, and re-check a file against
   disk before quoting it — two edits in this session failed on anchors that a read from minutes earlier had
   shown, because the disk had moved.
10. **Cell source was decoded with the OS locale codec, not UTF-8** (`bridge.py` `use_utf8_stdio`, 0.4.0).
    The host writes protocol lines as UTF-8; text-mode `sys.stdin` inherited cp949 on this box, so every
    non-ASCII byte of a cell was redecoded before `json.loads`: `print("재질 20° Ø8")` arrived as `U+FFFD
    U+C631 U+F9DE U+FFFD` plus Hangul built from the UTF-8 bytes of `°` and `Ø`. Nothing on the output
    side was wrong (`json.dumps` escapes to ASCII), so the symptom — Korean text turning to junk in a
    generated CAD note — pointed at the font, not the pipe. Caught only because a `draftsight_com` note
    width measurement came out wrong: the string being measured was junk, and its bounding box was being
    divided by the wrong character count. Integration gate `non-ASCII cell source survives the protocol
    pipe` pins it now.`
