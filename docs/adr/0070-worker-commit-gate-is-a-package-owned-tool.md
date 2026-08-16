# 0070 — Worker 提交闸落在包自有工具，不落在被服务仓库的 git 层

Status: proposed（陛下 2026-08-16 口审；决策键绑原话见下）

[ADR 0066](0066-worker-typed-submission-gates.md) 把闸②④前移到 git `reference-transaction` 钩子。代价是包必须往**被服务仓库**写东西：worktree 私有的 `core.hooksPath` 与钩子文件（随 worktree 删除消失），以及主 `.git/config` 里**收不回来**的 `extensions.worktreeConfig=true`，并按 git 规定把用户原有的 `core.bare` / `core.worktree` 搬进 `config.worktree`。这与 [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md) / CONTEXT「消费者仓零侵入」相抵。

本 ADR 落定：**闸②④的承载层由 git 钩子改为包自有提交工具**，检查做在工具的结构化参数上；包不再向被服务仓库写任何 git 配置或钩子。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `gate-2-4-carrier` | `package-owned-commit-tool`（取代 0066 的 `reference-transaction-before-history`） | 「角色不是在自己的session内部提交的吗？提交的时候不能做检查？非要用别人github仓库自己的东西？」「那就这样呗。」 |
| `consumer-repo-invasion` | `zero-write-to-served-repo` | 「我记得不是说我们不侵入别人的仓库吗。你这个还不算侵入？」「什么时候还允许我们的角色包干这样的事情了」 |
| `enforcement-timing` | `before-commit-exists`（不变） | 0066 原键「就没有别的办法吗？在commit实际成真之前就打回让他重写？」「可以。」——时机不变，只换承载层 |
| `intent-detection` | `structured-parameter-not-parsed-command-text` | 驱动方综合：解析 shell 命令串判定「这是不是 git commit」＝从 LLM 自由文本抠结构化事实，宪法 #12 三问不过，且与本日 [#365](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/365) / ming [#517](https://github.com/Akagilnc/ming-salvage-sim/issues/517) 同案 |

0066 的 `gate-2-domain`（开放平台前缀，循宪法 #10）、`gate-power`（打回不拒收不失败角色）、`gate-1` / `gate-1-status-matrix`、`gate-3` / `gate-5` / `gate-6`、`durability-entry` 全部不动。本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## 处置分落

1. **建包自有提交工具**：worker 经该工具提交；平台前缀为结构化参数，闸②（缺平台前缀）与闸④（非前进式改写）在参数与仓库状态上判定；打回仍是 typed bounce（0066 `gate-power` 不变）。
2. **删 git 钩子机制**：install / scope 断言 / migrate 认领与清理 / prunable worktree 处理 / CLI 迁移入口及其专属测试全删。
3. **已污染 clone 的一次性卸载**：删除机制前须先卸载现存痕迹（stale `core.hooksPath` 与包自有钩子目录）。`extensions.worktreeConfig=true` 一经开启不可安全回滚（同仓其他 worktree 可能已依赖），留痕接受并记账，不为它另造回滚机制。
4. **[#355](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/355)（收窄钩子 scope）随本 ADR 作废**：PR #364 关闭不合，分支保留作过程史。

## 具名 supersession / 射程修订

- **修订** [ADR 0066](0066-worker-typed-submission-gates.md) 射程：`gate-2-4-enforcement` 键的承载层被本 ADR 取代；0066 其余决策键、闸门集合与打回语义原文不动。
- **不 supersede** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)：本 ADR 是把「消费者仓零侵入」从记录落点扩展到闸门实现，方向一致。

## Consequences

- 消费者仓恢复零侵入：包不再在被服务仓库留任何配置或文件。
- 闸②④不再依赖被服务仓库的 git 配置，跨仓行为一致，scope 泄漏类缺陷（#355）在构造上灭绝。
- 净删码：钩子安装、scope 断言、migrate、prunable 处理及其测试全部消失，新增只有一个结构化参数的提交工具。
