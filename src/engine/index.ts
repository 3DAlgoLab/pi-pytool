// --- EngineManager: interpreter resolution, kernel boot, the cell queue, output caps, abort grace,
// --- teardown. The wire lives in kernel.ts. There is no namespace snapshot on purpose: see README.

import { formatPythonFailure, type PythonResolution, type PythonSource, resolvePython } from "./python-locate.js";
import { KernelClient } from "./kernel.js";

export { formatPythonFailure, managedVenvDir, pythonCandidates, resolvePython } from "./python-locate.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 46_080;
/** A configured cap this small produces output nobody can read; such a value is ignored, not honoured. */
const MIN_USEFUL_OUTPUT_CHARS = 512;
/** Per-line cap: one giant line must not own the channel budget while long JSON/reprs/errors pass whole. */
export const MAX_OUTPUT_LINE_CHARS = 4096;
/** Boot deadline: a wedged (alive but silent) kernel must not hang every later cell. */
export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
/**
 * How long an aborted cell gets to observe the interrupt before the kernel is killed.
 *
 * Measured on Windows: an interrupt takes effect at the cell's next Python bytecode boundary, never inside
 * a blocking call -- a loop of 0.05 s sleeps is cut ~0.2 s after the signal, while a single time.sleep(3)
 * runs the whole 3 s and only then raises KeyboardInterrupt. A cell parked in one long C call (a hung
 * DraftSight RPC, a socket read, a native compute) never observes it at all, and only the kill reaches it.
 *
 * So the grace costs nothing when it works (milliseconds) and buys nothing when it does not. 5 s reaps a
 * wedged kernel promptly while still letting a yielding cell unwind its finally blocks.
 */
const DEFAULT_ABORT_GRACE_MS = 5_000;

export interface EngineExecuteError {
	name: string;
	message: string;
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
	/** Set when this cell was the first on a rebuilt kernel: every earlier name is gone.
	 *  There is no snapshot to revive, so the model is told rather than left to assume. */
	kernelReset?: string;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell via kernel interrupt; the namespace survives only if the cell yields. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	maxOutputChars?: number;
}

export interface EngineOptions {
	cwd?: string;
	env?: Record<string, string>;
	bootTimeoutMs?: number;
}

// --- process-wide cleanup: a child does not die with its parent, so SIGKILL live kernels on exit ---

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

/**
 * Cap one output channel, and name what the cut cost.
 *
 * The marker is written for the model that has to keep working after it: the cap, the size of what fell
 * off, and the two ways to get that text back. A bare "...truncated..." says something was lost without
 * saying whether the answer is to print a slice, page through it, or read a file.
 */
export function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean, dropped = 0): string {
	const hidden = dropped + Math.max(0, text.length - maxChars);
	if (!wasTruncated && hidden <= 0) return text;
	return (
		`${text.slice(0, maxChars)}\n` +
		`[... output truncated at ${maxChars} chars, ${hidden} dropped — print the slice you need, ` +
		"or write it to a file and read it back ...]"
	);
}

export function capLinesForContext(text: string): { text: string; trimmed: boolean } {
	const lines = text.split("\n");
	let trimmed = false;
	const mapped = lines.map((line) => {
		if (line.length <= MAX_OUTPUT_LINE_CHARS) return line;
		trimmed = true;
		return line.slice(0, MAX_OUTPUT_LINE_CHARS);
	});
	return { text: mapped.join("\n"), trimmed };
}

/** What a rebuilt kernel cost, in the model's own terms. The COM case makes this load-bearing: silence
 *  here reads as "the abort was clean", and the model goes on calling a dead proxy. */
export function formatKernelResetNotice(): string {
	return [
		"<pytool_kernel_reset>",
		"The Python kernel restarted. Every name defined earlier in this session is gone: nothing is restored,",
		"because live handles (a COM proxy, an open document, a database connection) cannot be serialized.",
		"Re-create what you need before using it, and re-open every handle.",
		"</pytool_kernel_reset>",
	].join("\n");
}

