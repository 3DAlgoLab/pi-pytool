// HANDOFF §5 harness: the four-process chain and the leak measurement, on Windows.
//
// A live session is launcher (the pid we spawned) -> bridge (the pid "ready" reports) -> ipykernel
// launcher -> the interpreter that runs cells and holds live handles. Neither claim is visible from the TS
// host, so this drives bridge.py directly and reads the OS process table:
//
//   1. graceful first: the bridge answers the shutdown op and ipykernel exits on its own, so taskkill is a
//      backstop that should never have to do the work. If taskkill is what kills the chain every time, the
//      bridge is not reaching its kernel.
//   2. violent second: killProcessTree from the launcher root must clear all four and leave nothing whose
//      parent is gone. A surviving ipykernel keeps the COM apartment and the document lock.
//
// Run with: bun scripts/measure-process-chain.ts

import { execFileSync, spawn } from "node:child_process";
import { killProcessTree } from "../src/engine/kernel.js";
import { resolvePython } from "../src/engine/python-locate.js";

const BRIDGE = new URL("../bridge.py", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Proc {
	pid: number;
	ppid: number;
	cmdline: string;
}

/** The OS process table, python only. Windows has no ps; CIM carries CommandLine, which is what names a role. */
function pyProcs(): Proc[] {
	if (process.platform === "win32") {
		const query =
			"@(Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" | " +
			"ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmdline = $_.CommandLine } }) | " +
			// no -AsArray: that parameter is PowerShell 7+, and the shell on PATH here is Windows PowerShell 5.1
			"ConvertTo-Json -Compress";
		const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", query], {
			encoding: "utf8",
			windowsHide: true,
		});
		// ConvertTo-Json emits a bare object, not an array, when exactly one process matched.
		const parsed = JSON.parse(out.trim() || "[]") as Proc | Proc[];
		return Array.isArray(parsed) ? parsed : [parsed];
	}
	const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
	return out
		.split("\n")
		.map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
		.filter((m): m is RegExpExecArray => m !== null && /python|ipykernel/.test(m[3]))
		.map((m) => ({ pid: +m[1], ppid: +m[2], cmdline: m[3] }));
}

/** Only this tool's tree counts: the bridge and the ipykernel it spawns, matched on the command line. */
function ours(ps: Proc[]): Proc[] {
	return ps.filter((p) => /bridge\.py|ipykernel/i.test(p.cmdline));
}

function role(p: Proc): string {
	if (/bridge\.py/i.test(p.cmdline)) return "bridge";
	if (/ipykernel_launcher/i.test(p.cmdline)) return "ipykernel";
	return "launcher";
}

/**
 * Print this tool's tree, linked by parent pid rather than as a flat count.
 *
 * A venv python.exe is a launcher stub that re-execs, so a role and its interpreter share one command
 * line and a count cannot tell them apart; the ppid links can, and they are what prove the chain HANDOFF
 * §5 describes.
 */
function census(tag: string): Proc[] {
	const rows = ours(pyProcs());
	const byPid = new Map(rows.map((p) => [p.pid, p]));
	const roots = rows.filter((p) => !byPid.has(p.ppid));
	console.log(`  [${tag}] ${rows.length} processes in this tree:`);
	const walk = (p: Proc, depth: number) => {
		const args = p.cmdline.trim().split(/\s+/).slice(1).join(" ");
		console.log(`${"  ".repeat(depth + 2)}${role(p)} pid=${p.pid}${args ? ` args=${args.slice(0, 60)}` : ""}`);
		for (const child of rows) if (child.ppid === p.pid) walk(child, depth + 1);
	};
	for (const root of roots) walk(root, 0);
	if (rows.length > 0 && roots.length === 0) console.log("     (no root: the tree is already detached)");
	return rows;
}

async function waitForGone(pids: number[], deadlineMs: number): Promise<number> {
	const startedAt = Date.now();
	for (;;) {
		const live = new Set(pyProcs().map((p) => p.pid));
		const alive = pids.filter((pid) => live.has(pid));
		if (alive.length === 0) return Date.now() - startedAt;
		if (Date.now() - startedAt >= deadlineMs) return -1;
		await sleep(100);
	}
}

interface BridgeHandle {
	child: ReturnType<typeof spawn>;
	state: { bridgePid?: number; kernelPid?: number; stderr: string; readyLine: string };
}

