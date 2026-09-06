// #420 整改：自 test/contract/analyst-entry.test.ts 按性质移出（构建产物 + 起真子进程
// 跑公开 ak-role bin，不属开发内环快档）。契约不变：公开 bundle 从单一产物可达
// B1-B4 四个 metric family，且无 sibling family 目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import type {
  AnalystAcceptanceSuccessReworkSection,
} from "../../src/analyst-metric-families/acceptance-success-rework.ts";
import type {
  AnalystB2FrameBucketsActionsSection,
} from "../../src/analyst-metric-families/b2-frame-buckets-actions.ts";
import type {
  AnalystLegWallClockSection,
} from "../../src/analyst-metric-families/leg-wall-clock.ts";
import type {
  AnalystRoundTimelineSection,
} from "../../src/analyst-metric-families/round-timeline.ts";
import type {
  AnalystGateCyclesSection,
} from "../../src/analyst-metric-families/gate-cycles.ts";
import {
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
} from "../../src/analyst-page.ts";
import { fixtureHome, withBusinessRepo } from "../helpers/analyst-fixture-kit.ts";
import { machineLedgerHome, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTestUserProfileEnv } from "../helpers/public-cli-subprocess.ts";
import { isolatedTestProcessEnv } from "../helpers/test-process-fixtures.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const BOOK = "fixture-book";

type PageWithMetricFamilies = AnalystIssueMetricsPage & {
  readonly legWallClock?: AnalystLegWallClockSection;
  readonly b2FrameBucketsActions?: AnalystB2FrameBucketsActionsSection;
  readonly acceptanceSuccessRework?: AnalystAcceptanceSuccessReworkSection;
  readonly roundTimeline?: AnalystRoundTimelineSection;
  readonly gateCycles?: AnalystGateCyclesSection;
};

/**
 * Public single-bundle regression: dist/public-cli/main.js must assemble B1–B4
 * plus #446 gate-cycles without a sibling analyst-metric-families/ directory
 * next to the bin.
 *
 * #604: cold bin uses packageMachineHome (ignores process.env.HOME). Point a
 * temporary user profile at an explicit temp home via test-process preload so
 * books/config never enter the operator's real machine home.
 */
test("public ak-role bundle assembles B1-B4 + gate-cycles metric families without sibling family dir", async () => {
  const buildUrl = pathToFileURL(join(packageRoot, "scripts/build-package.mjs")).href;
  const { buildPublicAkRoleBin } = (await import(buildUrl)) as {
    buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
  };
  // Worktree-owned sibling roots: shallow bin path still outside package source tree.
  const binDir = await mkdtemp(worktreeTempPrefix("analyst-bundle-bin-"));
  const binPath = join(binDir, "main.js");
  const project = await mkdtemp(worktreeTempPrefix("analyst-bundle-cwd-"));
  const profileHome = await mkdtemp(worktreeTempPrefix("analyst-bundle-profile-"));
  await withBusinessRepo(async () => {
    try {
      const previousCwd = process.cwd();
      process.chdir(packageRoot);
      try {
        await buildPublicAkRoleBin(binPath);
      } finally {
        process.chdir(previousCwd);
      }
      // Prove the shipped layout has no sibling family tree next to the bin.

      seedGitRepository(project);
      const bookKey = basename(project);
      const ledgerHome = machineLedgerHome(profileHome);
      const srcBook = join(fixtureHome, "books", BOOK);
      const dstBook = join(ledgerHome, "books", bookKey);
      await cp(srcBook, dstBook, { recursive: true });

      const env = withTestUserProfileEnv(
        isolatedTestProcessEnv({ home: profileHome }),
        profileHome,
      );
      // Real bin execution; stdout is free presentation — contract is the typed page (ADR 0052).
      execFileSync(process.execPath, [binPath, "analyst"], {
        cwd: project,
        encoding: "utf8",
        env,
      });
      const pagePath = analystIssuePagePath(ledgerHome, { bookKey });
      const page = JSON.parse(await readFile(pagePath, "utf8")) as PageWithMetricFamilies;
      assert.ok(page.legWallClock, "B1 must be reachable from public bundle");
      assert.ok(page.b2FrameBucketsActions, "B2 must be reachable from public bundle");
      assert.ok(page.acceptanceSuccessRework, "B3 must be reachable from public bundle");
      assert.ok(page.roundTimeline, "B4 must be reachable from public bundle");
      assert.ok(page.gateCycles, "gate-cycles must be reachable from public bundle");
      assert.equal(page.legWallClock.kind, "analyst-leg-wall-clock");
      assert.equal(page.b2FrameBucketsActions.kind, "analyst-b2-frame-buckets-actions");
      assert.equal(page.acceptanceSuccessRework.kind, "analyst-acceptance-success-rework");
      assert.equal(page.roundTimeline.kind, "analyst-round-timeline");
      assert.equal(page.gateCycles.kind, "analyst-gate-cycles");
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
      await rm(profileHome, { recursive: true, force: true });
    }
  });
});
