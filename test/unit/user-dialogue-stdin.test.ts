/**
 * #879 typed stdin codec: survives wrapper trim; no FS.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  codexTurnArgs,
  headlessTurnArgs,
} from "../../src/headless-host/description.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import {
  encodeUserDialogueStdin,
  readUserDialogueStdin,
  USER_DIALOGUE_STDIN_KIND,
} from "../../src/user-dialogue-stdin.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

const BODY = JSON.stringify({
  status: "completed",
  report: "officer-peer-body",
  pad: "x".repeat(2048),
});

test("#879 typed stdin recovers original body after pipe trim", () => {
  const body = "  ruling with\nnewline  ";
  const encoded = encodeUserDialogueStdin(body);
  assert.equal(JSON.parse(encoded).kind, USER_DIALOGUE_STDIN_KIND);
  assert.equal(readUserDialogueStdin(encoded), body);
  assert.equal(readUserDialogueStdin(`  ${encoded}  \n`), body);
  assert.equal(readUserDialogueStdin(encoded.trim()), body);
});

test("#879 typed stdin keeps empty and flag-like opaque messages", () => {
  assert.equal(readUserDialogueStdin(encodeUserDialogueStdin("")), "");
  assert.equal(readUserDialogueStdin(encodeUserDialogueStdin("--")), "--");
  assert.equal(readUserDialogueStdin(encodeUserDialogueStdin("--model")), "--model");
});

test("#879 non-envelope text is unchanged, including officer JSON", () => {
  const officer = JSON.stringify({ status: "completed", report: "peer" });
  assert.equal(readUserDialogueStdin(officer), officer);
  assert.equal(readUserDialogueStdin("owner says proceed"), "owner says proceed");
  assert.equal(readUserDialogueStdin("  keep caller spaces  "), "  keep caller spaces  ");
});

test("#879 Pi turn argv projects ak-engine-model, not ak-engine", () => {
  const args = buildPiTurnExtraArgs(
    {
      principal: fixturePrincipal("/tmp/ak-879-engine-model/session"),
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "x" },
      engine: "cursor",
      engineModel: "cursor-grok-4.6-high-fast",
      cwd: "/tmp",
      home: "/tmp",
      agentDir: "/tmp/agent",
      runDirectory: "/tmp/ak-879-engine-model",
    },
    piDurablePrincipalAuthority,
  );
  const index = args.indexOf("--ak-engine-model");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "cursor-grok-4.6-high-fast");
  assert.equal(args.includes("--ak-engine"), false);
});

test("#879 Claude print argv keeps -p and omits the user body", () => {
  const description = lookupHeadlessHostDescription("claude");
  assert.ok(description && description.protocol === "claude-print");
  const argv = headlessTurnArgs({
    description,
    systemPromptPath: "/tmp/sys.txt",
    jsonSchema: { type: "object" },
    mcpConfigPath: "/tmp/mcp.json",
    session: { kind: "new", id: "sid" },
  });
  assert.ok(argv.includes("-p"));
  assert.equal(argv.includes(BODY), false);
});

test("#879 Codex exec argv asks stdin instead of embedding the user body", () => {
  const argv = codexTurnArgs({
    systemPromptPath: "/tmp/sys.txt",
    outputSchemaPath: "/tmp/out.json",
    mcpServers: [],
    session: { kind: "new" },
  });
  assert.equal(argv.includes(BODY), false);
  assert.deepEqual(argv.slice(-2), ["--", "-"]);
});
