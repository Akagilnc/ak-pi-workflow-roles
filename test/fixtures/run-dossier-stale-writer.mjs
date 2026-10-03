// Child process for the run-dossier concurrency test: a writer that has read the rows and
// computed its rendering, then PAUSES just before the write of current.json lands (the
// rename of its temp file, or the in-place fallback) until the parent says go. The parent
// uses the pause to let another writer record and render newer facts first.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [runDirectory, readyFile, goFile] = process.argv.slice(2);

let paused = false;
const realRename = fs.renameSync;
fs.renameSync = function patchedRename(from, to) {
  if (!paused && String(to).endsWith("current.json")) {
    paused = true;
    fs.writeFileSync(readyFile, "ready");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(goFile)) Atomics.wait(wait, 0, 0, 5);
  }
  return realRename.call(this, from, to);
};
syncBuiltinESMExports();

const { writeSectionSync } = await import("../../src/run-dossier.ts");
// The earlier-settling writer records its lifecycle page (a different page than the one
// the other writer changes).
writeSectionSync(runDirectory, "runState", { state: "terminal", by: "earlier-settling-writer" });
