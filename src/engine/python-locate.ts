// --- one interpreter answer for the whole extension: pin > managed venv > PATH.
// --- Windows venvs keep their interpreter in Scripts/, POSIX in bin/; the two must be resolved by the
// --- same rules here and in scripts/setup-venv.mjs, or the venv that gets built is not the one that runs.
// --- Every non-pin candidate must pass an importlib.util.find_spec probe, so a machine whose PATH python
// --- cannot host the bridge is skipped instead of booted and watched fail.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Modules bridge.py imports at boot. A candidate missing one is unusable however healthy its binary looks. */
export const RUNTIME_DEPS = ["ipykernel", "jupyter_client"];

export type PythonSource = "pin" | "python-env" | "managed-venv" | "path";

export interface PythonCandidate {
	/** argv[0] is the executable; the rest is a prefix (e.g. `py` + `-3` on Windows). */
	argv: string[];
	source: PythonSource;
	display: string;
}

export interface ProbeResult {
	ok: boolean;
	/** Absolute interpreter path reported by the candidate itself (`sys.executable`). */
	executable?: string;
	/** RUNTIME_DEPS the candidate cannot import. */
	missing: string[];
	reason?: string;
}

export interface PythonResolution extends ProbeResult {
	argv: string[];
	source: PythonSource;
	/** Why each rejected candidate was rejected — surfaced in the boot error, never swallowed. */
	tried: { display: string; source: PythonSource; reason: string }[];
}

interface ResolveOptions {
	env?: NodeJS.ProcessEnv;
	/** Probe deadline per candidate; a hung interpreter must not hang the boot. */
	timeoutMs?: number;
	/** Tests re-probe deliberately; production caches because doStart can run more than once per session. */
	useCache?: boolean;
}

