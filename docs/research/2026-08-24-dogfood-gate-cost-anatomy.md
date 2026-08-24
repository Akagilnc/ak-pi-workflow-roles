# 2026-08-24 dogfood 日票庭/复核时长解剖（#446 首单）

> OWNER 2026-08-24：「本指标族建成后的第一单分析任务＝解剖 2026-08-24 dogfood 日全部票庭/复核 run 的时长构成」。
> 本报告只消费 Analyst 已交付指标族（gate-cycles / leg-wall-clock / b2-frame-buckets-actions）与 sole-scan 保留的 toolIntervals；不新增生产扫描或写端。

## 取数口径（闭合）

| 项 | 值 |
| --- | --- |
| asOf（冻结时刻） | `2026-08-24T19:05:29.190Z` |
| 时区 | UTC |
| 日历日标签 | `2026-08-24` |
| 日历日窗 | `[2026-08-24T00:00:00.000Z, 2026-08-25T00:00:00.000Z)` |
| **本报告观测窗（已闭合）** | `[2026-08-24T00:00:00.000Z, 2026-08-24T19:05:29.190Z)` |
| 全日是否在 asOf 已结束 | **否**（asOf 距 UTC 日终尚余约 4h54m；故不用未闭合的全日，只用 asOf 截断的闭合观测窗） |
| 入总体判据 | 候簿 `books/*/runs/<runId>@<role>` 目录存在，且 runId UUIDv7 嵌入时间 ∈ 观测窗，且 `role ∈ {judge, reviewer}` |
| 簿 | 观测窗内实际出现票庭/复核腿的簿：`ak-pi-workflow-roles`、`Ming_LLM` |
| 指标入口 | 目录总体对账后，仅对 **readable** 子集跑 `scanAnalystIssueRuns({ bookKey })` → metric family `contribute`（gate-cycles / leg-wall-clock / b2-frame-buckets-actions） |
| 全量测试调用 | readable 腿 `toolIntervals` 中 bash.`command` 匹配 `npm/pnpm/yarn … test(:all)?`，墙钟取 interval span |
| 官取证 bash 次数 | `session/auditor-roles/*` 中出现官终局工具的卷内 `"toolName":"bash"` 计数（特征观察，非契约锁措辞） |

**「全部」的定义**：观测窗内候簿目录总体，不是「Analyst 已接纳腿」的同义反复。进入指标汇总的只有 readable；其余类别逐 runId 列排除理由，总数守恒。

## 目录总体对账（互斥类别）

先枚举观测窗内全部 judge/reviewer 目录，再与 sole-scan 投影对账。类别互斥、穷尽：

| 类别 | 定义 | 数 |
| --- | --- | ---: |
| **directoryTotal** | 观测窗内 judge/reviewer 目录 | **302** |
| readable | sole-scan 接纳为可读腿，进入指标 | 298 |
| unreadable | sole-scan 响亮排除（缺/坏 required source） | 0 |
| live | `run-state ∈ {admitted, running, resumable}`；sole-scan 合同省略（非死亡） | 3 |
| missing_invocation | 无 `invocation.json`，sole-scan 无法圈定 scope | 1 |
| corrupt_invocation | `invocation.json` 损坏/无 projectRoot | 0 |
| stale_unprojected | 有 invocation、非 live，但 asOf 时仍未落入 readable/unreadable | 0 |

**守恒**：

```
302 = 298 (readable) + 0 (unreadable) + 3 (live) + 1 (missing_invocation) + 0 (corrupt_invocation) + 0 (stale_unprojected)
```

| 维 | 目录总体 | readable 子集 |
| --- | ---: | ---: |
| judge | 270 | 267 |
| reviewer | 32 | 31 |
| ak-pi-workflow-roles | 34 | （见排除表） |
| Ming_LLM | 268 | （见排除表） |

### 未进入 Analyst 指标的 runId（逐项）