/** Spawn bridge.py the way KernelClient does, keeping the state mutable so the caller can poll it. */
function boot(): BridgeHandle {
	const resolved = resolvePython();
	if (!resolved.ok) throw new Error(`no usable python: ${resolved.reason} ${JSON.stringify(resolved.tried)}`);
	const child = spawn(resolved.argv[0], [...resolved.argv.slice(1), BRIDGE], {
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const state: BridgeHandle["state"] = { stderr: "", readyLine: "" };
	child.stderr?.on("data", (b: Buffer) => (state.stderr += b.toString()));
	// Mirror KernelClient.onData: split on \n then trim, which is what makes a CRLF line parse on Windows.
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				const msg = JSON.parse(line) as { type?: string; pid?: number; kernel_pid?: number };
				if (msg.type === "ready") {
					state.bridgePid = msg.pid;
					state.kernelPid = msg.kernel_pid;
					state.readyLine = line;
				}
			}
			idx = buffer.indexOf("\n");
		}
	});
	child.stdin?.write(`${JSON.stringify({ op: "boot" })}\n`);
	return { child, state };
}

async function waitReady(h: BridgeHandle, ms = 60_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < ms) {
		if (h.state.bridgePid !== undefined && h.state.kernelPid !== undefined) return;
		await sleep(100);
	}
	throw new Error(`bridge never reported ready; stderr: ${h.state.stderr.slice(-500)}`);
}

console.log(`platform: ${process.platform} ${process.arch}`);
console.log(`baseline: ${census("baseline").length} processes in this tree (expect 0)`);

// ---- 1. the chain while a cell is live ----
const first = boot();
await waitReady(first);
console.log(
	`\nreported roles: launcher pid=${first.child.pid} -> bridge pid=${first.state.bridgePid} -> ipykernel pid=${first.state.kernelPid}`,
);
console.log(`ready line as parsed: ${first.state.readyLine}`);
await sleep(300);
const live = census("live");

first.child.stdin?.write(`${JSON.stringify({ op: "exec", id: "c1", code: "x = 41 + 1\nx" })}\n`);
await sleep(1500);

// ---- 2. graceful first: does the bridge reach its kernel, or is taskkill doing the work? ----
const chainPids = live.map((p) => p.pid);
first.child.stdin?.end(JSON.stringify({ op: "shutdown", id: "s1" }) + "\n");
const gracefulMs = await waitForGone(chainPids, 5000);
console.log(
	gracefulMs >= 0
		? `graceful: all ${chainPids.length} processes gone ${gracefulMs} ms after the shutdown op, before any taskkill ran`
		: `graceful: INCOMPLETE -- survivors after 5 s: ${chainPids.filter((pid) => pyProcs().some((p) => p.pid === pid)).join(", ")}`,
);
if (first.state.stderr.trim()) console.log(`  bridge stderr (the ipykernel TCP notice is expected): ${first.state.stderr.trim().slice(0, 160)}`);

// the backstop still runs on an already-dead chain: this is the "process not found" path, which must stay quiet
killProcessTree(first.child.pid ?? -1);

// ---- 3. violent: the tree kill alone, from the launcher root, must clear every role ----
const second = boot();
await waitReady(second);
const secondPids = census("second session").map((p) => p.pid);
second.child.stdin?.write(`${JSON.stringify({ op: "exec", id: "c2", code: "handle = object()" })}\n`);
await sleep(1500);
killProcessTree(second.child.pid as number);
const violentMs = await waitForGone(secondPids, 5000);
console.log(
	violentMs >= 0
		? `tree kill: all ${secondPids.length} processes gone ${violentMs} ms after taskkill /PID ${second.child.pid} /T /F`
		: `tree kill: LEAK -- survivors: ${secondPids.filter((pid) => pyProcs().some((p) => p.pid === pid)).join(", ")}`,
);

// ---- 4. orphans: a python whose parent died is the failure this design exists to avoid ----
await sleep(1000);
const all = pyProcs();
let orphans: Proc[] = [];
try {
	const pids = new Set<number>();
	const raw =
		process.platform === "win32"
			? execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" })
					.split("\n")
					.map((l) => Number(/,(\d+)"\s*$/.exec(l.trim())?.[1]))
			: execFileSync("ps", ["-eo", "pid="], { encoding: "utf8" }).split("\n").map((l) => Number(l.trim()));
	for (const n of raw) if (Number.isFinite(n)) pids.add(n);
	orphans = ours(all).filter((p) => p.ppid > 0 && !pids.has(p.ppid));
} catch {
	console.log("orphan check: skipped (could not list all pids)");
}
console.log(
	`orphans: ${orphans.length} python whose parent process is gone${orphans.length ? ` -> ${orphans.map((p) => p.pid).join(", ")}` : ""}`,
);
console.log(`total python on the machine now: ${all.length} (the developer's own interpreters are why the gates filter on CommandLine, not image name)`);
