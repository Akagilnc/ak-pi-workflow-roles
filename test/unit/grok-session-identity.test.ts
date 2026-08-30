import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DurablePrincipalAuthority } from "../../src/host-contracts.ts";
import { createGrokSessionIdentityAuthority } from "../../src/grok/session-identity.ts";

test("Grok ACP session binding persists through the durable-principal authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-session-"));
  try {
    const principal = {};
    const durable: DurablePrincipalAuthority = {
      issue: () => principal,
      async isAvailable() { return true; },
      decode(value) {
        assert.equal(value, principal);
        return { sessionDirectory: root, sessionFile: join(root, "session.jsonl") };
      },
    };
    await createGrokSessionIdentityAuthority(durable).bind(principal, "acp-s1");
    assert.equal(await createGrokSessionIdentityAuthority(durable).load(principal), "acp-s1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
