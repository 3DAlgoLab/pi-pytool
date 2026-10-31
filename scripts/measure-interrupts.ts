// HANDOFF §6 harness: measure what an abort actually costs on this machine, instead of trusting the
// reference numbers. Each case prints one line: the cell, the status, the elapsed time, and whether the
// namespace survived. Run with: bun scripts/measure-interrupts.ts
//
// Mechanism first: on Windows the interrupt is a Win32 event handle jupyter_client hands the kernel
// (JPY_INTERRUPT_EVENT). If that handle is missing, bridge.py falls back to the control-channel request,
// ipykernel logs "Interrupt message not supported on Windows", and every abort below is really a kill.

import { spawnSync } from "node:child_process";
import { EngineManager } from "../src/engine/index.js";
import { resolvePython } from "../src/engine/python-locate.js";

const PROBE = [
	"import importlib.util as u, json, sys",
	"import jupyter_client, ipykernel",
	"from jupyter_client import KernelManager",
	"info = {'jupyter_client': jupyter_client.__version__, 'ipykernel': getattr(ipykernel, '__version__', '?')}",
	"km = KernelManager(kernel_name='python3'); km.start_kernel()",
	"proc = getattr(getattr(km, 'provisioner', None), 'process', None)",
	"info['launcher'] = type(proc).__name__ if proc else None",
	"info['win32_interrupt_event'] = getattr(proc, 'win32_interrupt_event', None) if proc else None",
	"info['win_interrupt_module'] = u.find_spec('jupyter_client.win_interrupt') is not None",
	"info['interrupt_mode'] = getattr(km, 'interrupt_mode', None)",
	"print('PROBE ' + json.dumps(info, default=str))",
	"sys.stdout.flush()",
	"km.shutdown_kernel(now=True)",
].join("\n");

const resolved = resolvePython();
if (!resolved.ok) {
	console.log("no usable python:", resolved.reason, resolved.tried);
	process.exit(1);
}

const probe = spawnSync(resolved.argv[0], [...resolved.argv.slice(1), "-c", "import sys\n" + PROBE], {
	encoding: "utf8",
	windowsHide: true,
	timeout: 90_000,
});
const line = (probe.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE "));
console.log("mechanism:", line ? line.slice(6) : `probe failed: ${(probe.stderr ?? "").slice(-400)}`);

async function timedCell(label: string, cell: string, abortAfterMs: number, graceMs: number) {
	process.env.PYTOOL_ABORT_GRACE_MS = String(graceMs);
	const e = new EngineManager({ cwd: process.cwd() });
	let elapsed = 0;
	/** Latency from the abort signal to the cell settling. The reference table is in these units, so
	 *  elapsed_ms alone (measured from cell start) is not comparable with it. */
	let latency = 0;
	let status = "";
	let errorName = "";
	let resetOnNext = false;
	let nameAfter = "";
	try {
		await e.execute("survivor = 7");
		const startedAt = Date.now();
		const ac = new AbortController();
		let signaledAt = 0;
		setTimeout(() => {
			signaledAt = Date.now();
			ac.abort();
		}, abortAfterMs);
		const r = await e.execute(cell, { signal: ac.signal });
		elapsed = Date.now() - startedAt;
		latency = signaledAt ? Date.now() - signaledAt : -1;
		status = r.status;
		errorName = r.error?.name ?? "";
		const next = await e.execute("survivor");
		resetOnNext = next.kernelReset !== undefined;
		nameAfter = next.error?.name ?? `ok ${next.result}`;
	} finally {
		await e.dispose().catch(() => {});
		delete process.env.PYTOOL_ABORT_GRACE_MS;
	}
	console.log(
		`${label}: status=${status} error=${errorName || "-"} latency_ms=${latency} elapsed_ms=${elapsed} names_intact=${!resetOnNext} next=${nameAfter}`,
	);
}

await timedCell("busy_loop_0.05s", "import time\nfor _ in range(200): time.sleep(0.05)", 300, 5000);
await timedCell("sleep_3s", "import time\ntime.sleep(3)", 300, 5000);
await timedCell("sleep_10s_park", "import time\ntime.sleep(10)", 200, 1500);
await timedCell("ctypes_sleep_10s_park", "import ctypes\nctypes.windll.kernel32.Sleep(10000)", 200, 1500);
console.log("interpreter:", resolved.executable ?? resolved.argv.join(" "), `(${resolved.source})`);
