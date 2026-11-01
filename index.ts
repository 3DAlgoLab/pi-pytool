// --- pytool: one session-persistent Python tool, registered alongside the agent's other tools.
// --- No setActiveTools(), no namespace snapshots, no helper preloading — see README for why.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MAX_OUTPUT_CHARS, EngineManager } from "./src/engine/index.js";
import { formatDiagnostics } from "./src/extension/diagnostics.js";
import { composeErrorLines } from "./src/extension/error-format.js";
import { composeImportHint, missingModuleNames, probeInstaller } from "./src/extension/import-hint.js";
import { pytoolGuidelines, pytoolToolDescription, pytoolToolSnippet } from "./src/extension/prompt.js";
import {
	composeShellPythonBlock,
	composeShellPythonNotice,
	detectShellPython,
	shellPythonMode,
	type ShellPythonMode,
} from "./src/extension/shell-python.js";

const pytoolSchema = Type.Object({
	code: Type.String({
		description: "Python source for this cell; stdout, stderr, and the last-expression result are returned.",
	}),
	maxOutputChars: Type.Optional(
		Type.Number({
			description:
				"Optional cap on characters returned across stdout and stderr. Set it lower when the caller has its own output budget shared across nested results; the session default is 46080 and can be changed with PYTOOL_MAX_OUTPUT_CHARS.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Optional wall-clock cap for this cell, in milliseconds. Set it below the deadline the caller is already under: pytool then cuts the cell itself (interrupt first, a kernel kill only if the cell will not yield), returns what it printed up to the cut, and states whether the names and live handles survived. With no cap, a cell that outruns the caller deadline is abandoned mid-cell and its kernel gets reaped behind the scenes.",
		}),
	),
});

