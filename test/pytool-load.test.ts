// Gate 3: does pi 1.4.0 take this package, and does it leave the other tools alone?
// Half runs the extension in-process through the SDK with a throwaway agentDir, so the developer's real
// settings are untouched and no model call is made. Half drives pi's own CLI, which is the startup path real
// sessions take and the only one that emits session_start. The process counts are the Windows leak rule
// checked on POSIX.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const ROOT = join(import.meta.dir, "..");
const EXTENSION = join(ROOT, "index.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pythonishCount(): number {
	// the bridge, ipykernel, and whatever else this tool spawns
	const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
	return out.split("\n").filter((l) => l.includes("bridge.py") || l.includes("ipykernel")).length;
}

describe("loaded in-process", () => {
	let dir: string;
	let toolNames: string[] = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pytool-load-"));
		// an isolated agentDir: the package under test is the only extension declared
		await writeFile(join(dir, "settings.json"), JSON.stringify({ extensions: [EXTENSION] }));
		const { session } = await createAgentSession({
			cwd: ROOT,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(),
		});
		toolNames = session.getActiveToolNames();
		await session.dispose();
	});

	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("pytool is registered beside the built-in tools", () => {
		expect(toolNames).toContain("pytool");
		// the fork's whole point: pi-repl-py calls setActiveTools(["execute"]) at session_start; this package
		// calls setActiveTools nowhere, so the built-in surface has to come back untouched
		for (const name of ["read", "bash", "edit", "write"]) expect(toolNames).toContain(name);
	});

	// no warm-boot assertion here on purpose: createAgentSession() never calls bindExtensions(), so the SDK
	// path does not emit session_start. The CLI describe below covers the path real sessions take.
});

describe("loaded by the pi CLI", () => {
	test("session_start warms the kernel and shutdown takes the whole tree with it", async () => {
		const baseline = pythonishCount();
		const child = Bun.spawn(
			[
				"pi",
				"--mode", "rpc",
				"--no-session",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-mcp",
				// discovery off, explicit path on: without this every package the developer has installed loads
				// into the probe, and one of them commits and pushes the working tree it was started in
				"--no-extensions",
				"-e", EXTENSION,
			],
			{ cwd: ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		let out = "";
		let err = "";
		void (async () => {
			for await (const c of child.stdout) out += new TextDecoder().decode(c);
		})();
		void (async () => {
			for await (const c of child.stderr) err += new TextDecoder().decode(c);
		})();

		child.stdin.write(JSON.stringify({ id: "c1", type: "get_commands" }) + "\n");
		// the warm-up boot kicked off at session_start needs room to land
		await sleep(6000);
		expect(out).toContain('"pytool"');
		expect(err).not.toMatch(/extension (load )?error/i);
		expect(pythonishCount()).toBeGreaterThan(baseline);

		child.stdin.end();
		const exited = await Promise.race([child.exited, sleep(8000)]);
		if (typeof exited === "number") child.kill();
		await sleep(1500);
		expect(pythonishCount()).toBeLessThanOrEqual(baseline);
	}, 40000);
});