export class EngineManager {
	private readonly options: EngineOptions;
	private kernel?: KernelClient;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private python?: PythonResolution;
	/** Per-engine: the right abort grace depends on what the cell is doing (see DEFAULT_ABORT_GRACE_MS). */
	private readonly abortGraceMs: number;
	private readonly bootTimeoutMs: number;
	/**
	 * Output cap applied when a caller names none. Env-overridable because the right number depends on who
	 * is reading: a model browsing a REPL wants everything, while a caller with its own shared output budget
	 * spread across many results wants one cell not to spend it all.
	 */
	private readonly maxOutputCharsDefault: number;
	/** Kernels booted by this engine; > 1 means the session lost its namespace once. */
	private kernelGenerations = 0;
	/** Awaiting announcement: the next cell is the first on a rebuilt kernel. */
	private resetPending = false;

	constructor(options: EngineOptions = {}) {
		this.options = options;
		const env = options.env ?? {};
		this.abortGraceMs = Math.max(
			0,
			Number(process.env.PYTOOL_ABORT_GRACE_MS ?? env.PYTOOL_ABORT_GRACE_MS ?? DEFAULT_ABORT_GRACE_MS),
		);
		this.bootTimeoutMs =
			Number(process.env.PYTOOL_BOOT_TIMEOUT_MS ?? env.PYTOOL_BOOT_TIMEOUT_MS ?? options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS) ||
			DEFAULT_BOOT_TIMEOUT_MS;
		const configuredCap = Number(process.env.PYTOOL_MAX_OUTPUT_CHARS ?? env.PYTOOL_MAX_OUTPUT_CHARS);
		this.maxOutputCharsDefault =
			Number.isInteger(configuredCap) && configuredCap >= MIN_USEFUL_OUTPUT_CHARS
				? configuredCap
				: DEFAULT_MAX_OUTPUT_CHARS;
	}

	get isRunning(): boolean {
		return this.state === "running" && (this.kernel?.isRunning ?? false);
	}

	/** The cap a cell gets when the caller named none; public so the rule can be tested without a kernel. */
	get outputCharBudget(): number {
		return this.maxOutputCharsDefault;
	}

	/** Spawned pid (the venv launcher on Windows). See KernelClient for the three-role explanation. */
	get pid(): number | undefined {
		return this.kernel?.pid;
	}

	/** The bridge process (op stream + ZMQ channels). */
	get bridgePid(): number | undefined {
		return this.kernel?.bridgePid;
	}

	/** The ipykernel subprocess pid -- the one a leaked COM handle belongs to. */
	get kernelPid(): number | undefined {
		return this.kernel?.kernelPid;
	}

	/** Boot state as a value (a field read is not narrowed away by control flow). */
	get bootState(): "idle" | "starting" | "running" | "shutdown" {
		return this.state;
	}

	/** Interpreter the kernel runs on, as resolved at boot; undefined before the first boot. */
	get pythonInterpreter(): string | undefined {
		return this.python?.executable ?? this.python?.argv[0];
	}

	/** Which rule selected that interpreter (pin, managed venv, PATH). */
	get pythonSource(): PythonSource | undefined {
		return this.python?.source;
	}

	/** Why each rejected interpreter lost, once a boot has been attempted. */
	get pythonTried(): PythonResolution["tried"] {
		return this.python?.tried ?? [];
	}

	// --- state can flip to shutdown at any time; read it via a method so TS can't narrow the union away ---
	private isShutdown(): boolean {
		return this.state === "shutdown";
	}

