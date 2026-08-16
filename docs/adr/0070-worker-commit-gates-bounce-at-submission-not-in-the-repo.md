# 0070 — 闸②在交卷处打回重写，包不再往被服务仓库装 git 钩子

Status: proposed（陛下 2026-08-16 裁定；决策键绑原话见下）

[ADR 0066](0066-worker-typed-submission-gates.md) 把闸②（缺平台前缀）④（非前进式改写）前移到 git `reference-transaction` 钩子。代价是包必须往**被服务仓库**主 `.git/config` 写 `extensions.worktreeConfig=true`（不可安全回滚），并按 git 规定把用户原有的 `core.bare` / `core.worktree` 搬进 `config.worktree`——与 [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md) / CONTEXT「消费者仓零侵入」相抵。

本 ADR 落定：**闸②挪到闸①同一个交卷接缝**——交卷时读 baseline 之后的新 commit 标题，缺平台前缀就打回重写（与闸①「忘了提交」同形、同 typed bounce、同 `gate-power`）。包不再向被服务仓库安装钩子或写任何 git 配置。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `gate-2-carrier` | `submission-seam-bounce`（取代 0066 的 `reference-transaction-before-history`） | 「有没有commit，没有就打回让它重提做得到。为什么有没有前缀就做不到一样的行为」「那就软提醒。不硬要求。不要什么东西都做的那么复杂」 |
| `gate-power` | `bounce-is-rewrite-not-failure`（0066 原键，本 ADR 重申不动） | 「打回是打回重写。不是什么失败」；0066 原绑「打回重写不等于拒收」 |
| `consumer-repo-invasion` | `zero-write-to-served-repo` | 「我记得不是说我们不侵入别人的仓库吗。你这个还不算侵入？」「什么时候还允许我们的角色包干这样的事情了」 |

0066 的 `gate-2-domain`（开放前缀域，[#367](https://github.com/Akagilnc/ak-pi-workflow-roles/pull/367) 已更正记法）、`gate-1` / `gate-1-status-matrix`、`gate-3` / `gate-5` / `gate-6`、`durability-entry` 全部不动。正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## 处置分落

1. **闸②进交卷接缝**：`arm()` 已记 baseline HEAD；`assertAcceptable()` 在既有 HEAD 比对之外，读 `baseline..HEAD` 的 commit 标题，缺平台前缀则 typed 打回重写（开放前缀域，如实标注即合法，循宪法 #10）。输入是 `git log` 的结构化输出，不解析 shell 命令串。同 run 重交视为确认，与闸①一致。
2. **删 git 钩子机制全套**：install、scope 断言、migrate、prunable worktree 处理、公开 CLI 迁移入口及其专属测试。
3. **闸④不另建机器**（驱动方综合）：非前进式改写的机器强制随钩子消失；纪律仍由全局宪法 #7 与大理寺看卷承接，与 0066 原文「钩子漏网不加第二道机器，归大理寺看卷」同向。真出现漏网案例再议，不预建。
4. **已装机器的一次性卸载**：删除机制前先清掉现存痕迹（stale `core.hooksPath`、包自有钩子目录）。`extensions.worktreeConfig=true` 与已被搬进 `config.worktree` 的 `core.bare` / `core.worktree` 不可安全回滚（同仓其他 worktree 可能已依赖），留痕接受，不为它另造回滚机制。
5. **[#355](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/355)（收窄钩子 scope）随本 ADR 作废**；PR #364 已关闭不合，分支保留作过程史。

## 具名 supersession / 射程修订

- **修订** [ADR 0066](0066-worker-typed-submission-gates.md)：`gate-2-4-enforcement` 键的承载层被本 ADR 取代，处置分落 2 的 git 层前置闸随之作废；0066 其余决策键与闸门语义原文不动，`gate-power` 重申。
- **不 supersede** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)：本 ADR 把「消费者仓零侵入」从记录落点扩展到闸门实现，方向一致。

## Consequences

- 消费者仓恢复零侵入：包不再在被服务仓库留任何配置或文件。
- 净删：钩子安装、scope 断言、migrate、prunable 处理及其专属测试全部消失；新增只有交卷闸里读一次 `git log` 并比对前缀。
- 打回时机从「commit 成真之前」后移到「交卷时」。补前缀需改史，而闸④的机器强制同时消失，两者不再互锁。
