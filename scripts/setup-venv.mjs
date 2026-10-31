#!/usr/bin/env node
/**
 * postinstall: build (or repair in place) the managed venv at ~/.pi/agent/pytool/venv.
 *
 * The interpreter lives in Scripts/ on Windows and bin/ elsewhere -- the same rule the runtime applies
 * in src/engine/python-locate.ts. Keep the two in step: a venv built with one layout and resolved with
 * the other is a dead evaluator hiding behind a healthy-looking install log.
 *
 * Everything runs through spawn, never a shell, so a profile path containing spaces cannot break the
 * install. A uv-created venv has no pip of its own, so installs go through uv whenever uv is present.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WIN = process.platform === "win32";
const VENV_DIR = join(homedir(), ".pi", "agent", "pytool", "venv");
const PY = join(VENV_DIR, WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python3");
// What bridge.py needs in order to boot -- probed as importable *module* names, never pip names.
const CORE_MODULES = ["ipykernel", "jupyter_client"];
// [pip name, import name]: pywin32 installs win32com/win32api/pythoncom and there is no "pywin32"
// module, so probing the pip name would call a healthy install broken. It is the whole point of this
// tool on Windows (COM: DraftSight, Excel, serial ports); its absence is a warning, not a dead install.
const EXTRA_PACKAGES = WIN ? [["pywin32", "win32com"]] : [];
const INSTALL_PACKAGES = [...CORE_MODULES, ...EXTRA_PACKAGES.map(([pip]) => pip)];

function log(m) {
	process.stdout.write(`[pytool] ${m}\n`);
}
function warn(m) {
	process.stderr.write(`[pytool] warning: ${m}\n`);
}
function fail(m) {
	process.stderr.write(`[pytool] ERROR: ${m}\n`);
	process.exit(1);
}

/** Run one program with argv, never through a shell. */
function run(program, args, { inherit = true, timeoutMs = 900_000 } = {}) {
	const r = spawnSync(program, args, {
		stdio: inherit ? "inherit" : "ignore",
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true,
	});
	if (r.error) throw new Error(`${program} failed to start: ${r.error.message}`);
	return r;
}

/**
 * Ask an interpreter which runtime deps it can host. find_spec never executes package code, so probing
 * an environment we do not own is safe.
 */
function missingModules(python, modules, prefixArgs = []) {
	const probe = [
		"import importlib.util as u",
		`print('DEPS ' + ','.join(n for n in ${JSON.stringify(modules)} if u.find_spec(n) is not None))`,
	].join("; ");
	const r = spawnSync(python, [...prefixArgs, "-c", probe], { encoding: "utf8", timeout: 60_000, windowsHide: true });
	const line = /^DEPS (.*)$/m.exec(`${r.stdout ?? ""}`)?.[1]?.trim() ?? "";
	const present = line ? line.split(",").filter(Boolean) : [];
	return modules.filter((d) => !present.includes(d));
}

function hasUv() {
	try {
		return run("uv", ["--version"], { inherit: false }).status === 0;
	} catch {
		return false;
	}
}

/** Interpreters that could host a venv build, most likely first. */
function systemPythons() {
	const candidates = WIN
		? [["python", []], ["python3", []], ["py", ["-3"]]]
		: [["python3", []], ["python", []]];
	for (const [program, prefix] of candidates) {
		try {
			if (run(program, [...prefix, "--version"], { inherit: false }).status === 0) return [program, prefix];
		} catch {}
	}
	return null;
}

/** An optional package that failed to land is worth reporting, but must not fail the whole install. */
function reportExtras() {
	const missing = missingModules(PY, EXTRA_PACKAGES.map(([, imported]) => imported));
	if (missing.length === 0) return;
	const names = EXTRA_PACKAGES.filter(([, imported]) => missing.includes(imported)).map(([pip]) => pip);
	warn(`installed but not importable: ${names.join(", ")} — COM work will not load.`);
}

function installDeps(uv) {
	if (uv) {
		run("uv", ["pip", "install", "--python", PY, ...INSTALL_PACKAGES]);
		return;
	}
	run(PY, ["-m", "pip", "install", "--upgrade", "pip"]);
	run(PY, ["-m", "pip", "install", ...INSTALL_PACKAGES]);
}

/** Create the venv; uv owns most agent venvs and creates them without pip. */
function createVenv(system, prefix, uv) {
	mkdirSync(join(VENV_DIR, ".."), { recursive: true });
	if (uv) {
		run("uv", ["venv", "--python", system, ...prefix, VENV_DIR]);
		return;
	}
	// --clear: a half-built venv must not leak into a "working" one
	run(system, [...prefix, "-m", "venv", "--clear", VENV_DIR]);
}

function main() {
	if (process.env.PYTOOL_SKIP_VENV === "1") {
		warn("PYTOOL_SKIP_VENV=1: the evaluator venv was not built; pytool() fails until one exists.");
		return;
	}

	// an existing venv that can host every dep is the common case — never touch it
	const missing = existsSync(PY) ? missingModules(PY, CORE_MODULES) : null;
	if (missing && missing.length === 0) {
		log(`venv ready (${INSTALL_PACKAGES.join(", ")}) at ${VENV_DIR}`);
		return;
	}

	const uv = hasUv();

	if (missing && missing.length > 0) {
		log(`repairing evaluator venv at ${VENV_DIR} (missing ${missing.join(", ")})...`);
		try {
			installDeps(uv);
		} catch (error) {
			fail(`could not repair the evaluator venv (${error?.message ?? error}).`);
		}
		const still = missingModules(PY, CORE_MODULES);
		if (still.length > 0) fail(`deps still not importable after install: ${still.join(", ")} — the evaluator won't start.`);
		reportExtras();
		log("done. pytool will use this venv.");
		return;
	}

	const system = systemPythons();
	if (!system) {
		fail(
			`no usable python found on PATH; could not create the evaluator venv at ${VENV_DIR}. ` +
				`Install Python 3.11+ (or set PYTOOL_SKIP_VENV=1 to defer) and re-run 'node scripts/setup-venv.mjs'.`,
		);
		return;
	}
	log(`building evaluator venv at ${VENV_DIR} (from ${system[0]}${system[1].length ? " " + system[1].join(" ") : ""}${uv ? ", via uv" : ""})...`);
	try {
		createVenv(system[0], system[1], uv);
		if (!existsSync(PY)) {
			fail(`a venv was created but no interpreter sits where the runtime looks for it: ${PY}`);
			return;
		}
		installDeps(uv);
		const still = missingModules(PY, CORE_MODULES);
		if (still.length > 0) {
			fail(`runtime deps still not importable after install: ${still.join(", ")} — the evaluator won't start.`);
			return;
		}
		reportExtras();
		log(`done. pytool will use this venv (${INSTALL_PACKAGES.join(", ")}).`);
	} catch (error) {
		// a real failure must exit non-zero — never hand the user a dead evaluator
		fail(`could not build the evaluator venv (${error?.message ?? error}).`);
	}
}

main();
