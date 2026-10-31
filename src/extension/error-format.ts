/** ipykernel paints tracebacks; the transcript must not carry the escapes. */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export interface CellErrorShape {
	name: string;
	message: string;
	stack: string[];
}

/** A traceback the model can read: `NameError: ...` then the frames, ANSI-free. */
export function composeErrorLines(error: CellErrorShape): string[] {
	const head = `${error.name}: ${error.message}`.replace(ANSI, "").trimEnd();
	const frames = (error.stack ?? [])
		.map((line) => line.replace(ANSI, "").replace(/\s+$/, ""))
		.filter((line) => line.trim() !== "");
	return [head, ...frames];
}
