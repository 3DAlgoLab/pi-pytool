// Gate 2: a real ipykernel. Proves the one thing this tool exists for — state that survives — plus the
// interrupt/reap contract and the caps. Needs the evaluator venv (npm run setup-venv).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineManager } from "../src/engine/index.js";

let manager: EngineManager;
const leftovers: EngineManager[] = [];

function engine(options: ConstructorParameters<typeof EngineManager>[0] = {}): EngineManager {
	const e = new EngineManager(options);
	leftovers.push(e);
	return e;
}

beforeAll(async () => {
	manager = engine();
	await manager.start();
	expect(manager.isRunning).toBe(true);
});

afterAll(async () => {
	for (const e of leftovers) await e.dispose().catch(() => {});
});

describe("persistence", () => {
	test("a later cell sees an earlier cell's names", async () => {
		const a = await manager.execute("import time as _t\nv = {'score': 41}\n_data = [1, 2, 3]");
		expect(a.status).toBe("ok");
		const b = await manager.execute("print(_data[1], v['score'] + 1, _t.time() > 0)");
		expect(b.stdout.trim()).toBe("2 42 True");
		// the last expression's value comes back without a print
		const c = await manager.execute("sum(_data)");
		expect(c.result).toBe("6");
	});

	test("a raising cell keeps the kernel and its namespace", async () => {
		const bad = await manager.execute("v['missing']");
		expect(bad.status).toBe("error");
		expect(bad.error?.name).toBe("KeyError");
		const good = await manager.execute("v['score']");
		expect(good.result).toBe("41");
	});

	test("the live namespace is inspectable", async () => {
		const names = await manager.listNamespaceNames();
		expect(names).toContain("v");
		expect(names).not.toContain("_t"); // underscore names stay out of the roster
		expect(names).not.toContain("In");
	});

	test("an object handle stays live across cells", async () => {
		const opened = await manager.execute("import io\nbuf = io.StringIO()");
		expect(opened.status).toBe("ok");
		const written = await manager.execute("buf.write('kept'); buf.seek(0); buf.read()");
		expect(written.result).toBe("'kept'");
	});
});

describe("cells", () => {
	test("the output cap truncates with a marker that counts the loss", async () => {
		const r = await manager.execute("print('x' * 200000)", { maxOutputChars: 5000 });
		expect(r.stdout.length).toBeLessThan(5200);
		expect(r.stdout).toContain("output truncated at 5000 chars");
		expect(r.stdout).toContain("dropped");
	});

	test("cells submitted together run one at a time, in order", async () => {
		await manager.execute("order = []");
		const first = manager.execute("import time\norder.append('a'); time.sleep(0.3); order.append('a-done')");
		const second = manager.execute("order.append('b')");
		await Promise.all([first, second]);
		const r = await manager.execute("order");
		expect(r.result).toBe("['a', 'a-done', 'b']");
	});
});

