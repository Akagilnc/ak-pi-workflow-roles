// Child process for the run-dossier concurrency test. Two roles on one run:
//   append <run> <count> <doneFile>  appends sealed ledger rows through the real appender
//                                    (what a role runtime / gate does), then writes <doneFile>
//   carry  <run> <minWrites> <doneFile>  does the public call's carried-section writes
//                                    until <doneFile> exists (and at least <minWrites>), then once more
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeSectionSync } from "../../src/run-dossier.ts";
import { reportRunRecord } from "../../src/sitian-facade.ts";

const [mode, runDirectory, count, doneFile] = process.argv.slice(2);

if (mode === "append") {
  try {
    for (let i = 0; i < Number(count); i += 1) {
      reportRunRecord(runDirectory, "sealed", { toolCallId: `call-${i}`, role: "judge", accepted: true }, "dossier-race");
    }
  } finally {
    writeFileSync(doneFile, "done", "utf8");
  }
} else {
  let writes = 0;
  let sawSubmission = false;
  const writeOnce = () => {
    writeSectionSync(runDirectory, "runState", { writes });
    writeSectionSync(runDirectory, "terminal", { face: "report", writes });
    writes += 1;
    // The derived section never goes missing once a write has carried it.
    const current = JSON.parse(readFileSync(join(runDirectory, "current.json"), "utf8"));
    if (current.submission?.latest !== undefined) sawSubmission = true;
    else if (sawSubmission) {
      console.error("submission.latest vanished after a carried-section write");
      process.exit(3);
    }
  };
  while (writes < Number(count) || !existsSync(doneFile)) writeOnce();
  writeOnce();
}
