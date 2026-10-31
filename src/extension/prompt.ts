import { DEFAULT_MAX_OUTPUT_CHARS } from "../engine/index.js";

/** Model-facing: what this tool is for, and where its boundary with the stateless code mode lies. */
export const pytoolToolDescription =
	"Run Python in a kernel that stays alive for the whole session. Names, imports, loaded data, " +
	"open files and live object handles (COM/Office/DraftSight proxies, database connections) carry " +
	"over from one call to the next. Use it when that state is expensive or impossible to rebuild; " +
	"use the stateless code mode for throwaway computation. A cell that raises keeps the kernel and " +
	"its namespace. A cell that ignores an interrupt gets its kernel killed, which empties the " +
	`namespace and is reported as KernelReaped. Output is capped at ${DEFAULT_MAX_OUTPUT_CHARS} chars with an explicit marker.`;

export const pytoolToolSnippet =
	"Persistent Python kernel — variables, data and live connections survive between calls";

export function pytoolGuidelines(): string[] {
	return [
		"The live kernel is the source of truth: reuse existing names instead of re-importing, reloading or recomputing them.",
		"Look before acting: print the minimal view that answers the question (len, shape, head, a slice). The last expression's value comes back on its own.",
		"Drive COM, RPC and other blocking APIs as many short calls, never one long batch: an interrupt cannot cut a call parked inside C, and the only way back is killing the kernel and losing every name and handle.",
		"If output starts with <pytool_kernel_reset> or the error is KernelReaped, the namespace is empty and handles are dead: re-create and re-open before using any earlier name.",
		"File and shell work belongs to the other tools; keep pytool for the Python state that has to survive.",
	];
}