| runId | role | book | 类别 | 排除理由 |
| --- | --- | --- | --- | --- |
| `01a031a6-721f-766b-88ba-340581a0880e` | judge | ak-pi-workflow-roles | live | `run-state=running`（live in-flight；sole-scan 省略） |
| `01a0328f-8742-73cc-9b47-0d525ee25e2f` | reviewer | Ming_LLM | live | `run-state=running`（live in-flight；sole-scan 省略） |
| `01a03316-4aa1-76c2-8b07-4afe5d8114e8` | judge | Ming_LLM | missing_invocation | `invocation.json` 缺席；sole-scan 无法 scope |
| `01a03525-ed2f-7142-8d55-3a93aee045e9` | judge | Ming_LLM | live | `run-state=running`（live in-flight；sole-scan 省略） |

排除合计 **4**；与 `302 − 298 = 4` 一致。

## 指标汇总（readable = 298，asOf 重算）

| 项 | 值 |
| --- | ---: |
| 可读票庭/复核腿 | 298 |
| 其中 judge | 267 |
| 其中 reviewer | 31 |
| unreadable（观测窗） | 0 |
| 闸循环总轮数（paired） | 122 |
| 官耗时合计 | 197.22m |
| 腿墙钟合计 | 2746.73m |
| 两桶·工具合计 | 1187.10m（43.2%） |
| 两桶·模型合计 | 1559.63m（56.8%） |
| 父腿全量/测试 bash 次数 | 40 |
| 父腿全量/测试 bash 墙钟合计 | 30.08m |
| 其中 test:all 次数 | 11 |
| test:all 次均墙钟 | 2.29m |

### 按官（gate-cycles.byOfficer）

| officer | rounds | bounce | pass | bounceRate | meanOfficerWall |
| --- | ---: | ---: | ---: | ---: | ---: |
| notary | 122 | 64 | 58 | 0.525 | 1.62m |

### 闸循环最多的腿（top 15）

| rounds | officerWallΣ | role | book | runId |
| ---: | ---: | --- | --- | --- |
| 14 | 30.18m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 13 | 16.69m | judge | ak-pi-workflow-roles | `01a031bd-7a9a-79ec-aed3-e340bf46c419` |
| 12 | 17.72m | judge | ak-pi-workflow-roles | `01a034ad-ee17-7896-9c37-88792b95d785` |
| 9 | 16.65m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 7 | 11.41m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` |
| 7 | 10.20m | judge | ak-pi-workflow-roles | `01a031ff-92c5-78e8-ad25-7ca0d346dd8b` |
| 7 | 9.65m | judge | ak-pi-workflow-roles | `01a031e1-31c9-79b5-b9ef-cda423cc48ea` |
| 6 | 11.01m | judge | ak-pi-workflow-roles | `01a032f6-0b0d-7a6f-8f5f-64bb5937d610` |
| 5 | 13.64m | judge | ak-pi-workflow-roles | `01a0322e-d065-7d9b-a247-bd279f137934` |
| 5 | 6.81m | judge | ak-pi-workflow-roles | `01a03466-3604-7cd3-8b5c-cef73c3610d0` |
| 4 | 9.24m | judge | ak-pi-workflow-roles | `01a033f6-8225-7bde-b1c6-7c87524870be` |
| 4 | 4.19m | judge | ak-pi-workflow-roles | `01a0340f-9bca-7095-af4c-99d8bf57b41a` |
| 3 | 4.71m | judge | ak-pi-workflow-roles | `01a033b2-4a31-77cf-b308-b4a241ce26bb` |
| 3 | 4.34m | judge | Ming_LLM | `01a03515-c20a-7d36-baa6-bcccc5dd27f3` |
| 2 | 4.85m | judge | ak-pi-workflow-roles | `01a03254-06a1-762b-b906-0a8eb62ce62f` |

### 腿墙钟 top 10（leg-wall-clock）

| wall | role | book | runId |
| ---: | --- | --- | --- |
| 66.57m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 66.02m | reviewer | Ming_LLM | `01a03276-03a4-7cf2-9a93-648893700094` |
| 48.43m | judge | ak-pi-workflow-roles | `01a034ad-ee17-7896-9c37-88792b95d785` |
| 45.54m | judge | Ming_LLM | `01a03336-164e-77d5-bbc6-6e83c402c9d0` |
| 42.98m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 41.13m | judge | Ming_LLM | `01a03334-0ab4-7db6-bf30-dd6f763c0b60` |
| 38.47m | judge | Ming_LLM | `01a03334-619a-7207-8bf6-ebac709f2fbd` |
| 36.33m | judge | ak-pi-workflow-roles | `01a031bd-7a9a-79ec-aed3-e340bf46c419` |
| 31.91m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` |
| 29.47m | judge | ak-pi-workflow-roles | `01a031e1-31c9-79b5-b9ef-cda423cc48ea` |

