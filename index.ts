// --- pytool: one session-persistent Python tool, registered alongside the agent's other tools.
// --- No setActiveTools(), no namespace snapshots, no helper preloading — see README for why.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MAX_OUTPUT_CHARS, EngineManager } from "./src/engine/index.js";
import { formatDiagnostics } from "./src/extension/diagnostics.js";
import { composeErrorLines } from "./src/extension/error-format.js";
import { composeImportHint, missingModuleNames, probeInstaller } from "./src/extension/import-hint.js";
import { pytoolGuidelines, pytoolToolDescription, pytoolToolSnippet } from "./src/extension/prompt.js";

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
});

interface PytoolDetails {
	status?: "ok" | "error" | "aborted";
	durationMs?: number;
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
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				const sections = [r.kernelReset, r.stdout, r.stderr, r.result];
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
