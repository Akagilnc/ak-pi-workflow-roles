import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAuditorDossierTool } from "../../src/auditor-dossier-tool.ts";

test("two concurrent auditor dossier tools remain bound to their own runs", async () => {
  const runA = join("/books", "runs", "run-a@judge");
  const runB = join("/books", "runs", "run-b@reviewer");
  const toolA = createAuditorDossierTool(runA);
  const toolB = createAuditorDossierTool(runB);

  const [a, b] = await Promise.all([
    toolA.execute("call-a", {}),
    toolB.execute("call-b", {}),
  ]);

  assert.equal(a.details?.runDirectory, runA);
  assert.equal(a.details?.admittedRequest, join(runA, "admitted-request.json"));
  assert.equal(a.details?.parentSessionCandidate, join(runA, "session", "session.jsonl"));
  assert.equal(a.details?.attachments, join(runA, "attachments"));
  assert.equal(a.details?.artifacts, join(runA, "artifacts"));
  assert.equal(b.details?.runDirectory, runB);
  assert.equal(JSON.stringify(a).includes(runB), false);
  assert.equal(JSON.stringify(b).includes(runA), false);
});