### 父腿全量/测试 bash（test:all / npm test）

| wall | role | book | runId | command |
| ---: | --- | --- | --- | --- |
| 2.92m | judge | ak-pi-workflow-roles | `01a03513-e21a-7641-926d-83c0140c4e0a` | `npm run test:all` |
| 2.48m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` | `npm run test:all` |
| 2.40m | judge | ak-pi-workflow-roles | `01a032e6-5d99-76ac-be62-d55459a0ef0e` | `npm run test:all` |
| 2.38m | judge | ak-pi-workflow-roles | `01a03492-582a-7510-9b84-a5e498b243d8` | `npm run test:all` |
| 2.37m | judge | ak-pi-workflow-roles | `01a034ad-ee17-7896-9c37-88792b95d785` | `npm run test:all` |
| 2.36m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` | `npm run test:all` |
| 2.33m | judge | ak-pi-workflow-roles | `01a033f6-8225-7bde-b1c6-7c87524870be` | `npm run test:all` |
| 2.31m | judge | ak-pi-workflow-roles | `01a033b2-4a31-77cf-b308-b4a241ce26bb` | `pnpm run test:all` |
| 2.29m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` | `npm run test:all` |
| 2.28m | judge | ak-pi-workflow-roles | `01a03466-3604-7cd3-8b5c-cef73c3610d0` | `npm run test:all` |
| 1.05m | judge | ak-pi-workflow-roles | `01a034f1-75bf-71a6-bcf5-d1299145b1a5` | `npm run test:all` |
| 54.3s | reviewer | Ming_LLM | `01a0343c-4e0a-7028-aad8-e5ba5df5c820` | `if [ -f web/package.json ]; then cd web && npm test -- --run; else echo no-web-package; fi` |
| 39.6s | reviewer | Ming_LLM | `01a0348b-9046-7e5d-a5d2-f597ce0c7509` | `cd /private/tmp/ming-w5-321/web && npm test` |
| 39.6s | judge | Ming_LLM | `01a0348e-f43a-7677-8ccb-61b3846d0c2d` | `cd web && npm test -- --run` |
| 37.2s | judge | Ming_LLM | `01a03486-725f-7e31-8f03-ac3d4f5cac3c` | `cd web && npm test -- --run src/chatFailures.test.ts && npm run build` |
| 32.5s | judge | Ming_LLM | `01a03478-e51a-753a-b580-1a346dafaf6f` | `cd web && npm test -- --run src/chatFailures.test.ts` |
| 9.8s | judge | Ming_LLM | `01a03445-aaed-7a41-a4ea-28938443223b` | `if [ -d web/node_modules ]; then cd web && npm test -- --run && npm run build; else echo 'NO_WEB_NODE_MODULES'; fi` |
| 7.8s | reviewer | Ming_LLM | `01a0325f-063e-7eb5-86c0-5b52a1c1c342` | `cd web && npm test -- --run` |
| 7.3s | judge | Ming_LLM | `01a0349b-1787-7125-a888-a6e084727466` | `cd web && npm test -- --run src/format.test.ts src/components/drawers.test.tsx src/components/map.test.tsx src/appDurableWiring.test.tsx && npm run build` |
| 7.0s | judge | Ming_LLM | `01a0346b-6a3f-78ff-812a-a4c6b893a38e` | `cd web && npm test` |
| 7.0s | judge | Ming_LLM | `01a03463-3210-76a5-b6c3-4a25bf241ac8` | `cd web && npm test` |
| 6.6s | judge | Ming_LLM | `01a03450-d82f-7391-a0f7-ecf4c550a44c` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx` |
| 5.2s | judge | Ming_LLM | `01a03440-589b-7bd9-b6d9-e574201de3ae` | `cd web && if [ -d node_modules ]; then npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx && npm run build; else echo 'NO_NODE_MOD...` |
| 5.2s | reviewer | Ming_LLM | `01a03439-5fb3-793b-89b0-435dde07c68d` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx && npm run build` |
| 4.6s | judge | Ming_LLM | `01a034af-78d4-710b-b90e-0859fcd8509c` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx src/format.test.ts && npm run build` |
| 4.3s | reviewer | Ming_LLM | `01a03474-9a72-7fe2-9e77-a8aa00c0aa05` | `cd /private/tmp/ming-w5-321/web && npm test -- --run src/format.test.ts src/components/drawers.test.tsx src/components/map.test.tsx src/appDurableWiring.test...` |
| 4.0s | reviewer | Ming_LLM | `01a0348b-9046-7e5d-a5d2-f597ce0c7509` | `cd /private/tmp/ming-w5-321/web && npm test -- --run src/format.test.ts src/components/drawers.test.tsx src/components/map.test.tsx src/appDurableWiring.test...` |
| 3.9s | judge | Ming_LLM | `01a03266-7502-76cc-9bee-d4ad851be1a4` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx` |
| 3.9s | judge | Ming_LLM | `01a03463-3210-76a5-b6c3-4a25bf241ac8` | `cd web && npm test -- --run src/format.test.ts src/components/drawers.test.tsx src/components/map.test.tsx` |
| 3.3s | reviewer | Ming_LLM | `01a034b7-0eea-74f1-9b26-50048355816d` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx src/appDurableWiring.test.tsx` |
| 2.8s | judge | Ming_LLM | `01a03486-725f-7e31-8f03-ac3d4f5cac3c` | `cd web && node -e "console.log(require('./package.json').scripts)" && npm test -- --run web/src/chatFailures.test.ts` |
| 2.6s | judge | Ming_LLM | `01a03458-afa3-7dd8-84c8-e5fd2ce193a1` | `cd web && npm test -- --run src/components/map.test.tsx src/components/drawers.test.tsx` |
| 1.8s | reviewer | Ming_LLM | `01a0325f-063e-7eb5-86c0-5b52a1c1c342` | `npm test -- --run && npm run build` |
| 1.5s | reviewer | Ming_LLM | `01a034dd-a52b-70ee-97f8-8eb518fcf988` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx` |
| 1.4s | reviewer | Ming_LLM | `01a034e7-55f0-749f-b42a-f3bebbbbf459` | `cd web && npm test -- --run src/components/decisionModal.test.tsx` |
| 1.1s | judge | Ming_LLM | `01a034d8-f263-7a17-ad59-d63901d439b4` | `npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx` |
| 751ms | judge | Ming_LLM | `01a034d8-f263-7a17-ad59-d63901d439b4` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx; rc=$?; cd ..; printf '\nSTATUS\n'; git status --short --branch; exit...` |
| 122ms | reviewer | Ming_LLM | `01a034dd-a52b-70ee-97f8-8eb518fcf988` | `npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx` |
| 99ms | reviewer | Ming_LLM | `01a03474-9a72-7fe2-9e77-a8aa00c0aa05` | `npm test -- --run src/format.test.ts src/components/drawers.test.tsx src/components/map.test.tsx src/appDurableWiring.test.tsx` |
| 95ms | reviewer | Ming_LLM | `01a0348b-9046-7e5d-a5d2-f597ce0c7509` | `npm test -- --run src/format.test.ts src/components/drawers.test.tsx src/components/map.test.tsx src/appDurableWiring.test.tsx` |