/** Interpreter inside a venv, by platform. uv-created venvs have no pip of their own but the same layout. */
export function venvPython(venv: string, platform: NodeJS.Platform = process.platform): string {
	return join(venv, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python3");
}

export function managedVenvDir(): string {
	return join(homedir(), ".pi", "agent", "pytool", "venv");
}

export function managedVenvPython(platform: NodeJS.Platform = process.platform): string {
	return venvPython(managedVenvDir(), platform);
}

/**
 * Candidates in preference order. `PI_PYTHON` is the shared pin contract with sibling skills (the
 * draftsight-com skill installs its package into $PI_PYTHON), so "the interpreter the agent runs" has
 * exactly one answer on a machine. PYTOOL_PYTHON pins for this tool alone.
 *
 * No project `.venv` candidate: the py tool is one tool among others, so a repository's own venv is not
 * the agent's Python. A project that needs its own interpreter sets PYTOOL_PYTHON -- the pin is probed
 * too, and a wrong pin says so out loud instead of silently working somewhere else.
 */
export function pythonCandidates(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): PythonCandidate[] {
	const raw: { argv: string[]; source: PythonSource }[] = [];
	for (const name of ["PYTOOL_PYTHON", "PI_PYTHON"]) {
		const pinned = env[name];
		if (pinned) raw.push({ argv: [pinned], source: "pin" });
	}
	if (env.PYTHON) raw.push({ argv: [env.PYTHON], source: "python-env" });
	raw.push({ argv: [managedVenvPython(platform)], source: "managed-venv" });
	raw.push({ argv: ["python3"], source: "path" });
	raw.push({ argv: ["python"], source: "path" });
	// the Windows launcher is the only way to reach a real 3.x when python/python3 are the Store stub
	if (platform === "win32") raw.push({ argv: ["py", "-3"], source: "path" });

	const out: PythonCandidate[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const display = entry.argv.join(" ");
		if (seen.has(display)) continue;
		// an absolute candidate that is simply not there is skipped without spawning anything
		if (entry.argv[0].includes("/") || entry.argv[0].includes("\\")) {
			if (!existsSync(entry.argv[0])) continue;
		}
		seen.add(display);
		out.push({ ...entry, display });
	}
	return out;
}

const PROBE_SOURCE = [
	"import importlib.util as u, sys",
	"print('EXE ' + sys.executable)",
	`print('DEPS ' + ','.join(n for n in ${JSON.stringify(RUNTIME_DEPS)} if u.find_spec(n) is not None))`,
].join("; ");

const probeCache = new Map<string, ProbeResult>();

/**
 * Ask the interpreter what it can host. `find_spec` never executes the package's code, so probing an
 * environment we do not own is safe.
 */
export function probePython(candidate: PythonCandidate, timeoutMs = 20_000, useCache = true): ProbeResult {
	if (useCache) {
		const hit = probeCache.get(candidate.display);
		if (hit) return hit;
	}
	const result = runProbe(candidate, timeoutMs);
	// --- only successes are cached: a failed probe must be re-askable, because building the managed
	// --- venv (scripts/setup-venv.mjs) is exactly the fix a running session expects to take effect ---
	if (useCache && result.ok) probeCache.set(candidate.display, result);
	return result;
}

function runProbe(candidate: PythonCandidate, timeoutMs: number): ProbeResult {
	let stdout = "";
	let error: string | undefined;
	try {
		const r = spawnSync(candidate.argv[0], [...candidate.argv.slice(1), "-c", PROBE_SOURCE], {
			timeout: timeoutMs,
			encoding: "utf8",
			windowsHide: true,
		});
		stdout = r.stdout ?? "";
		if (r.error)
			error =
				(r.error as NodeJS.ErrnoException).code === "ENOENT"
					? "executable not found"
					: String(r.error.message ?? r.error);
			else if (r.signal) error = `probe killed by ${r.signal} (a hung interpreter)`;
			else if (r.status !== 0) error = `exit ${r.status}`;
	} catch (e) {
		error = String((e as Error)?.message ?? e);
	}

	const executable = /^EXE (.+)$/m.exec(stdout)?.[1]?.trim();
	const depsLine = /^DEPS (.*)$/m.exec(stdout)?.[1]?.trim() ?? "";
	const present = depsLine ? depsLine.split(",").filter(Boolean) : [];
	const missing = RUNTIME_DEPS.filter((dep) => !present.includes(dep));

	let reason: string | undefined;
	if (error) reason = error;
	else if (missing.length > 0) reason = `missing ${missing.join(", ")}`;

	return { ok: !error && missing.length === 0, executable, missing, reason };
}

/**
 * First candidate that can host the bridge. A pin is honoured even when the probe fails -- the caller
 * named that interpreter, and a fallback that already holds the deps would hide the kernel that does not.
 */
export function resolvePython(options: ResolveOptions = {}): PythonResolution {
	const env = options.env ?? process.env;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const useCache = options.useCache ?? true;
	const tried: PythonResolution["tried"] = [];

	for (const candidate of pythonCandidates(env, process.platform)) {
		const probe = probePython(candidate, timeoutMs, useCache);
		if (candidate.source === "pin") {
			if (!probe.ok)
				tried.push({ display: candidate.display, source: candidate.source, reason: probe.reason ?? "unusable" });
			return { ...probe, argv: candidate.argv, source: candidate.source, tried };
		}
		if (probe.ok) return { ...probe, argv: candidate.argv, source: candidate.source, tried };
		tried.push({ display: candidate.display, source: candidate.source, reason: probe.reason ?? "unusable" });
	}

	return {
		ok: false,
		argv: [],
		source: "path",
		executable: undefined,
		missing: [...RUNTIME_DEPS],
		reason: "no usable Python found",
		tried,
	};
}

/** Boot-failure text: which interpreters were considered and why each one lost. */
export function formatPythonFailure(resolution: PythonResolution): string {
	const lines = ["no usable Python for the pytool evaluator."];
	if (resolution.tried.length > 0) {
		lines.push("tried:");
		for (const t of resolution.tried) lines.push(`  - ${t.display} [${t.source}]: ${t.reason}`);
	} else {
		lines.push("  no candidate interpreter exists on this machine");
	}
	lines.push(`fix: node scripts/setup-venv.mjs  (builds ${managedVenvDir()})`);
	return lines.join("\n");
}
