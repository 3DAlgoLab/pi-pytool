// --- Python computation belongs to the kernel, not to the shell.
// ---
// --- The failure this exists for: pytool is registered as one tool among the agent's others, and the
// --- tool description historically pointed "throwaway computation" at a stateless code mode. When no
// --- such tool is loaded in the session, that instruction has no destination, and the work lands in
// --- bash as `python3 - <<'PY' ... PY` or `python -c "..."`. Each such call pays a cold interpreter,
// --- writes its result into a string the model re-reads instead of a name the next cell reuses, and
// --- silently forfeits every object the kernel would have carried forward. The prompt says the rule
// --- once at startup; this says it at the moment the pattern actually occurs.
// ---
// --- Detection is deliberately narrow: it fires only when the code reaches the interpreter from the
// --- command line (-c, stdin, heredoc, end of a pipe). Real shell work -- installing, venvs, running a
// --- file that exists, running a test runner, or producing a .py artifact on purpose -- is left alone.

export type ShellPythonMode = "warn" | "block" | "off";

/** `PYTOOL_SHELL_PY=warn|block|off`; warn (the default) annotates the result, block refuses the call. */
export function shellPythonMode(env: NodeJS.ProcessEnv = process.env): ShellPythonMode {
	const raw = (env.PYTOOL_SHELL_PY ?? "warn").trim().toLowerCase();
	if (raw === "block" || raw === "strict" || raw === "on") return "block";
	if (raw === "off" || raw === "0" || raw === "no" || raw === "false") return "off";
	return "warn";
}

/** An interpreter named as a command word, optionally through a venv/system path prefix. */
const INTERPRETER = /(?:^|[\s;&|(`])(?:[\w./$-]+\/)*(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)(?=[\s;)]|$)/;

/** Ways code reaches the interpreter from the command line rather than from a file on disk. */
const CODE_FROM_ARGV = /(?:^|[\s;&|])(?:-c|--command)(?:\s|=)|\|\s*(?:[\w./$-]+\/)*(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)\s*(?:$|[#;&|)])/;
const STDIN_DASH = /(?:^|[\s;&|])(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)(?:\s+[-\w:=]+)*\s+-(?:\s|$)/;
const HEREDOC_TO_INTERPRETER = /(?:^|[\s;&|])(?:[\w./$-]+\/)*(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)(?:\s+[-\w:=]+)*\s*<<[-~]?\s*['"]?[\w./-]+/;

/** `-m <module>` runs an installed tool (pip, venv, pytest, mypy, ...), not ad-hoc code. */
const MODULE_RUN = /(?:^|[\s;&|])(?:[\w./$-]+\/)*(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)\s+-m\s/;
/** Interpreter bookkeeping, not computation. */
const INFO_FLAGS = /(?:^|[\s;&|])(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)\s+(?:-V|--version|-h|--help)(?:\s|$)/;
/** A file argument: the script is the artifact, and running it is ordinary shell work. */
const FILE_ARG = /(?:^|[\s;&|])(?:[\w./$-]+\/)*(?:python[23]?(?:\.\d+)?|pypy3?|ipython|py)(?:\s+[-\w:=]+)*\s+[\w./~$-]+\.pyw?\b/;
/** The command is deliberately writing a .py file, so the shell is the right tool for it. */
const WRITES_PY_FILE = /(?:>|>>|\btee\b|\bcat\b[^|;&]*>)[^|;&]*[\w.-]+\.pyw?\b/;
/** Installers and package managers never count as computation. */
const PACKAGE_MANAGER = /(?:^|[\s;&|])(?:[\w./$-]+\/)*(?:pip|pip3|pip[23](?:\.\d+)?|uv|poetry|conda|pipx)\s/;

/** Commands whose heredoc is a payload of data, not code to execute. */
const DATA_HEREDOC =
	/(?:^|[\s;&|])(?:[\w./$-]+\/)*(?:cat|tee|echo|printf|sed|awk|git|npm|npx|pi|bun|docker|make|ssh)(?:\s+(?:[-\w:=./]+|>{1,2}\d?|\d?<))+\s*<<[-~]?\s*(['"]?)([A-Za-z_][\w.-]*)\1(?:[^\n]*)\n[\s\S]*?^[\t]*\2[ \t]*$/gim;

/**
 * Drop the body of a heredoc that belongs to a data command. Without this, quoting the very pattern
 * this module looks for -- `python3 - <<'PY'` inside a commit message written with `cat <<MSG`
 * -- reads as running it. Observed the moment this module shipped: the release commit for the module
 * itself was annotated. The command line of such a heredoc is kept; only its payload goes.
 */
export function withoutDataHeredocBodies(command: string): string {
	return command.replace(DATA_HEREDOC, (whole) => whole.split("\n")[0] + " <<body");
}

/**
 * Returns why the command routes Python through the shell, or undefined when the command is legitimate
 * shell work. Every rule that returns early is a false positive this module chose to lose rather than
 * nag about -- a wrong block costs the agent a turn, a wrong warning only costs attention.
 */
export function detectShellPython(command: string | undefined): { reason: string } | undefined {
	if (!command || !command.trim()) return undefined;
	const text = withoutDataHeredocBodies(command.replace(/\r\n/g, "\n"));
	if (!INTERPRETER.test(text)) return undefined;
	if (PACKAGE_MANAGER.test(text)) return undefined;
	if (INFO_FLAGS.test(text)) return undefined;
	if (MODULE_RUN.test(text)) return undefined;
	if (FILE_ARG.test(text)) return undefined;
	if (WRITES_PY_FILE.test(text)) return undefined;

	const viaHeredoc = HEREDOC_TO_INTERPRETER.test(text);
	const viaStdin = STDIN_DASH.test(text);
	const viaArgv = CODE_FROM_ARGV.test(text);
	if (!viaHeredoc && !viaStdin && !viaArgv) return undefined;

	const how = viaHeredoc ? "a heredoc" : viaStdin ? "stdin" : "an inline -c/pipe";
	return { reason: `Runs a cold CPython for ${how} and keeps nothing after the call.` };
}

/** The line appended to the bash result; short, and it names the switch that silences it. */
export function composeShellPythonNotice(hit: { reason: string }, nudgeNumber: number, nudgeMax: number): string {
	const lines = [
		`[pytool] ${hit.reason} pytool is the session kernel: rerun the cell there when any name, import, or loaded`,
		`file would be needed again, and keep bash for files, processes, git, and installs.`,
	];
	if (nudgeNumber < nudgeMax) {
		lines.push(`(notice ${nudgeNumber}/${nudgeMax}; PYTOOL_SHELL_PY=off silences it, =block refuses such calls instead)`);
	} else {
		lines.push(`(last notice; PYTOOL_SHELL_PY=off silences it, =block refuses such calls instead)`);
	}
	return lines.join("\n");
}

/** The block reason shown to the model when the mode is strict. */
export function composeShellPythonBlock(hit: { reason: string }): string {
	return `${hit.reason} Call pytool with this code instead -- the kernel keeps names, imports, and open files between calls. Set PYTOOL_SHELL_PY=warn to downgrade this to a note, =off to disable.`;
}