### 官卷 bash 取证密度（样本：闸轮最多的最多 30 腿）

| mean bash/round | rounds | bashΣ | role | runId |
| ---: | ---: | ---: | --- | --- |
| 24.0 | 1 | 24 | judge | `01a032e6-5d99-76ac-be62-d55459a0ef0e` |
| 23.2 | 5 | 116 | judge | `01a0322e-d065-7d9b-a247-bd279f137934` |
| 22.0 | 4 | 88 | judge | `01a033f6-8225-7bde-b1c6-7c87524870be` |
| 22.0 | 1 | 22 | judge | `01a03513-e21a-7641-926d-83c0140c4e0a` |
| 16.0 | 1 | 16 | judge | `01a0331c-de96-711c-a4cf-207ab2a4a4ec` |
| 15.2 | 9 | 137 | judge | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 15.0 | 2 | 30 | judge | `01a0335f-b56a-7914-94c3-dbac27878c84` |
| 14.4 | 7 | 101 | judge | `01a031ff-92c5-78e8-ad25-7ca0d346dd8b` |
| 14.4 | 5 | 72 | judge | `01a03466-3604-7cd3-8b5c-cef73c3610d0` |
| 14.3 | 3 | 43 | judge | `01a033b2-4a31-77cf-b308-b4a241ce26bb` |
| 14.3 | 7 | 100 | judge | `01a031e1-31c9-79b5-b9ef-cda423cc48ea` |
| 13.8 | 6 | 83 | judge | `01a032f6-0b0d-7a6f-8f5f-64bb5937d610` |
| 13.5 | 2 | 27 | judge | `01a03254-06a1-762b-b906-0a8eb62ce62f` |
| 12.6 | 14 | 177 | judge | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 12.5 | 2 | 25 | judge | `01a0351c-6715-7bf6-a9b3-51af00659756` |

