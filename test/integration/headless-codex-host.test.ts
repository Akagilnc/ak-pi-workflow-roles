import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

/** Medium tracer: real process boundary, native new/resume protocol, and typed receipt. */
test("codex headless host binds and resumes a structured turn", async () => {
  const ledger = createTempPackageHomeLedger({ prefix: "ak-codex-host-", runName: "run@codex" });
  const root = ledger.runDirectory;
  const argvLog = join(root, "argv.log");
  const fakeBin = join(root, "fake-codex");
  await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0;
const thread = resumed ? args[resumeAt + 1] : "thread-fake-1";
const prompt = args.at(-1);
const events = [
  { type: "thread.started", thread_id: thread },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", report: resumed ? "resumed" : "initial" }) } },
  ...(prompt === "missing-terminal" ? [] : [{ type: "turn.completed" }]),
];
process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
`, "utf8");
  await chmod(fakeBin, 0o755);

  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    let bound: string | undefined;
    let receipt: unknown;
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: fakeBin,
      sessionIdentity: {
        async load() { return bound; },
        async bind(_principal, id) { bound = id; },
        resolveSessionFile: () => join(root, "session", "session.jsonl"),
      },
      prepare: async (request) => ({
        mcpServers: [{ name: "ak-probe", command: "/usr/bin/node", args: ["relay.mjs"] }],
        systemPrompt: { body: "system", materials: [] },
        prompt: request.continuation.prompt,
        jsonSchema: {
          type: "object",
          properties: { status: { type: "string" }, report: { type: "string" } },
          required: [],
          additionalProperties: true,
        },
        terminatingToolName: "ak_probe_output",
        async ingestStructuredOutput(value) { receipt = value; },
        async closeRound() { return { accepted: true as const }; },
      }),
    });
    const request: RoleTurnRequest = {
      principal: fixturePrincipal(join(root, "session")),
      activation: { role: "inspector" },
      methods: [],
      continuation: { kind: "initial", prompt: "work" },
      model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
      cwd: root,
      home: root,
      agentDir: join(root, "agent"),
      runDirectory: root,
    };

    const first = await host.executeTurn(request);
    assert.equal(first.knownFailure, undefined, JSON.stringify(first));
    assert.equal(bound, "thread-fake-1");
    assert.deepEqual(receipt, { status: "completed", report: "initial" });
    const schema = JSON.parse(await readFile(join(root, "headless-output-schema.json"), "utf8"));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["status", "report"]);

    receipt = undefined;
    const resumed = await host.executeTurn({
      ...request,
      continuation: { kind: "resume", prompt: "continue" },
    });
    assert.equal(resumed.knownFailure, undefined, JSON.stringify(resumed));
    assert.deepEqual(receipt, { status: "completed", report: "resumed" });
    const argv = (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(argv[1]!.slice(0, 4), ["exec", "--approve-for-me", "resume", "thread-fake-1"]);
    assert.ok(argv[1]!.includes("--output-schema"));
    assert.ok(argv[1]!.some((arg) => arg === "mcp_servers.ak-probe.required=true"));

    const failed = await host.executeTurn({
      ...request,
      continuation: { kind: "initial", prompt: "missing-terminal" },
    });
    assert.equal(failed.knownFailure?.identity?.code, "codex-missing-terminal-event");
  } finally {
    ledger.dispose();
  }
});
