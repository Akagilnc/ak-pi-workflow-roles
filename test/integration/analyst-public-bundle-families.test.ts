// #420 整改：自 test/contract/analyst-entry.test.ts 按性质移出（构建产物 + 起真子进程
// 跑公开 ak-role bin，不属开发内环快档）。契约不变：公开 bundle 从单一产物可达
// B1-B4 四个 metric family，且无 sibling family 目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const BOOK = "fixture-book";

type PageWithMetricFamilies = AnalystIssueMetricsPage & {
  readonly legWallClock?: AnalystLegWallClockSection;
  readonly b2FrameBucketsActions?: AnalystB2FrameBucketsActionsSection;
  readonly acceptanceSuccessRework?: AnalystAcceptanceSuccessReworkSection;
  readonly roundTimeline?: AnalystRoundTimelineSection;
  readonly gateCycles?: AnalystGateCyclesSection;
};

import {
  withBusinessRepo,
  withTempHome,
} from "../helpers/analyst-fixture-kit.ts";

/**
 * Public single-bundle regression: dist/public-cli/main.js must assemble B1–B4
 * plus #446 gate-cycles without a sibling analyst-metric-families/ directory
 * next to the bin.
 */
test("public ak-role bundle assembles B1-B4 + gate-cycles metric families without sibling family dir", async () => {
  const buildUrl = pathToFileURL(join(packageRoot, "scripts/build-package.mjs")).href;
  const { buildPublicAkRoleBin } = (await import(buildUrl)) as {
    buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
  };
  // Pin under /tmp (not os.tmpdir()): Linux CI tmpdir is /tmp, so a flat bin at
  // /tmp/<id>/main.js makes naive join(bin,"..","..") === "/" and host-pi link
  // attempts mkdir('/node_modules/...'). macOS os.tmpdir() is deeper and hides
  // that footgun; keep the CI shape locally (same pattern as host-pi-runtime).
  const binDir = await mkdtemp(join("/tmp", "analyst-bundle-bin-"));
  const binPath = join(binDir, "main.js");
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      try {
        const previousCwd = process.cwd();
        process.chdir(packageRoot);
        try {
          await buildPublicAkRoleBin(binPath);
        } finally {
          process.chdir(previousCwd);
        }
        // Prove the shipped layout has no sibling family tree next to the bin.
        await rm(join(binDir, "analyst-metric-families"), {
          recursive: true,
          force: true,
        });
        // #399: issue CLI is bare/--ticket from cwd book. Seed fixture runs under
        // packageRoot's git book key, then bare-call the public bundle.
        const { resolveBookKeyFromGit } = await import("../../src/activation-ledger-git.ts");
        const bookKey = resolveBookKeyFromGit(packageRoot);
        const srcBook = join(home, ".ak-roles", "books", BOOK);
        const dstBook = join(home, ".ak-roles", "books", bookKey);
        await cp(srcBook, dstBook, { recursive: true });
        const result = execFileSync(
          process.execPath,
          [binPath, "analyst"],
          {
            cwd: packageRoot,
            encoding: "utf8",
            env: { ...process.env, HOME: home },
          },
        );
        assert.match(result, /analyst-issue-metrics|"mode"\s*:\s*"issue"/);
        const pagePath = analystIssuePagePath(join(home, ".ak-roles"), { bookKey });
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
      }
    });
  });
});