样本均值 mean-bash/round = **12.8**（n=30 腿）。

## 焦点账：为何一单会到 ~20 分钟

样本腿（#440 调查点名的 7 轮闸循环 run）：`01a031ff-92c5-78e8-ad25-7ca0d346dd8b@judge`。

| 构成 | 值 | 占腿墙钟 |
| --- | ---: | ---: |
| 腿墙钟（leg-wall-clock） | 19.71m | 100% |
| 两桶·工具 | 14.77m | 75.0% |
| 两桶·模型 | 4.93m | 25.0% |
| 闸循环轮数 | 7 | — |
| 官耗时 Σ（gate-cycles） | 10.20m | 51.8% |
| 父腿 test suite bash Σ | 0ms（0 次） | 0.0% |
| 官卷 bash 次数 Σ / 轮均 | 101 / 14.4 | — |

### 逐轮闸循环

| round | officer | status | officerWall | findingsCount |
| ---: | --- | --- | ---: | ---: |
| 1 | notary | bounce | 1.42m | 3 |
| 2 | notary | bounce | 59.6s | 1 |
| 3 | notary | bounce | 1.08m | 1 |
| 4 | notary | bounce | 1.65m | 1 |
| 5 | notary | pass | 1.33m | 0 |
| 6 | notary | bounce | 2.24m | 1 |
| 7 | notary | pass | 1.49m | 0 |

### 逐轮官 bash 次数（与上表 round 序未必一一，按官卷时间序）

| officerVolume# | bashCount |
| ---: | ---: |
| 1 | 19 |
| 2 | 14 |
| 3 | 8 |
| 4 | 11 |
| 5 | 10 |
| 6 | 22 |
| 7 | 17 |

### 归因（可核账）

1. **闸循环本身是主放大器**：7 轮 paired 官会话，官耗时合计 10.20m，约占腿墙钟 51.8%。bounce×5 / pass×2。
2. **两桶**：工具桶 14.77m vs 模型桶 4.93m——工具侧已是显著份额（75.0%），不是「纯模型思考」账。
3. **父腿全量测试**：本焦点腿观测到 0 次 suite 匹配 bash，墙钟 0ms。OWNER 手扒线索「判官单轮自跑 test:all 两次约占 10 分钟」在**本观测窗全局**核：test:all 共 11 次、次均 2.29m、合计约 25.16m；本焦点腿未自带 suite，10 分钟级账不是每个多轮闸腿的固定税。
4. **官取证密度**：本腿官卷 bash 轮均 14.4 次（OWNER 手扒 ~19 次/轮；本腿 per-round 见上表，首轮 19 与线索同阶）。
5. **合成解释**：一轮「小问题」一旦进入多轮封驳，成本 ≈ Σ(官取证墙钟) + 父腿模型/工具间隙 +（若触发）全量测试墙钟；7 轮把单轮官成本乘上去，就到 ~20 分钟量级（本腿 19.71m）。