interface PytoolDetails {
	status?: "ok" | "error" | "aborted" | "timeout";
	durationMs?: number;
	/** The cell ran past its own `timeoutMs`; the cut is reported, not swallowed. */
	timedOut?: boolean;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
	/** The install command for a package the kernel interpreter lacks, when an import failed for that reason. */
	installHint?: string;
	/** True when this cell was the first on a rebuilt kernel (namespace empty). */
	kernelReset?: boolean;
}

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let engine: EngineManager | undefined;
	let acquiring: Promise<EngineManager> | undefined;
	// --- how hard pytool pushes back when Python is routed through the shell instead of the kernel
	let shellPy: ShellPythonMode = shellPythonMode();
	let nudgesUsed = 0;
	const NUDGE_MAX = 3;

	/** One engine per session; a boot that fails leaves no half-built manager behind. */
	async function ensureEngine(): Promise<EngineManager> {
		if (engine) return engine;
		if (acquiring) return acquiring;
		const build = (async () => {
			const next = new EngineManager({ cwd });
			await next.start();
			return next;
		})();
		acquiring = build;
		try {
			engine = await build;
			return engine;
		} finally {
			if (acquiring === build) acquiring = undefined;
		}
	}

	/** Drop a manager that can no longer serve cells (a failed boot, a dead bridge). */
	async function discardEngine(): Promise<void> {
		const dying = engine;
		engine = undefined;
		acquiring = undefined;
		if (dying) await dying.kill();
	}

	// --- THE divergence from pi-repl-py: nothing here touches the tool surface. pytool is one tool among
	// --- the agent's others (read/bash/edit/write, fabric_exec, MCP), so it never hides them from the model.
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd ?? process.cwd();
		shellPy = shellPythonMode();
		nudgesUsed = 0;
		// --- warm the kernel in the background; ensureEngine() dedupes, so the first cell awaits this boot
		void ensureEngine().catch(() => {
			// --- the first cell reports the boot failure itself; a warm-up rejection is nobody's business
		});
	});

	pi.on("session_shutdown", async () => {
		const dying = engine;
		engine = undefined;
		acquiring = undefined;
		// --- bounded inside KernelClient.shutdown (2 s), then the tree kill: a leaked ipykernel keeps its
		// --- COM apartment and the document it has open, which on Windows is the worst failure here
		if (dying) await dying.dispose();
	});

	pi.registerCommand("pytool", {
		description: "Show the pytool kernel: interpreter, pids, live names, output cap",
		handler: async (_args, ctx) => {
			const names = (await engine?.listNamespaceNames()) ?? [];
			ctx.ui.notify(
				formatDiagnostics({
					enginePresent: engine !== undefined,
					kernelState: engine?.bootState,
					pid: engine?.pid,
					bridgePid: engine?.bridgePid,
					kernelPid: engine?.kernelPid,
					interpreter: engine?.pythonInterpreter,
					interpreterSource: engine?.pythonSource,
					maxOutputChars: engine?.outputCharBudget ?? DEFAULT_MAX_OUTPUT_CHARS,
					namespaceNames: names,
				}),
				"info",
			);
		},
	});

	// --- The prompt states the rule once at startup; this restates it at the exact moment it would otherwise
	// --- be broken silently. A bash call that feeds Python a heredoc, stdin, or an inline -c pays a cold
	// --- interpreter and keeps nothing, which is the one thing pytool exists to prevent. `warn` (default)
	// --- annotates the result and stops nagging after NUDGE_MAX calls; `block` refuses the call outright.
	// --- A throwing tool_call handler blocks the tool as a pi fail-safe, so every path here is wrapped.
	pi.on("tool_call", async (event) => {
		try {
			if (shellPy !== "block") return undefined;
			if (!isToolCallEventType("bash", event)) return undefined;
			const hit = detectShellPython((event.input as { command?: string }).command);
			if (!hit) return undefined;
			return { block: true, reason: composeShellPythonBlock(hit) };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_result", async (event) => {
		try {
			if (shellPy === "off" || event.toolName !== "bash") return undefined;
			if (nudgesUsed >= NUDGE_MAX) return undefined;
			const hit = detectShellPython((event.input as { command?: string }).command);
			if (!hit) return undefined;
			nudgesUsed += 1;
			const notice = composeShellPythonNotice(hit, nudgesUsed, NUDGE_MAX);
			if (event.content.length > 0 && event.content[0]?.type === "text") {
				// --- append inside the first text part so the tool result stays one block in the transcript
				event.content[0].text = `${event.content[0].text}\n\n${notice}`;
			} else {
				event.content.push({ type: "text", text: notice });
			}
			return undefined;
		} catch {
			return undefined;
		}
	});

	pi.registerTool<typeof pytoolSchema, PytoolDetails>({
		name: "pytool",
		label: "pytool",
		description: pytoolToolDescription,
		promptSnippet: pytoolToolSnippet,
		promptGuidelines: pytoolGuidelines(),
		parameters: pytoolSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (ctx?.cwd) cwd = ctx.cwd;
			const m = await ensureEngine();
			try {
				// --- accumulate partial updates so the row height doesn't oscillate
				let streamed = "";
				const r = await m.execute(params.code, {
					signal,
					maxOutputChars: params.maxOutputChars,
					timeoutMs: params.timeoutMs,
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				const sections = [r.kernelReset, r.cellTimeout, r.stdout, r.stderr, r.result];
				const errorLines = r.error ? composeErrorLines(r.error) : undefined;
				if (errorLines) sections.push(errorLines.join("\n"));
				// --- a missing package is an install, not a rewrite. Without this the model spends its next three
				// --- calls rediscovering which interpreter runs the kernel, whether that interpreter has pip, and what
				// --- the pip name of the import is -- all three of which the extension already knows.
				const missing = r.error ? missingModuleNames(r.error) : [];
				const interpreter = m.pythonInterpreter;
				const installHint =
					missing.length > 0 && interpreter ? composeImportHint(missing, interpreter, probeInstaller(interpreter, missing)) : undefined;
				if (installHint) sections.push(installHint.join("\n"));
				if (r.status === "aborted" && !errorLines) sections.push("[cell aborted]");
				const text = sections.filter((s) => s !== undefined && s !== "").join("\n");
				return {
					content: [{ type: "text" as const, text: text || "(no output)" }],
					details: {
						status: r.status,
						durationMs: r.durationMs,
						errorName: r.error?.name,
						stdout: r.stdout || undefined,
						stderr: r.stderr || undefined,
						result: r.result,
						errorStack: errorLines,
						installHint: installHint?.join("\n"),
						kernelReset: r.kernelReset !== undefined,
						timedOut: r.timedOut === true,
					},
				};
			} catch (error) {
				// --- a manager whose kernel died mid-cell and whose boot failed is not reusable; drop it so
				// --- the next cell builds a new one instead of queueing behind a corpse
				if (!m.isRunning) await discardEngine();
				throw error;
			}
		},
	});
}