	async start(): Promise<void> {
		if (this.isShutdown()) throw new Error("pytool engine is shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// --- keep a startup failure nobody awaits from surfacing as unhandled ---
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.state = "starting";
		// --- one interpreter answer for the whole machine (see python-locate.ts): a pin wins outright,
		// --- everything else has to prove it can import the bridge's deps before it is trusted ---
		const resolved = resolvePython();
		this.python = resolved;
		if (!resolved.ok) {
			this.state = "idle";
			throw new Error(formatPythonFailure(resolved));
		}
		installProcessCleanupOnce();
		liveEngines.add(this);
		const timeoutMs =
			Number(process.env.PYTOOL_TIMEOUT_MS ?? this.options.env?.PYTOOL_TIMEOUT_MS ?? 0) || 0;
		let kernel: KernelClient | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let startedAttempt: Promise<KernelClient> | undefined;
		try {
			const started = (startedAttempt = KernelClient.start(resolved.argv, {
				cwd: this.options.cwd,
				// --- PI_PYTHON is the contract with sibling skills: an extension or skill installs its
				// --- package into $PI_PYTHON, so it lands in the interpreter that actually runs cells ---
				env: { ...this.options.env, ...(resolved.executable ? { PI_PYTHON: resolved.executable } : {}) },
				timeoutMs,
			}));
			const guard = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`kernel boot did not answer within ${this.bootTimeoutMs / 1000}s`)), this.bootTimeoutMs);
				timer.unref?.();
			});
			started.catch(() => {});
			kernel = await Promise.race([started, guard]);
		} catch (error) {
			// --- a wedged boot is killed, not left running: acquire() would dedupe onto it forever ---
			kernel?.kill();
			// the spawn survives a rejected ready wait; kill it so the next acquire() can't dedupe onto it
			if (startedAttempt) startedKillAttempt(startedAttempt);
			if (this.state === "starting") this.state = "idle";
			liveEngines.delete(this);
			throw error instanceof Error ? error : new Error(String(error));
		} finally {
			if (timer) clearTimeout(timer);
		}
		this.kernel = kernel;
		// --- a dead kernel must be rebuilt by the next cell, never resumed as a zombie ---
		const current = kernel;
		current.setOnUnexpectedExit(() => {
			if (this.kernel !== current) return;
			this.kernel = undefined;
			this.startPromise = undefined;
		});
		// --- win the shutdown race: don't resurrect a killed engine as running ---
		if (this.isShutdown()) {
			this.kernel.kill();
			this.kernel = undefined;
			throw new Error("pytool engine is shut down");
		}
		this.kernelGenerations += 1;
		if (this.kernelGenerations > 1) this.resetPending = true;
		this.state = "running";
	}

	/** Abrupt teardown: SIGKILL the kernel; safe from process.on("exit"). */
	killSync(): void {
		this.state = "shutdown";
		liveEngines.delete(this);
		this.kernel?.kill();
		this.kernel = undefined;
		this.startPromise = undefined;
	}

	async kill(): Promise<void> {
		this.killSync();
	}

	/** Graceful teardown: interrupt anything running, ask the bridge to stop, then kill the tree. */
	async dispose(): Promise<void> {
		if (this.kernel?.hasActiveCell) this.kernel.requestInterrupt();
		await this.kernel?.shutdown();
		this.killSync();
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// --- claim the queue slot synchronously so order == submission order ---
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.isShutdown()) {
				throw new Error("pytool engine is shut down");
			}
			// --- the abort can land while a cold engine is still booting, and it must not be lost: attaching
			// --- the listener only after the cell was submitted let an abort during boot change nothing, so the
			// --- cell then ran to completion (measured: a sleep withdrawn at +0.8 s ran the full sleep).
			const started = Date.now();
			let withdrawn = false;
			let aborted = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			// --- the grace expiring means the cell never reached a Python boundary: the kernel was reaped, and
			// --- every live handle it held (COM proxy, open file, connection) died with it. The model has to be
			// --- told, because "aborted" alone implies the namespace is intact.
			let reapedDuringAbort = false;
			const onAbort = () => {
				withdrawn = true;
				aborted = true;
				this.kernel?.requestInterrupt();
				// --- interrupt is a real KeyboardInterrupt, but a C-wedged cell ignores it; then kill and rebuild ---
				graceTimer = setTimeout(() => {
					if (this.state === "running" && this.kernel) {
						reapedDuringAbort = true;
						// --- the engine survives its kernel: idle, not shutdown, so the next cell gets a fresh one
						// --- instead of "engine is shut down" for the rest of the session
						this.state = "idle";
						this.kernel.kill();
						this.kernel = undefined;
						this.startPromise = undefined;
					}
				}, this.abortGraceMs);
				graceTimer.unref?.();
			};
			if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
			await this.start();
			// --- the kernel may have died after boot resolved but before its exit event; drop the zombie ---
			if (this.kernel && !this.kernel.isRunning) {
				this.kernel = undefined;
				this.startPromise = undefined;
				await this.start();
			}
			if (this.isShutdown()) {
				throw new Error("pytool engine is shut down");
			}
			// --- withdrawn during the boot: the cell was never submitted, so there is nothing to interrupt.
			// --- The engine stays warm and the next cell is served normally.
			if (withdrawn) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}

			const maxChars = opts.maxOutputChars ?? this.maxOutputCharsDefault;
			const resetNotice = this.takeResetNotice();
			try {
				const r = await this.kernel!.executeCell(code, {
					signal: opts.signal,
					onStream: opts.onStream,
					maxOutputChars: maxChars,
				});
				const status: ExecuteResult["status"] = opts.signal?.aborted ? "aborted" : r.status;
				// Channel cap (truncateWithMarker), then per-line cap; both append a marker so the loss is explicit.
				const finalize = (text: string, channelTruncated: boolean, channelDropped = 0): string => {
					let out = truncateWithMarker(text, maxChars, channelTruncated, channelDropped);
					const line = capLinesForContext(out);
					out = line.trimmed
						? `${line.text}\n[... some lines exceeded ${MAX_OUTPUT_LINE_CHARS} chars and were cut — slice the value or print it in chunks ...]`
						: line.text;
					return out;
				};
				const reapedError: EngineExecuteError | undefined = reapedDuringAbort
					? { name: "KernelReaped", message: reapedMessage(this.abortGraceMs), stack: [] }
					: undefined;
				return {
					stdout: finalize(r.stdout, r.truncated?.stdout ?? false, r.truncated?.stdoutDropped ?? 0),
					stderr: finalize(r.stderr, r.truncated?.stderr ?? false, r.truncated?.stderrDropped ?? 0),
					result: r.result !== undefined ? finalize(String(r.result), String(r.result).length > maxChars) : undefined,
					error: reapedError ?? r.error,
					status,
					durationMs: Date.now() - started,
					...(resetNotice ? { kernelReset: resetNotice } : {}),
				};
			} catch (error) {
				if (aborted) {
					return {
						stdout: "",
						stderr: "",
						status: "aborted",
						durationMs: Date.now() - started,
						...(reapedDuringAbort
							? {
									error: {
										name: "KernelReaped",
										message: reapedMessage(this.abortGraceMs),
										stack: [],
									} satisfies EngineExecuteError,
								}
							: {}),
					};
				}
				throw error;
			} finally {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
			}
		} finally {
			release();
		}
	}

	/** Names the session currently holds; null when no kernel is up. */
	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running" || !this.kernel) return null;
		try {
			return await this.kernel.listNames();
		} catch {
			return null;
		}
	}

	/** The reset notice, taken exactly once per rebuilt kernel. */
	private takeResetNotice(): string | undefined {
		if (!this.resetPending) return undefined;
		this.resetPending = false;
		return formatKernelResetNotice();
	}
}

function reapedMessage(graceMs: number): string {
	return (
		`the cell ignored the interrupt for ${graceMs / 1000}s — it was parked inside a C call, which no interrupt ` +
		"can cut — so the kernel was killed. Every live object the cell held (COM proxy, open file, database " +
		"connection) died with it, and the namespace is empty: the next cell boots a fresh kernel."
	);
}

/** A boot that timed out may still resolve later; make sure that late kernel dies. */
function startedKillAttempt(started: Promise<KernelClient>): void {
	started.then((late) => late.kill()).catch(() => {});
}
