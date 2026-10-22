# 测试跑在 Vitest 上：夹具、快照、假定时器、子进程用现成能力，不自造

Status: proposed（2026-10-22，源卷 d634a8d9，owner uuid `a75453ff-aacd-4e93-8722-bb30ea080057`「有轮子不用在那瞎搞？」、`fc7c2d87-2a0f-4222-819c-a2403477ef90`「先看合适不合适…迁移这种代价我觉得在架构合理性面前不算什么大理由」、`c0acd090-a646-44b5-a606-23b67d94d671`「那我觉得应该是B了。而且AI写代码自造轮子质量真的差啊。能有现成的最好」「2 1」、`a475d447-bdf3-48e6-a19a-18c72acc7f6d`「如果是必要的那就是选A／A／A…/to-tickets 的事情／A」）

## 决定

1. 测试运行器换成 **Vitest 5**（`vitest run`），三个 `projects` 对应现有目录：`unit`＋`contract`、`integration`、`package`；CI 跑全部。进程池用默认 `forks`。
2. 集成测试的公共前置（临时 git 仓、隔离 HOME／XDG、账本目录）由 **worker 作用域夹具**（`test.extend` 的 `scope: 'worker'`）建一次模板目录，每案 `fs.cp` 复制一份再跑；隔离 HOME 的环境变量照 `scripts/test-process-env.mjs` 现有定义迁入 `setupFiles`。
3. 子进程起停与结果用 **execa**；快照用 Vitest 的 `toMatchFileSnapshot`／行内快照，只对结构化产物（JSON、目录结构）用，自由文本改断字段；假定时器只用 `vi.useFakeTimers`。
4. 自写物随改动退役：`scripts/run-test-all.mjs`、`test/helpers/manual-scheduler.ts`、`snapshotAnalystDir`、`test-subprocess.ts`、`public-cli-subprocess.ts` 及只为它们活着的测试；`node:test` 入口脚本删除。夹具与宿主假件收成一个模块，不再按票各造一份。
5. 迁移按层分批（unit＋contract → integration → package），expand–contract：先装 Vitest 与 projects，各批独立提交、CI 绿，最后删旧入口。基线全量 727 案 45 秒（2026-10-22 实测），改完不许变慢。

## 为什么

- 自写 `test/helpers/` 30 个文件 4432 行，其中四类与平台能力重叠（假定时器两套并存、手造目录快照、自写调度、自写子进程终止分类）；集成测试 88 文件 45494 行，`mkdtemp` 100 处、`git init` 70 处，公共前置每案重建。病不是速度（45 秒）而是维护负担：每次清理都动几十个文件。
- `node:test`（Node 22）没有夹具 API，`--test-global-setup` 要 Node 24 且仍是早期特性；留它就得继续自写一层夹具。Vitest 5 原生有夹具（test／file／worker 作用域）、全局 setup、快照、假定时器、分片、覆盖率，TS 经 Vite 直跑；默认 forks 池，文档明说子进程重的套件用 forks。
- 同类项目：vite、vitest、changesets、typescript-eslint、hono、SvelteKit 用 Vitest；fastify、undici、Astro 用 node:test（Astro 迁入后靠把套件打包成大文件追回速度，失败定位变粗）；pnpm、yarn、prettier 用 Jest（ESM 仍标 experimental）。调研原文：`~/WorkSpace/vault/ak-cc-wiki/raw/ak-pi-workflow-roles/1244-test-runner-fitness-research-2026-10-22.md`、`1244-node-test-wheels-research-2026-10-22.md`。
- 先例：Ming #1960／ADR 0161（公共前置只建一次，重建核对用 Hypothesis、全量用 xdist）。

## Considered Options

- 留 `node:test`，自写一层薄夹具：少一个依赖，但夹具仍是自造，正是本仓反复出现的病；弃。
- Jest：ESM 支持仍 experimental，TS 要转译层；弃。
- `--experimental-test-isolation=none` 让所有文件同进程共享前置：文件并行降到 1，且是早期特性；弃。
- `globalSetup` 建一次模板、经 `provide/inject` 传路径：只能传可序列化值，全局一份要防并发写；弃，用 worker 作用域夹具。
- 一次性全迁：审不动，出错回不去；弃，按层分批。

## Consequences

- 新增 devDependencies：vitest、execa（版本与装法由施工定）；`package.json` 的 test 脚本改为 `vitest run` 与按 project 过滤。
- 席位表与真账本保护不变：隔离 HOME 的环境定义照搬，施工期间测试不碰 `~/.ak-roles/public-cli.json`（仓宪）。
- 夹具只有一个模块；新测试要前置就用它，不新造 helper——这是全局 #12／#14 与质量法已有的规矩，本 ADR 不另立法，只给落点。
- 「有轮子不自造」的执行漏在哪一席，由 #1237 的进口账给出，不在本 ADR 范围。