describe("interrupts", () => {
	test("a yielding cell is cut and the kernel keeps its names", async () => {
		const e = engine();
		await e.execute("survivor = 7");
		const ac = new AbortController();
		const startedAt = Date.now();
		setTimeout(() => ac.abort(), 300);
		const r = await e.execute("import time\nfor _ in range(200): time.sleep(0.05)", { signal: ac.signal });
		const elapsed = Date.now() - startedAt;
		expect(r.status).toBe("aborted");
		expect(elapsed).toBeLessThan(3000);
		// the abort cost the cell, not the session
		const after = await e.execute("survivor");
		expect(after.result).toBe("7");
		await e.dispose();
	});

	test("a cell parked in one C call is reaped, and the next cell gets a fresh kernel", async () => {
		process.env.PYTOOL_ABORT_GRACE_MS = "1200";
		try {
			const e = engine();
			await e.execute("gone = 1");
			const ac = new AbortController();
			setTimeout(() => ac.abort(), 200);
			// The parked cell is platform-specific, and both halves of the choice are measured, not assumed
			// (bun scripts/measure-interrupts.ts). On POSIX a bare time.sleep IS cut by SIGINT, so the fixture
			// installs a handler that swallows the signal to stay parked. On Windows there is no signal to
			// swallow: the interrupt is a Win32 event that only sets a pending-signal flag, so a cell blocked
			// inside time.sleep never returns to a bytecode boundary and is already parked — a 1.5 s grace
			// reaps it (measured: KernelReaped at 1.9 s, next cell NameError). That is the same shape as a
			// hung COM/RPC, which is what the grace timer exists for.
			const parkedCell =
				process.platform === "win32"
					? "import time\ntime.sleep(10)"
					: "import signal\nsignal.signal(signal.SIGINT, lambda *a: None)\nimport time\ntime.sleep(10)";
			const r = await e.execute(parkedCell, { signal: ac.signal });
			expect(r.status).toBe("aborted");
			expect(r.error?.name).toBe("KernelReaped");
			expect(r.error?.message).toContain("COM");

			const next = await e.execute("gone");
			expect(next.kernelReset).toBeDefined();
			expect(next.status).toBe("error");
			expect(next.error?.name).toBe("NameError");
			await e.dispose();
		} finally {
			delete process.env.PYTOOL_ABORT_GRACE_MS;
		}
		// Windows needs a bigger budget than bun's 5 s default, and the reason is process count, not the
		// abort: this test boots a kernel, reaps it, then boots a second one, and a venv python.exe is a
		// launcher stub that re-execs, so every boot costs two processes (~2 s per boot measured here; it
		// fitted under 5 s on Linux). The reap itself lands ~1.4 s in at a 1.2 s grace — the whole 5 s was
		// spent waiting on the second boot.
	}, 20_000);

	// --- A cell the CALLER gave a wall clock to. This is the shape a nested caller (fabric_exec and
	// --- friends) is in: it lives under its own deadline, and without a cell budget of its own it abandons
	// --- the cell mid-flight, which reaps the kernel and hands back an empty result. Measured 2026-10-31
	// --- against live DraftSight COM: the abandoned call had printed seven progress lines naming the exact
	// --- stage it hung at, and every one of them was thrown away with it.
	test("a cell over its own limit is cut, keeps its names, and returns what it printed", async () => {
		const e = engine();
		await e.execute("keep = 11");
		const r = await e.execute("print('first', flush=True)\nimport time\nfor _ in range(400): time.sleep(0.05)", { timeoutMs: 400 });
		expect(r.status).toBe("timeout");
		expect(r.timedOut).toBe(true);
		expect(r.stdout).toContain("first");
		expect(r.cellTimeout).toContain("intact");
		expect(r.cellTimeout).toContain("timeoutMs");
		// the namespace really is alive — that is the whole promise of the notice
		const after = await e.execute("keep");
		expect(after.result).toBe("11");
		await e.dispose();
		// The cut lands on the deadline, not on a kernel boot: ~2 s of this budget is the boot itself.
	}, 25_000);

	test("a cell parked in C blows its own limit, reports the reap, and keeps its partial output", async () => {
		process.env.PYTOOL_ABORT_GRACE_MS = "1200";
		try {
			const e = engine();
			await e.execute("doomed = 1");
			// Same platform split as the abort test above: on Windows a cell blocked in a C call never reaches
			// a bytecode boundary, which is exactly the shape of a hung COM/RPC.
			const parkedCell =
				process.platform === "win32"
					? "print('before the hang', flush=True)\nimport time\ntime.sleep(10)"
					: "import signal\nsignal.signal(signal.SIGINT, lambda *a: None)\nprint('before the hang', flush=True)\nimport time\ntime.sleep(10)";
			const r = await e.execute(parkedCell, { timeoutMs: 300 });
			expect(r.status).toBe("timeout");
			expect(r.timedOut).toBe(true);
			expect(r.error?.name).toBe("KernelReaped");
			expect(r.error?.message).toContain("its own 0.3s limit");
			// --- the cut used to cost the answer: what the cell printed before hanging went away with it
			expect(r.stdout).toContain("before the hang");
			expect(r.cellTimeout).toContain("reaped");
			expect(r.cellTimeout).toContain("smaller cells");
			// and the cell after it is honest about the loss
			const next = await e.execute("doomed");
			expect(next.kernelReset).toBeDefined();
			expect(next.error?.name).toBe("NameError");
			await e.dispose();
		} finally {
			delete process.env.PYTOOL_ABORT_GRACE_MS;
		}
	}, 25_000);

	test("aborting during a cold boot is not lost", async () => {
		const e = engine();
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const startedAt = Date.now();
		const r = await e.execute("import time\nfor _ in range(200): time.sleep(0.05)", { signal: ac.signal });
		expect(Date.now() - startedAt).toBeLessThan(4000);
		expect(r.status).toBe("aborted");
		// the cell was withdrawn, so nothing ran: a later cell sees no trace of it
		await e.start();
		const later = await e.execute("1 + 1");
		expect(later.result).toBe("2");
		await e.dispose();
	});
});

describe("stdio encoding", () => {
	test("non-ASCII cell source survives the protocol pipe", async () => {
		// The host writes UTF-8; a bridge that decodes with the OS locale codec (cp949 on a Korean
		// Windows box) delivered replacement characters instead of the literal, so a model could not
		// put Hangul, CJK, a degree sign or an Ø into generated text. Output was never affected
		// because json.dumps escapes to ASCII, which made it look like a display bug.
		const r = await manager.execute('note = "재질 20° Ø8"\nprint(note, [hex(ord(c)) for c in note[:3]], flush=True)');
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("재질");
		expect(r.stdout).toContain("0xc7ac");
		expect(r.stdout).not.toContain("\uFFFD");
	});
});
