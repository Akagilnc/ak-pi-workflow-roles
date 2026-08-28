import { piDurablePrincipalAuthority, decodePiDurablePrincipal } from "../../src/pi/durable-principal.ts";
// #420 整改：自 test/unit/public-cli-fixer.test.ts 按性质移出（起真 Pi loader 子进程，
// 不属开发内环快档）。契约不变：Fixer 生产激活参数（initial/resume × apply）携带双可选
// 方法 Skill 到达真实 Pi loader。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runExplicitInternalActivation } from "../../src/public-cli/explicit-internal.ts";
import {
  buildFixerActivationExtraArgs,
  buildFixerResumeActivationExtraArgs,
} from "../../src/public-cli/fixer-run.ts";
import { admitFixerInvocation } from "../../src/public-cli/invocation.ts";
import {
  packageRoot,
  runPiSubprocess,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";

test("Fixer production activation args reach the real Pi loader for both optional methods", async () => {
  await withActivationHome({ prefix: "ak-fixer-method-trace-" }, async ({ home, agentDir }) => {
    const applyAdmitted = await admitFixerInvocation({ principalAuthority: piDurablePrincipalAuthority, home, cwd: home, phase: "apply", instruction: "Apply the approved repair.", attachmentPaths: [], createRunId: () => "run-fixer-method-trace-apply" });
    const rows = [
      { name: "initial-apply", args: buildFixerActivationExtraArgs(applyAdmitted, { principalAuthority: piDurablePrincipalAuthority, packageRoot }), sessionFile: decodePiDurablePrincipal(piDurablePrincipalAuthority, applyAdmitted.principal).sessionFile },
      { name: "resume-apply", args: buildFixerResumeActivationExtraArgs(applyAdmitted, { principalAuthority: piDurablePrincipalAuthority, packageRoot }), sessionFile: decodePiDurablePrincipal(piDurablePrincipalAuthority, applyAdmitted.principal).sessionFile },
    ];
    for (const row of rows) {
      const result = await runExplicitInternalActivation({
        packageRoot,
        cwd: home,
        home,
        agentDir,
        extraArgs: [
          "-e",
          join(packageRoot, "test", "fixtures", "fixer-dual-skill-availability-provider.ts"),
          "--provider",
          "ak-fixer-dual-skill-availability",
          "--model",
          "faux-1",
          ...row.args,
        ],
        runner: async (args, options) => {
          const subprocess = await runPiSubprocess([
            ...args,
            "--mode",
            "print",
            "--print",
            "/skill:diagnosing-bugs inspect the root cause",
            "--print",
            "/skill:tdd verify the repair",
          ], {
            cwd: options.cwd,
            env: options.env,
          });
          return {
            ...subprocess,
            timedOut: subprocess.localTimeout,
            args: [...args],
          };
        },
      });
      assert.equal(result.code, 0, `${row.name}: ${result.stderr}`);
      const sessionText = await readFile(row.sessionFile, "utf8");
      const userTexts = sessionText.split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } })
        .filter((entry) => entry.message?.role === "user")
        .map((entry) => entry.message?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "");
      assert.equal(userTexts.some((text) => text.includes('<skill name="diagnosing-bugs"')), true, row.name);
      assert.equal(userTexts.some((text) => text.includes('<skill name="tdd"')), true, row.name);
      assert.equal(userTexts[0]?.includes("<skill name="), false, row.name);
    }
  });
});
