#!/usr/bin/env node
// 给本地安装的 @earendil-works/pi-ai 打开 codex 的 priority（fast）服务档。
//
// 为什么需要它：pi-ai 的 codex 请求体只有在 `options.serviceTier` 有值时才写
// `service_tier`，而 pi-coding-agent 侧没有任何地方传这个参数（全仓 grep 零命中），
// 于是 codex 调用永远走 default 档。官方目前不提供开关，只能改文件。
//
// 为什么做成 postinstall：pi 是本仓的 dev/peer 依赖，每个 worktree `npm i` 都会
// 装一套自己的 node_modules，手工补丁会随每次安装静默失效——而失效不会报错，
// 表现只是「腿悄悄跑回默认档」。挂在 postinstall 上才能自愈。
//
// 手动跑：node scripts/patch-pi-fast.mjs
// 核验：  grep -rl ak-patch:pi-fast node_modules --include=openai-codex-responses.js

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "ak-patch:pi-fast";
const TARGET = "openai-codex-responses.js";

// 「已生效」的判据是这行赋值本身，不是上面的注释——注释可以被别的补丁写法换掉，
// 行为不能。用注释当判据会把已生效的文件误报成未处理。
const EFFECT = `body.service_tier = options?.serviceTier ?? "priority"`;

const ANCHOR = `    if (options?.serviceTier !== undefined) {
        body.service_tier = options.serviceTier;
    }`;

const REPLACEMENT = `    // ${MARKER} — 见 scripts/patch-pi-fast.mjs。
    // 上游只在 serviceTier 有值时才写 service_tier，而 pi-coding-agent 侧从不传它，
    // 故 codex 调用永远走 default 档。这里把默认值改成 priority；显式传值仍可覆盖。
    body.service_tier = options?.serviceTier ?? "priority";`;

/** 收集 node_modules 下所有 pi-ai 的 codex 请求构造文件。 */
function collect(dir, out, depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, out, depth + 1);
    } else if (entry.isFile() && entry.name === TARGET && full.includes("pi-ai")) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  let root;
  try {
    root = statSync("node_modules").isDirectory() ? "node_modules" : null;
  } catch {
    root = null;
  }
  if (!root) return;

  const files = collect(root, []);
  let patched = 0;
  let already = 0;
  const skipped = [];

  for (const file of files) {
    const before = readFileSync(file, "utf8");
    if (before.includes(EFFECT)) {
      already += 1;
      continue;
    }
    // 锚点必须唯一命中：上游改了这段代码就停手并报告，绝不猜着改。
    const hits = before.split(ANCHOR).length - 1;
    if (hits !== 1) {
      skipped.push(`${file} (锚点命中 ${hits} 次)`);
      continue;
    }
    writeFileSync(file, before.replace(ANCHOR, REPLACEMENT));
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      patched += 1;
    } catch {
      writeFileSync(file, before);
      skipped.push(`${file} (语法自检失败，已还原)`);
    }
  }

  if (patched > 0 || skipped.length > 0) {
    console.log(`[pi-fast] codex priority 档：本次打上 ${patched} · 原已有 ${already} · 未处理 ${skipped.length}`);
  }
  for (const note of skipped) {
    console.log(`[pi-fast] 未处理 ${note}`);
  }
  if (skipped.length > 0) {
    console.log("[pi-fast] 上游代码可能已变；请核对 scripts/patch-pi-fast.mjs 的锚点。");
  }
}

// 安装期脚本不得让 npm i 失败：无论发生什么都以 0 退出。
try {
  main();
} catch (error) {
  console.log(`[pi-fast] 跳过：${error instanceof Error ? error.message : String(error)}`);
}
