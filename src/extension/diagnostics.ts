/**
 * Read-only kernel diagnostics for /pytool. Formatting lives here, not in index.ts, so it is unit-testable
 * without a live pi, and one function is the whole surface: nothing here can change state.
 */

export interface DiagnosticsView {
	/** True when an engine exists for this session (it warms at session_start). */
	enginePresent: boolean;
	kernelState?: "idle" | "starting" | "running" | "shutdown";
	/** Process we spawned — the venv launcher on Windows, the interpreter itself on POSIX. */
	pid?: number;
	/** The bridge process: reads the op stream, owns the ZMQ channels to the kernel. */
	bridgePid?: number;
	/** The ipykernel subprocess: where cells run and where live handles (COM proxies) live. */
	kernelPid?: number;
	interpreter?: string;
	interpreterSource?: string;
	maxOutputChars: number;
	/** Names the kernel currently holds, in sorted order from the bridge. */
	namespaceNames: string[];
}

/**
 * Name each distinct process once. POSIX collapses to two: `bridge 6692 · ipykernel 25304`.
 *
 * Windows does not. A venv's python.exe is a launcher stub that re-execs, so every Python launch costs two
 * processes — and jupyter_client then spawns ipykernel through that same stub. A live session is therefore a
 * four-process chain: launcher -> bridge -> ipykernel-launcher -> the interpreter that runs cells and holds
 * the COM proxies. The leaf is the one a wedged connection belongs to, but no host-side API reports it; what
 * does work is killing the tree from its root, which is why the line below names the root.
 */
function pidSuffix(v: DiagnosticsView): string {
	const roles: [string, number | undefined][] = [];
	if (v.pid !== undefined && v.pid !== v.bridgePid) roles.push(["launcher", v.pid]);
	if (v.bridgePid !== undefined) roles.push(["bridge", v.bridgePid]);
	if (v.kernelPid !== undefined && v.kernelPid !== v.bridgePid) roles.push(["ipykernel", v.kernelPid]);
	return roles.length === 0 ? "" : ` ${roles.map(([role, pid]) => `${role} ${pid}`).join(" · ")}`;
}

function namespaceSuffix(names: string[]): string {
	if (names.length === 0) return "empty";
	const shown = names.slice(0, 12).join(", ");
	return names.length > 12 ? `${names.length} names: ${shown} …` : `${names.length} names: ${shown}`;
}

export function formatDiagnostics(v: DiagnosticsView): string {
	const lines: string[] = [];
	if (!v.enginePresent) {
		lines.push("engine: not started — it boots on the first cell");
		return lines.join("\n");
	}
	lines.push(`kernel: ${v.kernelState ?? "unknown"}${pidSuffix(v)}`);
	// a hand-kill that names one pid leaves the rest of the chain alive with its COM handles; the tree kill does not
	if (v.pid !== undefined && v.bridgePid !== undefined && v.pid !== v.bridgePid) {
		lines.push(`leaked kernel? kill the tree from its root: taskkill /PID ${v.pid} /T /F`);
	}
	lines.push(`python: ${v.interpreter ?? "unresolved"}${v.interpreterSource ? ` (${v.interpreterSource})` : ""}`);
	lines.push(`output cap: ${v.maxOutputChars} chars per cell`);
	lines.push(`namespace: ${namespaceSuffix(v.namespaceNames)}`);
	lines.push("no snapshots: a rebuilt kernel starts empty");
	return lines.join("\n");
}
