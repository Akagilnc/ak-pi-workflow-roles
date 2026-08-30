/**
 * #319 Batch 2 (M2): Collector-unique deep chain only
 * (cold-installed default gh transport → accepted receipt).
 * All-role cold smoke lives in public-cli-cold-matrix.test.ts.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { COLLECTOR_OBSERVE_TOOL, COLLECTOR_OUTPUT_TOOL } from "../../src/collector-role.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import {
  packageRoot,
  seedGitRepository,
  withColdInstalledPackage,
  withHermeticHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

test("cold-installed npm package uses its default gh transport to produce a Collector receipt", { timeout: 120_000 }, async () => {
  await withHermeticHome({ prefix: "ak-collector-package-" }, async ({ home }) => {
    await withColdInstalledPackage(home, async ({ fixture, installedRoot }) => {
      seedGitRepository(fixture);
      const binDir = resolve(fixture, "bin");
      await mkdir(binDir, { recursive: true });
      const gh = resolve(binDir, "gh");
      await writeFile(gh, `#!/usr/bin/env node
const args=process.argv.slice(2); const path=args.filter(a=>a.startsWith('/')).at(-1)||'';
function ok(body){process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body));}
if(path.endsWith('/user')) ok({login:'collector'});
else if(path.includes('/pulls/3') && !path.includes('/reviews') && !path.includes('/comments')) ok({number:3,state:'open',head:{sha:'deadbeef'},updated_at:'2024-01-01T00:00:00Z',html_url:'https://github.com/acme/widgets/pull/3'});
else if(path.includes('/reviews')) ok([{id:7,user:{login:'review-app[bot]',type:'Bot',id:77},state:'APPROVED',body:'LGTM',commit_id:'deadbeef',submitted_at:'2024-01-01T00:01:00Z',html_url:'https://github.com/acme/widgets/pull/3#pullrequestreview-7'}]);
else if(path.includes('/comments') || path.includes('/reactions')) ok([]); else process.exit(2);
`, "utf8");
      await chmod(gh, 0o755);

      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      const agentDir = resolve(fixture, ".pi-agent");
      await mkdir(agentDir, { recursive: true });
      // #443: collector session materials via installed package default wiring.
      const collectorSoul = [
        await readFile(resolve(installedRoot, "CLAUDE.md"), "utf8"),
        await readFile(resolve(installedRoot, "souls/collector.md"), "utf8"),
      ].join("\n\n").trim();
      const faux = fauxProvider({ api: "collector-cold-install", provider: "collector-cold-install", tokenSize: { min: 1000, max: 1000 } });
      let collectorContext: Context | undefined;
      faux.setResponses([
        (context: Context) => {
          collectorContext = context;
          return fauxAssistantMessage(fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe" }), { stopReason: "toolUse" });
        },
        fauxAssistantMessage(fauxToolCall(COLLECTOR_OUTPUT_TOOL, {}, { id: "output" }), { stopReason: "toolUse" }),
      ]);
      try {
        await withInProcessPi({
          activationLedgerSession: true, cwd: fixture, agentDir, faux, modelsPath: null,
          additionalExtensionPaths: [resolve(installedRoot, "extensions/role-runtime.ts")],
          noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
          flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "3" },
        }, async ({ session, sessionManager, loader }) => {
          assert.deepEqual(loader.getExtensions().errors, []);
          await session.prompt("Collect.");
          assert.ok(collectorContext);
          assert.ok(
            collectorContext.systemPrompt?.includes(
              `<collector_soul>\n${collectorSoul}\n</collector_soul>`,
            ),
            "provider receives constitution + collector soul from pack default wiring",
          );
          // Source-tree oracle must match installed bytes for this material class.
          assert.equal(
            collectorSoul,
            [
              await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8"),
              await readFile(resolve(packageRoot, "souls/collector.md"), "utf8"),
            ].join("\n\n").trim(),
          );
          const output = [...sessionManager.getEntries()].reverse().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL && entry.message.isError === false) as any;
          assert.ok(output, "installed Collector must accept its receipt");
          assert.deepEqual(output.message.details, { submissionDisposition: "pending-round-closure" });
          const headerId = sessionManager.getHeader?.()?.id;
          assert.ok(headerId);
          const sealed = await readSealedSubmission(fixture, headerId);
          assert.ok(sealed, "installed Collector must seal its receipt");
          const receipt = sealed.decisiveFacts as any;
          assert.equal(receipt.repository, "acme/widgets");
          assert.equal(receipt.targetHead, "deadbeef");
          assert.equal(receipt.groups.length, 1);
          assert.equal(receipt.groups[0].identity.userId, 77);
        });
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      }
    });
  });
});
