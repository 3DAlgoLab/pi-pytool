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
			// On POSIX a bare time.sleep IS cut by SIGINT, so it cannot exercise the grace. This cell installs
			// a handler that swallows the signal and keeps parked: the deterministic stand-in for a call stuck
			// inside C (a hung COM/RPC), which is exactly what the grace timer exists for.
			const r = await e.execute(
				"import signal\nsignal.signal(signal.SIGINT, lambda *a: None)\nimport time\ntime.sleep(10)",
				{ signal: ac.signal },
			);
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
	});

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
