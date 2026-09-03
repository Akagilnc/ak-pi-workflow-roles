// #641 P2: settlement's Collector infrastructure classifier must recover the
// read tool's real infrastructure failures while never misjudging a known
// correctable pointer bounce (CollectorUnknownEvidenceError) as infrastructure.
import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "../../src/collector-ledger.ts";
import { extractCollectorInfrastructureFailure } from "../../src/public-cli/settlement.ts";
import { buildNavigatorInfrastructureFailureFact } from "../../src/navigator-invocation-identity.ts";

type Entry = { type?: string; message?: Record<string, unknown> };

function toolResult(toolName: string, text: string, details: unknown): Entry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      isError: true,
      content: [{ type: "text", text }],
      details,
    },
  };
}

test("read tool real infrastructure failures classify as CollectorInfrastructureError", () => {
  const failure = extractCollectorInfrastructureFailure([
    toolResult(COLLECTOR_READ_TOOL, "通进司操作调用已在进行", buildNavigatorInfrastructureFailureFact()),
  ]);
  assert.ok(failure, "read infra failure must be recovered");
  assert.equal(failure.cause, "activation");
  assert.equal(failure.diagnostic, "通进司操作调用已在进行");
  assert.equal(failure.identity?.name, "CollectorInfrastructureError");
});

test("read tool correctable pointer bounces never classify as infrastructure", () => {
  for (const details of [
    {},
    { code: "CollectorUnknownEvidenceError" },
  ]) {
    const failure = extractCollectorInfrastructureFailure([
      toolResult(COLLECTOR_READ_TOOL, "未在本局已观测材料中找到 evidenceId missing；请用 observe 返回的指针重试。", details),
    ]);
    assert.equal(failure, undefined, `details ${JSON.stringify(details)} must not be infrastructure`);
  }
});

test("observe/request/wait infra failures keep their tool-name contract", () => {
  for (const tool of [COLLECTOR_OBSERVE_TOOL, COLLECTOR_REQUEST_TOOL, COLLECTOR_WAIT_TOOL]) {
    const failure = extractCollectorInfrastructureFailure([
      toolResult(tool, "HTTP 404 Not Found", {}),
    ]);
    assert.ok(failure, `${tool} infra failure must still classify`);
    assert.equal(failure.diagnostic, "HTTP 404 Not Found");
    assert.equal(failure.identity?.name, "CollectorInfrastructureError");
  }
});