## 观测窗全局：两桶与闸的关系

- 观测窗腿墙钟 2746.73m 中，工具桶 43.2%、模型桶 56.8%。
- 官耗时合计 197.22m 是闸循环子会话墙钟，嵌在父腿墙钟内，**不可与父腿墙钟简单相加**；它回答的是「官审本身吃掉多少」。
- 父腿 suite bash 合计 30.08m / 40 次；其中 test:all 11 次、次均 2.29m。OWNER「两次全量 ~10 分钟」在当日本机实测次均约 2.29m 时，两次约 4.58m——同阶但低于 10 分钟口述（suite 变快或口述含其它开销）。

## 复算入口

```bash
# 1) 目录总体：枚举 ~/.ak-roles/books/*/runs/*@{judge,reviewer}
#    过滤 runId UUIDv7 ∈ [dayStart, asOf)
# 2) 互斥分类：readable | unreadable | live | missing_invocation | corrupt_invocation | stale_unprojected
# 3) 仅 readable → family.contribute
# 全簿 issue 页（含 gateCycles / legWallClock / b2FrameBucketsActions）
ak-role analyst   # cwd = 对应 git 仓；book = git common-dir
```

本报告数字 = 上表 asOf 冻结下的目录总体对账 + readable 子集上的既有 Analyst 指标族；**无新生产扫描、无写端、无永久 probe**。

## 机器摘要（typed，供复核）

