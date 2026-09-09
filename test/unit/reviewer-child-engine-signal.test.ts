/**
 * #818 — axis sub-session engine signal uses the same resolveEngineName gate as
 * parent registration. Request-scoped getFlag arms; empty flag blocks ambient;
 * absent getFlag falls back to pi child-env. No second engine logic.
 *
 * Entry: reviewerChildEngineName (sole production path in executeReviewerChild).
 * External face: detour tool name when armed (createEngineDetourToolDefinition).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_TOOL_NAME,
  ENGINE_FLAG_NAME,
} from "../../src/engine-detour.ts";
import { createEngineDetourToolDefinition } from "../../src/engine-detour-tool.ts";
import { reviewerChildEngineName } from "../../src/reviewer-child-executor.ts";
import type { ReviewerDispatchRunOptions } from "../../src/reviewer-agent.ts";

test("axis child: request getFlag arms engine without process.env", () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  delete process.env[AK_ROLE_ENGINE_ENV];
  try {
    const name = reviewerChildEngineName({
      getFlag: (n) => (n === ENGINE_FLAG_NAME ? "agy" : undefined),
    });
    assert.equal(name, "agy");
    assert.equal(process.env[AK_ROLE_ENGINE_ENV], undefined);
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("axis child: empty getFlag blocks ambient AK_ROLE_ENGINE", () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "ambient-should-not-arm";
  try {
    // Envelope projects "" when request has no engine — must not fall through.
    assert.equal(
      reviewerChildEngineName({
        getFlag: (n) => (n === ENGINE_FLAG_NAME ? "" : undefined),
      }),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("axis child: absent getFlag falls back to child env (pi path)", () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "from-pi-child-env";
  try {
    assert.equal(reviewerChildEngineName({}), "from-pi-child-env");
    assert.equal(reviewerChildEngineName(), "from-pi-child-env");
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("axis child: agent getFlag spread reaches child gate", () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  delete process.env[AK_ROLE_ENGINE_ENV];
  try {
    // Mirrors reviewer-agent: ...(options.getFlag === undefined ? {} : { getFlag })
    const dispatchOptions: Pick<ReviewerDispatchRunOptions, "getFlag"> = {
      getFlag: (n) => (n === ENGINE_FLAG_NAME ? "agy" : undefined),
    };
    const childOptions = {
      ...(dispatchOptions.getFlag === undefined
        ? {}
        : { getFlag: dispatchOptions.getFlag }),
    };
    assert.equal(reviewerChildEngineName(childOptions), "agy");
    assert.equal(reviewerChildEngineName({}), undefined);
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("axis child: armed name reuses createEngineDetourToolDefinition (one logic)", () => {
  const engineName = reviewerChildEngineName({
    getFlag: (n) => (n === ENGINE_FLAG_NAME ? "agy" : undefined),
  });
  assert.equal(engineName, "agy");
  const tool = createEngineDetourToolDefinition({
    engineName: engineName!,
    fail(error) {
      throw error;
    },
  });
  assert.equal(tool.name, ENGINE_DETOUR_TOOL_NAME);
});
