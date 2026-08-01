import { mkdir, readdir, readFile, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { renameNoReplace } from "./recorder/rename-no-replace.js";
import { isOccupiedRenameError } from "./recorder/rename-no-replace.js";
class AssistedLedgerConflictError extends Error {
  constructor(message = "assisted ledger generation conflict") {
    super(message);
    this.name = "AssistedLedgerConflictError";
  }
}
const name = (n) => `${String(n).padStart(10, "0")}.json`;
async function readAssistedLedgerV1(runDirectory) {
  const dir = join(runDirectory, "ledger");
  let files;
  try {
    files = (await readdir(dir)).filter((x) => /^\d{10}\.json$/.test(x)).sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    if (files[i] !== name(i + 1)) throw new Error("assisted ledger gap or fork");
    const row = JSON.parse(await readFile(join(dir, files[i]), "utf8"));
    const { digest, ...unsigned } = row;
    if (row.version !== 1 || row.sequence !== i + 1 || row.previousDigest !== (rows.at(-1)?.digest ?? null) || sha256Hex(canonicalJson(unsigned)) !== digest) throw new Error("assisted ledger digest mismatch or fork");
    rows.push(row);
  }
  return rows;
}
async function appendAssistedGenerationV1(runDirectory, event, now = () => (/* @__PURE__ */ new Date()).toISOString(), io = {}) {
  const dir = join(runDirectory, "ledger");
  await mkdir(dir, { recursive: true });
  const rows = await readAssistedLedgerV1(runDirectory), sequence = rows.length + 1;
  const unsigned = { version: 1, sequence, previousDigest: rows.at(-1)?.digest ?? null, createdAt: now(), ...event };
  const row = { ...unsigned, digest: sha256Hex(canonicalJson(unsigned)) };
  const finalPath = join(dir, name(sequence)), tempPath = join(dir, `.tmp-${sequence}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(tempPath, "wx", 384);
    await handle.writeFile(`${canonicalJson(row)}
`);
    await handle.sync();
    await handle.close();
    handle = void 0;
    (io.rename ?? renameNoReplace)(tempPath, finalPath);
  } catch (e) {
    try {
      await (io.cleanup ?? unlink)(tempPath);
    } catch (cleanup) {
      if (cleanup.code !== "ENOENT") throw new AggregateError([e, cleanup], "assisted ledger publication and cleanup failed", { cause: e });
    }
    if (e.code === "EEXIST" || isOccupiedRenameError(e)) throw new AssistedLedgerConflictError();
    throw e;
  } finally {
    await handle?.close();
  }
  return row;
}
function assistedRunDirectory(repositoryRoot, parentIssue, runId) {
  return join(repositoryRoot, ".ak", "work", "issues", String(parentIssue), "assisted", runId);
}
export {
  AssistedLedgerConflictError,
  appendAssistedGenerationV1,
  assistedRunDirectory,
  readAssistedLedgerV1
};
