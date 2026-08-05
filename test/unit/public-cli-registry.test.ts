import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CLI_SUPPORT_COMMANDS,
  PUBLIC_CONFIGURABLE_SEATS,
  listHelpCapabilities,
  publicStartupCandidates,
} from "../../src/public-cli/registry.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";

test("public registry exposes seven callable roles plus automatic Navigator only", () => {
  assert.deepEqual(
    [...PUBLIC_CALLABLE_ROLES],
    PACKAGED_ROLE_REGISTRY.map((entry) => entry.role),
  );
  assert.equal(PUBLIC_CALLABLE_ROLES.length, 7);
  assert.deepEqual(
    [...PUBLIC_CONFIGURABLE_SEATS],
    [...PUBLIC_CALLABLE_ROLES, "navigator"],
  );
  assert.equal(
    PUBLIC_CONFIGURABLE_SEATS.includes("navigator" as never),
    true,
  );
  for (const forbidden of ["auditor", "soul-audit", "reviewer-cmr", "sitian", "assisted"]) {
    assert.equal(
      (PUBLIC_CONFIGURABLE_SEATS as readonly string[]).includes(forbidden),
      false,
      `must not expose ${forbidden}`,
    );
  }
});

test("help capabilities derive from typed public registry facts", () => {
  const capabilities = listHelpCapabilities();
  const names = capabilities.map((cap) => cap.name);
  for (const command of PUBLIC_CLI_SUPPORT_COMMANDS) {
    assert.equal(names.includes(command), true, `support command ${command}`);
  }
  for (const role of PUBLIC_CALLABLE_ROLES) {
    assert.equal(names.includes(role), true, `callable role ${role}`);
  }
  assert.equal(
    (names as readonly string[]).includes("navigator"),
    false,
    "navigator is automatic, not a callable command",
  );
  const rolesCap = capabilities.find((cap) => cap.name === "roles");
  assert.equal(rolesCap?.kind, "support");
  const judgeCap = capabilities.find((cap) => cap.kind === "role" && cap.name === "judge");
  assert.equal(judgeCap?.kind, "role");
  assert.ok(judgeCap && judgeCap.kind === "role");
  assert.deepEqual(judgeCap.phases, [null]);
  const fixerCap = capabilities.find((cap) => cap.kind === "role" && cap.name === "fixer");
  assert.ok(fixerCap && fixerCap.kind === "role");
  assert.deepEqual(fixerCap.phases, ["plan", "apply"]);
  assert.equal(fixerCap.defaultPhase, "apply");
});

test("startup model candidates follow #11 package defaults per seat", () => {
  assert.deepEqual(publicStartupCandidates("judge"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  assert.deepEqual(publicStartupCandidates("reviewer"), [
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  assert.deepEqual(publicStartupCandidates("navigator"), [
    { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium" },
    { provider: "xai", model: "grok-4.5", thinking: "high" },
  ]);
  for (const seat of ["coder", "fixer", "collector", "doctor", "merger"] as const) {
    assert.deepEqual(publicStartupCandidates(seat), [
      { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      { provider: "xai", model: "grok-4.5", thinking: "high" },
    ]);
  }
});
