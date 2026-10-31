// Gate 1: no kernel, no network. The routing rules, the caps, and the interpreter ladder.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { capLinesForContext, DEFAULT_MAX_OUTPUT_CHARS, EngineManager, MAX_OUTPUT_LINE_CHARS, formatKernelResetNotice, truncateWithMarker } from "../src/engine/index.js";
import { killProcessTree, KernelClient } from "../src/engine/kernel.js";
import { managedVenvPython, pythonCandidates } from "../src/engine/python-locate.js";
import { formatDiagnostics } from "../src/extension/diagnostics.js";
import { composeErrorLines } from "../src/extension/error-format.js";

const FAKE_BRIDGE = join(import.meta.dir, "fixtures", "fake-bridge.py");

async function fakeKernel(): Promise<KernelClient> {
	return KernelClient.start([process.env.PYTHON ?? "python3"], { bridgePath: FAKE_BRIDGE });
}

describe("output caps", () => {
	test("truncateWithMarker names the loss", () => {
		const out = truncateWithMarker("abcdefghij", 4, true, 6);
		expect(out.startsWith("abcd")).toBe(true);
		expect(out).toContain("truncated at 4 chars");
		// dropped counts everything lost, including what an earlier frame already overflowed
		expect(out).toContain("12 dropped");
	});

	test("an uncapped channel is returned untouched", () => {
		expect(truncateWithMarker("short", 100, false, 0)).toBe("short");
	});

	test("capLinesForContext cuts a runaway line and flags it", () => {
		const r = capLinesForContext(`ok\n${"y".repeat(MAX_OUTPUT_LINE_CHARS + 50)}`);
		expect(r.trimmed).toBe(true);
		expect(r.text.split("\n")[1].length).toBe(MAX_OUTPUT_LINE_CHARS);
	});

	test("the session cap resolves with a floor, and per-call wins in the engine", () => {
		expect(new EngineManager({}).outputCharBudget).toBe(DEFAULT_MAX_OUTPUT_CHARS);
		expect(new EngineManager({ env: { PYTOOL_MAX_OUTPUT_CHARS: "1000" } }).outputCharBudget).toBe(1000);
		// junk and sub-512 values would produce output nobody can read
		expect(new EngineManager({ env: { PYTOOL_MAX_OUTPUT_CHARS: "64" } }).outputCharBudget).toBe(DEFAULT_MAX_OUTPUT_CHARS);
		expect(new EngineManager({ env: { PYTOOL_MAX_OUTPUT_CHARS: "nonsense" } }).outputCharBudget).toBe(DEFAULT_MAX_OUTPUT_CHARS);
	});
});

describe("interpreter ladder", () => {
	// Pins are filtered with existsSync against the *host* filesystem, so a test's pin has to be a file that
	// exists here. Hardcoding /bin/sh + /bin/bash made this pass on Linux and fail on Windows, where both are
	// skipped before ordering is ever decided -- the assertion then tested the filter, not the ranking.
	const pinA = process.execPath;
	const pinB = join(import.meta.dir, "..", "bridge.py");
	test("a pin outranks everything and is listed first", () => {
		const list = pythonCandidates({ PYTOOL_PYTHON: pinA, PI_PYTHON: pinB });
		expect(list[0].source).toBe("pin");
		expect(list[0].argv[0]).toBe(pinA);
		expect(list.map((c) => c.argv.join(" "))).toContain(pinB);
	});

	test("an absent absolute candidate is skipped without spawning it", () => {
		const list = pythonCandidates({ PYTOOL_PYTHON: "/nope/python" }, "linux");
		expect(list.some((c) => c.display.includes("/nope/python"))).toBe(false);
	});

	test("managed venv uses Scripts/python.exe on Windows and bin/python3 elsewhere", () => {
		expect(managedVenvPython("win32").endsWith(join("Scripts", "python.exe"))).toBe(true);
		expect(managedVenvPython("linux").endsWith(join("bin", "python3"))).toBe(true);
	});

	test("Windows adds the py -3 launcher, POSIX does not", () => {
		const win = pythonCandidates({}, "win32").map((c) => c.argv.join(" "));
		const posix = pythonCandidates({}, "linux").map((c) => c.argv.join(" "));
		expect(win).toContain("py -3");
		expect(posix).not.toContain("py -3");
	});
});

