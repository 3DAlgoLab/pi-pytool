// HANDOFF §7 smoke: the founding use case -- a live COM proxy that survives from cell to cell.
//
// Run with: bun scripts/smoke-com-draftsight.ts   (DraftSight must already be running)
//
// Drives EngineManager directly, which is the object pytool's tool calls. A real pi session cannot be
// driven this far from RPC: cells reach the kernel only through the model's tool call. The kernel path --
// interpreter ladder, bridge, PI_PYTHON export, abort/reap -- is identical either way.
//
// It draws into a NEW document and closes it afterwards, so the operator's open drawing is untouched.
// Rendering is the honest check: an InsertLine that returns a proxy proves nothing, a non-blank export does.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { EngineManager } from "../src/engine/index.js";

// Run-unique names: SaveAs2 writes nothing when another open document already owns the target path, so
// reusing one fixed name would make a rerun measure the previous run's file.
const DIR = "C:/Users/three/AppData/Local/Temp";
const TAG = new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 14);
const DWG = `${DIR}/pytool-smoke-com-${TAG}.dwg`;
const PNG = DWG.replace(/\.dwg$/, ".png");
const PNG2 = DWG.replace(/\.dwg$/, "-after-reap.png");
for (const f of [DWG, PNG, PNG2]) if (existsSync(f)) rmSync(f);

const at = (label: string, r: { stdout?: string; stderr?: string; result?: string; error?: { name: string; message: string }; status: string }) => {
	const text = [r.stdout, r.stderr, r.result].filter(Boolean).join(" | ").trim();
	const err = r.error ? ` !! ${r.error.name}: ${r.error.message}` : "";
	console.log(`${label} [${r.status}] ${text.slice(0, 320)}${err}`.slice(0, 520));
	return r;
};

const e = new EngineManager({ cwd: process.cwd() });
try {
	// ---- the PI_PYTHON contract: the sibling package must live in the interpreter that runs cells ----
	await e.start();
	at("0 interpreter", await e.execute(
		"import sys, os, draftsight_com as ds\n" +
		"print('exe      ', sys.executable)\n" +
		"print('arch     ', sys.maxsize > 2**32 and '64-bit' or '32-bit')\n" +
		"print('PI_PYTHON', os.environ.get('PI_PYTHON'))\n" +
		"print('pkg      ', ds.__file__)",
	));

	// ---- step 1: attach over COM, in its own cell, and leave `app` in the namespace ----
	at("1 attach", await e.execute(`
import win32com.client as w, draftsight_com as ds
app = w.GetActiveObject('DraftSight.Application')
print('DraftSight', app.GetVersion())
print('open docs', ds.documents(app))`));

	// ---- step 2: use `app` from cell 1, no reconnect and no re-dispatch. This is the product. ----
	at("2 geometry", await e.execute(`
import draftsight_com as ds, os
sh = ds.new_document(app)
sh.drafting_style()
sh.line((0,0),(40,0))
sh.circle((20,20), 10)
out = ${JSON.stringify(DWG)}
sh.zoom_fit(); sh.save(out); sh.export_png(out[:-4] + '.png')
print('proxy from cell 1 still live:', app.GetVersion())
print('dwg bytes', os.path.getsize(out), 'png bytes', os.path.getsize(out[:-4] + '.png'))`));

	// ---- step 3: the proxy answers, so it is live and not a stale reference ----
	at("3 live proxy", await e.execute("app.GetVersion()"));

	// ---- step 4: kill the kernel with a cell parked past the grace ----
	process.env.PYTOOL_ABORT_GRACE_MS = "1500";
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 200);
	at("4 reap", await e.execute("import time\ntime.sleep(10)", { signal: ac.signal }));
	delete process.env.PYTOOL_ABORT_GRACE_MS;

	// ---- step 5: reconnect, and prove the geometry lived in the app, not the dead kernel ----
	const after = at("5 reconnect", await e.execute(`
import win32com.client as w, draftsight_com as ds, os
app2 = w.GetActiveObject('DraftSight.Application')
print('fresh attach:', app2.GetVersion())
sh2 = ds.Sheet(app2.GetActiveDocument(), app2)
sh2.export_png(${JSON.stringify(PNG2)})
print('png re-exported from the doc the app still holds:', os.path.getsize(${JSON.stringify(PNG2)}), 'bytes')`));
	console.log(`reset notice on the cell after the reap: ${after.kernelReset !== undefined}`);
	const stale = await e.execute("app.GetVersion()");
	console.log(`the dead session's proxy is really gone: [${stale.status}] ${stale.error?.name}`);

	// ---- DraftSight itself survived -- no zombie lock ----
	const alive = execFileSync("tasklist", ["/FI", "IMAGENAME eq DraftSight.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
	console.log(`DraftSight processes after the reap: ${alive.trim().split("\n").filter((l) => l.includes("DraftSight")).length}`);

	// Closing the ACTIVE document takes the whole COM server down, so another document has to be activated
	// first -- the guard in ds.close_document exists to stop that. Unnamed scratch documents are left alone:
	// closing one risks taking the server down with it.
	at("6 cleanup", await e.execute(`
import os
out = ${JSON.stringify(DWG)}
for d in app2.GetDocuments():
    if os.path.abspath(d.GetPathName()) != out:
        d.Activate()
        break
closed = []
# Normalize both sides before comparing: an unnamed document's GetPathName() is bare (NONAME_0.dwg), so a
# raw compare could match the active document and closing THAT takes the COM server down.
active = os.path.abspath(app2.GetActiveDocument().GetPathName())
for d in list(app2.GetDocuments()):
    p = d.GetPathName()
    if 'pytool-smoke' in p and os.path.abspath(p) != active:
        app2.CloseDocument(p, False)
        closed.append(p)
print('closed:', closed)
print('docs left open:', [d.GetPathName() for d in app2.GetDocuments()])`));
} finally {
	await e.dispose().catch(() => {});
	console.log(`kernel gone: ${e.isRunning === false}`);
	for (const f of [DWG, PNG, PNG2]) console.log(`${f}: ${existsSync(f) ? `${statSync(f).size} bytes (kept as proof)` : "absent"}`);
}
