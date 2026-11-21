/** Fake Pi child: use the real run/court envelope delivered by the adapter. */
import { readFileSync } from "node:fs";
import { runIdFromRunDirectory } from "../../../src/run-terminal-artifacts.ts";
import type { TerminalRoleName } from "../../../src/public-cli/terminal.ts";
import { WorkerUnfinishedReasonReminderError } from "../../../src/worker-submission-gates.ts";
import { driveLedgerProducer } from "../../helpers/submission-ledger-fixture.ts";

let runDirectory = process.env.AK_ROLE_RUN_DIR!;
const runId = runIdFromRunDirectory(runDirectory)!;
const { role, drafts, mode } = JSON.parse(readFileSync(0, "utf8")) as {
  role: TerminalRoleName; drafts: unknown[]; mode?: string;
};
for (const [index, details] of drafts.entries()) {
  runDirectory = await driveLedgerProducer({
    cwd: process.cwd(), home: process.env.HOME!, role, runDirectory, runId,
    toolCallId: `call-${index + 1}`, details,
    ...(process.env.AK_ROLE_INVOCATION_SCOPE && { invocationScopeId: process.env.AK_ROLE_INVOCATION_SCOPE }),
    ...(process.env.AK_ROLE_COURT_ATTEMPT ? { courtAttemptId: process.env.AK_ROLE_COURT_ATTEMPT } : {}),
    ...(mode === "bounce" && index === 0 ? { executeError: new WorkerUnfinishedReasonReminderError() } : {}),
    ...(mode === "interrupt" ? { onExecute: () => process.exit(0) } : {}),
  });
}