```json
{
  "asOf": "2026-08-24T19:05:29.190Z",
  "day": "2026-08-24",
  "dayTimezone": "UTC",
  "dayStartInclusive": "2026-08-24T00:00:00.000Z",
  "calendarDayEndExclusive": "2026-08-25T00:00:00.000Z",
  "observationEndExclusive": "2026-08-24T19:05:29.190Z",
  "fullUtcDayClosedAtAsOf": false,
  "books": [
    "Ming_LLM",
    "ak-pi-workflow-roles"
  ],
  "roles": [
    "judge",
    "reviewer"
  ],
  "population": {
    "directoryTotal": 302,
    "directoryByRole": {
      "judge": 270,
      "reviewer": 32
    },
    "directoryByBook": {
      "Ming_LLM": 268,
      "ak-pi-workflow-roles": 34
    },
    "categories": {
      "readable": 298,
      "unreadable": 0,
      "live": 3,
      "missing_invocation": 1,
      "corrupt_invocation": 0,
      "stale_unprojected": 0
    },
    "conservationOk": true,
    "conservationIdentity": "302 = readable(298) + unreadable(0) + live(3) + missing_invocation(1) + corrupt_invocation(0) + stale_unprojected(0)"
  },
  "exclusions": [
    {
      "runId": "01a031a6-721f-766b-88ba-340581a0880e",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "category": "live",
      "reason": "run-state=running (live in-flight; sole-scan omits from legs and unreadable)",
      "lifecycle": "running"
    },
    {
      "runId": "01a0328f-8742-73cc-9b47-0d525ee25e2f",
      "role": "reviewer",
      "book": "Ming_LLM",
      "category": "live",
      "reason": "run-state=running (live in-flight; sole-scan omits from legs and unreadable)",
      "lifecycle": "running"
    },
    {
      "runId": "01a03316-4aa1-76c2-8b07-4afe5d8114e8",
      "role": "judge",
      "book": "Ming_LLM",
      "category": "missing_invocation",
      "reason": "invocation.json absent — sole scan cannot scope; omitted from legs and unreadable"
    },
    {
      "runId": "01a03525-ed2f-7142-8d55-3a93aee045e9",
      "role": "judge",
      "book": "Ming_LLM",
      "category": "live",
      "reason": "run-state=running (live in-flight; sole-scan omits from legs and unreadable)",
      "lifecycle": "running"
    }
  ],
  "readableLegs": 298,
  "roleCount": {
    "judge": 267,
    "reviewer": 31
  },
  "unreadableDay": 0,
  "totalGateRounds": 122,
  "totalOfficerWallMs": 11833384,
  "totalLegWallMs": 164803955,
  "totalToolBucketMs": 71226269,
  "totalModelBucketMs": 93577686,
  "suiteBashCount": 40,
  "suiteBashWallMs": 1805078,
  "testAllCount": 11,
  "testAllMeanWallMs": 137253.36363636365,
  "byOfficer": [
    {
      "officer": "notary",
      "rounds": 122,
      "bounceCount": 64,
      "passCount": 58,
      "bounceRate": 0.5245901639344263,
      "meanOfficerWallMs": 96994.95081967213
    }
  ],
  "focus": {
    "runId": "01a031ff-92c5-78e8-ad25-7ca0d346dd8b",
    "role": "judge",
    "book": "ak-pi-workflow-roles",
    "roundCount": 7,
    "legWallMs": 1182446,
    "toolBucketMs": 886448,
    "modelBucketMs": 295998,
    "officerWallMs": 612178,
    "rounds": [
      {
        "roundIndex": 1,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 85079,
        "findingsCount": 3
      },
      {
        "roundIndex": 2,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 59619,
        "findingsCount": 1
      },
      {
        "roundIndex": 3,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 64915,
        "findingsCount": 1
      },
      {
        "roundIndex": 4,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 99198,
        "findingsCount": 1
      },
      {
        "roundIndex": 5,
        "officer": "notary",
        "status": "pass",
        "officerWallMs": 79648,
        "findingsCount": 0
      },
      {
        "roundIndex": 6,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 134137,
        "findingsCount": 1
      },
      {
        "roundIndex": 7,
        "officer": "notary",
        "status": "pass",
        "officerWallMs": 89582,
        "findingsCount": 0
      }
    ],
    "suiteBash": [],
    "officerBash": {
      "rounds": 7,
      "bashTotal": 101,
      "perRound": [
        19,
        14,
        8,
        11,
        10,
        22,
        17
      ]
    }
  },
  "topGateLegs": [
    {
      "runId": "01a0327e-78c4-71a4-8382-d7ba444f133a",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 14,
      "officerWallMs": 1810567
    },
    {
      "runId": "01a031bd-7a9a-79ec-aed3-e340bf46c419",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 13,
      "officerWallMs": 1001568
    },
    {
      "runId": "01a034ad-ee17-7896-9c37-88792b95d785",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 12,
      "officerWallMs": 1063482
    },
    {
      "runId": "01a0341a-c88c-77db-9f8c-c7d3e7466265",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 9,
      "officerWallMs": 998819
    },
    {
      "runId": "01a032bc-69d4-74ab-9c6b-861bbaa2e3cb",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 684347
    },
    {
      "runId": "01a031ff-92c5-78e8-ad25-7ca0d346dd8b",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 612178
    },
    {
      "runId": "01a031e1-31c9-79b5-b9ef-cda423cc48ea",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 578701
    },
    {
      "runId": "01a032f6-0b0d-7a6f-8f5f-64bb5937d610",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 6,
      "officerWallMs": 660652
    },
    {
      "runId": "01a0322e-d065-7d9b-a247-bd279f137934",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 5,
      "officerWallMs": 818638
    },
    {
      "runId": "01a03466-3604-7cd3-8b5c-cef73c3610d0",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 5,
      "officerWallMs": 408892
    },
    {
      "runId": "01a033f6-8225-7bde-b1c6-7c87524870be",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 4,
      "officerWallMs": 554511
    },
    {
      "runId": "01a0340f-9bca-7095-af4c-99d8bf57b41a",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 4,
      "officerWallMs": 251584
    },
    {
      "runId": "01a033b2-4a31-77cf-b308-b4a241ce26bb",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 3,
      "officerWallMs": 282842
    },
    {
      "runId": "01a03515-c20a-7d36-baa6-bcccc5dd27f3",
      "role": "judge",
      "book": "Ming_LLM",
      "roundCount": 3,
      "officerWallMs": 260122
    },
    {
      "runId": "01a03254-06a1-762b-b906-0a8eb62ce62f",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 290894
    }
  ],
  "officerBashSampleMean": 12.847035002035001,
  "officerBashSampleN": 30
}
```
