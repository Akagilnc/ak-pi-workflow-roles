import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
} from "../src/collector-role.ts";
import {
  packageRoot,
  packIsolatedPackage,
  runPiSubprocess,
  withHermeticHome,
  withInProcessPi,
} from "./helpers/pi-test-harness.ts";

const exec = promisify(execFile);

test("npm pack includes collector modules, schema, and soul and excludes skills/orchestrator collect", async () => {
  await withHermeticHome({ prefix: "ak-collector-pack-" }, async ({ home }) => {
    const pack = await packIsolatedPackage(home);
    const paths = pack.files.map((file) => file.path);
    assert.ok(paths.includes("souls/collector.md"));
    assert.ok(paths.includes("schemas/collector-legs-v1.schema.json"));
    assert.ok(paths.includes("src/collector-role.ts"));
    assert.ok(paths.includes("src/collector-tool-schemas.ts"));
    assert.equal(paths.some((path) => /(^|\/)SKILL\.md$/.test(path)), false);
    assert.equal(paths.includes("souls/collect.md"), false);
    const archiveText = (await exec("tar", ["-xOf", pack.tarball], {
      maxBuffer: 5 * 1024 * 1024,
    })).stdout;
    assert.doesNotMatch(archiveText, /onlineCollect|ReviewCargo|souls\/collect\.md/);
    assert.doesNotMatch(archiveText, /Mysterious Name|Under 400 words|Feature Envy/);
  });
});