describe("bridge pipe routing (fake bridge)", () => {
	test("multi-frame streams accumulate in order and one result settles the cell", async () => {
		const kc = await fakeKernel();
		try {
			expect(kc.bridgePid).toBe(4242);
			expect(kc.kernelPid).toBe(4243);
			const r = await kc.executeCell("stream", { maxOutputChars: 1000 });
			expect(r.status).toBe("ok");
			expect(r.stdout).toBe("one\ntwo\n");
			expect(r.stderr).toBe("bad\n");
			expect(r.result).toBe("42");
		} finally {
			await kc.shutdown();
		}
	});

	test("the channel cap counts dropped characters, not just a flag", async () => {
		const kc = await fakeKernel();
		try {
			const r = await kc.executeCell("big", { maxOutputChars: 100 });
			expect(r.stdout.length).toBe(100);
			expect(r.truncated?.stdout).toBe(true);
			expect(r.truncated?.stdoutDropped).toBe(4900);
		} finally {
			await kc.shutdown();
		}
	});

	test("an error line carrying the exec id settles that cell", async () => {
		const kc = await fakeKernel();
		try {
			const r = await kc.executeCell("refused", { maxOutputChars: 1000 });
			expect(r.status).toBe("error");
			expect(r.error?.name).toBe("BridgeError");
			expect(r.error?.message).toBe("op refused");
			// the kernel is still up: a refused op must not end the session's Python
			const next = await kc.executeCell("stream", { maxOutputChars: 1000 });
			expect(next.stdout).toBe("one\ntwo\n");
		} finally {
			await kc.shutdown();
		}
	});

	test("a non-JSON line is dropped, not treated as a bridge event", async () => {
		const kc = await fakeKernel();
		try {
			const r = await kc.executeCell("noise", { maxOutputChars: 1000 });
			expect(r.result).toBe("survived");
		} finally {
			await kc.shutdown();
		}
	});

	test("bridge death settles the running cell instead of hanging it", async () => {
		const kc = await fakeKernel();
		let rejected: Error | undefined;
		try {
			await kc.executeCell("die", { maxOutputChars: 1000 }).catch((e: Error) => {
				rejected = e;
			});
		} finally {
			await kc.shutdown();
		}
		expect(rejected?.message).toContain("kernel process exited");
		expect(kc.isRunning).toBe(false);
	});

	test("listNames rides the same pipe", async () => {
		const kc = await fakeKernel();
		try {
			expect(await kc.listNames()).toEqual(["df", "app"]);
		} finally {
			await kc.shutdown();
		}
	});
});

describe("process teardown", () => {
	// Windows measures this for real (scripts/measure-process-chain.ts); here it is the contract that the
	// backstop stays silent and never throws on a chain that is already gone -- the common case, because
	// shutdown() asks the bridge to stop first. A noisy warning here would train the reader to ignore the
	// one that means an ipykernel was orphaned.
	test("killing an already-dead pid neither throws nor warns", () => {
		const warned: string[] = [];
		const real = console.error;
		console.error = (...args: unknown[]) => warned.push(args.join(" "));
		try {
			killProcessTree(0x7ffffffe);
		} finally {
			console.error = real;
		}
		expect(warned.join("")).toBe("");
	});
});

describe("model-facing text", () => {
	test("a traceback is ANSI-free and keeps its frames", () => {
		const lines = composeErrorLines({
			name: "NameError",
			message: "name '\u001b[31mapp\u001b[0m' is not defined",
			stack: ["\u001b[0;31m---------------------------------------------------------------------------\u001b[0m", "  \u001b[32m1\u001b[0m app.foo()", "   "],
		});
		expect(lines[0]).toBe("NameError: name 'app' is not defined");
		expect(lines[1]).toContain("---");
		expect(lines.some((l) => l.includes("\u001b"))).toBe(false);
		expect(lines.length).toBe(3);
	});

	test("the reset notice says what died and that nothing is restored", () => {
		const notice = formatKernelResetNotice();
		expect(notice).toContain("<pytool_kernel_reset>");
		expect(notice).toContain("COM proxy");
		expect(notice).toContain("cannot be serialized");
	});

	test("/pytool reports the kernel without touching it", () => {
		const text = formatDiagnostics({
			enginePresent: true,
			kernelState: "running",
			pid: 100,
			bridgePid: 100,
			kernelPid: 101,
			interpreter: "/venv/bin/python3",
			interpreterSource: "managed-venv",
			maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
			namespaceNames: ["app", "df"],
		});
		expect(text).toContain("kernel: running bridge 100 · ipykernel 101");
		expect(text).toContain("python: /venv/bin/python3 (managed-venv)");
		expect(text).toContain("2 names: app, df");
		expect(text).toContain("no snapshots");
		// Windows-style tree: a launcher distinct from the bridge names the one kill that clears the chain
		const win = formatDiagnostics({ enginePresent: true, pid: 100, bridgePid: 101, maxOutputChars: 1, namespaceNames: [] });
		expect(win).toContain("taskkill /PID 100 /T /F");
	});
});
