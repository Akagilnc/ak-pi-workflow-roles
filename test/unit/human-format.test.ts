/**
 * Human-read formatting helpers (#162 人读格式助手).
 * Presentation only — machine values stay on data-* attributes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDurationZh,
  formatLocalDateTime,
  formatTokensCompact,
  formatUsdPrecise,
} from "../../src/human-format.ts";

test("formatDurationZh renders compact Chinese durations (two largest units)", () => {
  assert.equal(formatDurationZh(0), "0 秒");
  assert.equal(formatDurationZh(500), "0 秒");
  assert.equal(formatDurationZh(5000), "5 秒");
  assert.equal(formatDurationZh(60_000), "1 分");
  assert.equal(formatDurationZh(65_000), "1 分 5 秒");
  assert.equal(formatDurationZh(337_448), "5 分 37 秒");
  assert.equal(formatDurationZh(3_600_000), "1 小时");
  assert.equal(formatDurationZh(3_661_000), "1 小时 1 分");
  assert.equal(formatDurationZh(3_661_000 + 59_000), "1 小时 2 分");
  assert.equal(formatDurationZh(86_400_000), "1 天");
  assert.equal(formatDurationZh(90_061_000), "1 天 1 小时");
  assert.equal(formatDurationZh(172_800_000), "2 天");
  assert.equal(formatDurationZh(3 * 86_400_000 + 5 * 3_600_000 + 120_000), "3 天 5 小时");
  // Non-finite / negative input never fabricates a duration.
  assert.equal(formatDurationZh(-5), "0 秒");
  assert.equal(formatDurationZh(Number.NaN), "0 秒");
  assert.equal(formatDurationZh(Number.POSITIVE_INFINITY), "0 秒");
});

test("formatTokensCompact keeps small counts exact and compacts k/M", () => {
  assert.equal(formatTokensCompact(0), "0");
  assert.equal(formatTokensCompact(999), "999");
  assert.equal(formatTokensCompact(1000), "1k");
  assert.equal(formatTokensCompact(1650), "1.7k");
  assert.equal(formatTokensCompact(12_500), "12.5k");
  assert.equal(formatTokensCompact(999_900), "999.9k");
  assert.equal(formatTokensCompact(1_000_000), "1M");
  assert.equal(formatTokensCompact(1_500_000), "1.5M");
  assert.equal(formatTokensCompact(2_340_000), "2.3M");
  assert.equal(formatTokensCompact(Number.NaN), "0");
});

test("formatUsdPrecise keeps meaningful precision without trailing-zero noise", () => {
  assert.equal(formatUsdPrecise(0), "0");
  assert.equal(formatUsdPrecise(0.05), "0.05");
  assert.equal(formatUsdPrecise(0.8), "0.8");
  assert.equal(formatUsdPrecise(0.0001234), "0.0001234");
  assert.equal(formatUsdPrecise(1.65), "1.65");
  assert.equal(formatUsdPrecise(5), "5");
  assert.equal(formatUsdPrecise(5.01), "5.01");
  assert.equal(formatUsdPrecise(12.34), "12.34");
  assert.equal(formatUsdPrecise(123.4), "123");
  assert.equal(formatUsdPrecise(Number.NaN), "0");
  assert.equal(formatUsdPrecise(Number.POSITIVE_INFINITY), "0");
});

test("formatLocalDateTime renders the local wall clock of the instant", () => {
  const iso = "2026-08-05T12:00:00.000Z";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expected =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  assert.equal(formatLocalDateTime(iso), expected);
  assert.match(formatLocalDateTime(iso), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // Unparseable input passes through untouched (never invents a moment).
  assert.equal(formatLocalDateTime("not-a-date"), "not-a-date");
});