test("installed npm tarball collector runs default gh transport end-to-end in print and json", async () => {
  for (const mode of ["print", "json"] as const) {
    await withHermeticHome(
      { prefix: `ak-collector-install-${mode}-` },
      async ({ home }) => {
        const pack = await packIsolatedPackage(home);
        const tarball = pack.tarball;
        const consumer = resolve(home, "consumer");
        await mkdir(consumer, { recursive: true });
        await writeFile(
          resolve(consumer, "package.json"),
          JSON.stringify({
            private: true,
            dependencies: {
              "@ak/pi-workflow-roles": `file:${tarball}`,
              "@earendil-works/pi-ai": `file:${
                resolve(packageRoot, "node_modules/@earendil-works/pi-ai")
              }`,
              "@earendil-works/pi-coding-agent": `file:${
                resolve(
                  packageRoot,
                  "node_modules/@earendil-works/pi-coding-agent",
                )
              }`,
              typebox: `file:${resolve(packageRoot, "node_modules/typebox")}`,
            },
          }),
        );
        await exec("npm", [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ], {
          cwd: consumer,
          maxBuffer: 5 * 1024 * 1024,
        });

        const installedRoot = resolve(
          consumer,
          "node_modules/@ak/pi-workflow-roles",
        );
        const installedEntrypoint = resolve(
          installedRoot,
          "extensions/role-runtime.ts",
        );
        assert.notEqual(installedRoot, packageRoot);

        const legsPath = resolve(consumer, "legs.json");
        await writeFile(
          legsPath,
          `${JSON.stringify({
            version: 1,
            legs: [{
              id: "codex",
              expectedAuthors: ["codexbot"],
            }],
          }, null, 2)}\n`,
        );

        // Hermetic executable gh on PATH implementing observe surfaces.
        const binDir = resolve(consumer, "bin");
        await mkdir(binDir, { recursive: true });
        const ghPath = resolve(binDir, "gh");
        await writeFile(
          ghPath,
          `#!/usr/bin/env bash
set -euo pipefail
path=""; method="GET"; prev=""
for arg in "$@"; do
  if [[ "$prev" == "-X" ]]; then method="$arg"; fi
  if [[ "$arg" == /* ]]; then path="$arg"; fi
  prev="$arg"
done
http() { printf 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n%s' "$1"; }
if [[ "$path" == *"/user" ]]; then
  http '{"login":"collector-bot"}'; exit 0
fi
if [[ "$path" == *"/pulls/3"* && "$path" != *reviews* && "$path" != *comments* ]]; then
  http '{"number":3,"state":"open","head":{"sha":"deadbeef"},"html_url":"https://github.com/acme/widgets/pull/3","updated_at":"2024-01-01T00:00:00Z"}'; exit 0
fi
if [[ "$path" == *"/reviews"* ]]; then
  http '[{"id":7,"user":{"login":"codexbot"},"state":"APPROVED","body":"LGTM","commit_id":"deadbeef","submitted_at":"2020-01-01T00:00:00Z","html_url":"https://github.com/acme/widgets/pull/3#pullrequestreview-7"}]'; exit 0
fi
if [[ "$path" == *"/comments"* ]]; then
  http '[]'; exit 0
fi
echo "unexpected gh $*" >&2
exit 2
`,
          "utf8",
        );
        await chmod(ghPath, 0o755);

        const previousPath = process.env.PATH;
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        const agentDir = resolve(consumer, ".pi-agent");
        await mkdir(agentDir, { recursive: true });
        const faux = fauxProvider({
          api: `ak-collector-install-${mode}`,
          provider: `ak-collector-install-${mode}`,
          tokenSize: { min: 1000, max: 1000 },
        });
        const previousExit = process.exitCode;
        process.exitCode = undefined;
        try {
          await withInProcessPi({
            cwd: consumer,
            agentDir,
            faux,
            modelsPath: null,
            // Load only the installed packaged entrypoint (default transport).
            additionalExtensionPaths: [installedEntrypoint],
            noExtensions: true,
            systemPrompt: "BASE",
            mode,
            flags: {
              "ak-role": "collector",
              "ak-collector-repo": "acme/widgets",
              "ak-collector-pr": "3",
              "ak-collector-legs": legsPath,
            },
            noTools: "builtin",
          }, async ({ session, sessionManager, loader }) => {
            assert.deepEqual(loader.getExtensions().errors, []);
            faux.setResponses([
              fauxAssistantMessage(
                fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "obs" }),
                { stopReason: "toolUse" },
              ),
              (context) => {
                const prior = [...context.messages].reverse().find((message) =>
                  message.role === "toolResult"
                ) as {
                  details?: {
                    evidence?: Array<{ evidenceId: string; kind: string }>;
                  };
                } | undefined;
                const reviewId = prior?.details?.evidence?.find((item) =>
                  item.kind === "review"
                )?.evidenceId;
                assert.ok(reviewId, "packaged observe must return review evidence");
                return fauxAssistantMessage(
                  fauxToolCall(COLLECTOR_OUTPUT_TOOL, {
                    legs: [{
                      legId: "codex",
                      status: "valid",
                      rationale: "approved",
                      evidenceRefs: [reviewId],
                    }],
                  }, { id: "out" }),
                  { stopReason: "toolUse" },
                );
              },
            ]);
            await session.prompt("Start collection.");
            const output = [...sessionManager.getEntries()].reverse().find(
              (entry) =>
                entry.type === "message" &&
                (entry as any).message.role === "toolResult" &&
                (entry as any).message.toolName === COLLECTOR_OUTPUT_TOOL &&
                (entry as any).message.isError === false,
            );
            assert.ok(output, `packaged collector ${mode} must accept output`);
            const details = (output as { message: { details: any } }).message
              .details;
            assert.equal(details.host, "github.com");
            assert.equal(details.repository, "acme/widgets");
            assert.equal(details.prNumber, 3);
            assert.equal(details.targetHead, "deadbeef");
            assert.equal(details.legs[0].status, "valid");
            assert.ok(Array.isArray(details.snapshots));
            assert.ok(Array.isArray(details.evidenceRecords));
          });
        } finally {
          process.exitCode = previousExit;
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
        }
      },
    );
  }
});

test("packaged collector help documents fixed host launch profile flags", async () => {
  const result = await runPiSubprocess(
    [
      "--no-extensions",
      "-e",
      resolve(packageRoot, "extensions/role-runtime.ts"),
      "--help",
    ],
    { cwd: packageRoot },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ak-collector-repo/);
  assert.match(result.stdout, /ak-collector-pr/);
  assert.match(result.stdout, /ak-collector-legs/);
  assert.match(result.stdout, /collector/);
  // Categorical Skill forbid + supported profile text (not mere flag names).
  assert.match(result.stdout, /forbids every Skill/i);
  assert.match(result.stdout, /command-only/i);
  assert.match(result.stdout, /--no-skills/);
  assert.match(result.stdout, /--no-extensions/);
  assert.match(result.stdout, /Collector package extension/i);
  assert.match(result.stdout, /prompt templates/i);
  assert.match(result.stdout, /context files/i);
  assert.match(result.stdout, /print\/JSON prompt/i);
  assert.match(result.stdout, /late hostile sibling-extension/i);
  assert.match(result.stdout, /not a security boundary/i);
});
