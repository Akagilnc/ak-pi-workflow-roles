# 0070 — 闸②在交卷处打回重写，包不再往被服务仓库装 git 钩子

Status: proposed（陛下 2026-08-16 裁定；决策键绑原话见下）

[ADR 0066](0066-worker-typed-submission-gates.md) 把闸②（缺平台前缀）④（非前进式改写）前移到 git `reference-transaction` 钩子。代价是包必须往**被服务仓库**主 `.git/config` 写 `extensions.worktreeConfig=true`（不可安全回滚），并按 git 规定把用户原有的 `core.bare` / `core.worktree` 搬进 `config.worktree`——与 [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md) / CONTEXT「消费者仓零侵入」相抵。

本 ADR 落定：**闸②挪到闸①同一个交卷接缝**——交卷时读可可靠观察的提交集合的标题，缺平台前缀则按闸①同形做一次软提醒 typed 打回（同 `gate-power` 原键语义，见下）。包不再向被服务仓库安装钩子或写任何 git 配置。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `gate-2-carrier` | `submission-seam-bounce`（取代 0066 `gate-2-4-enforcement` 中闸②的 `reference-transaction` 承载；④不随迁，见处置分落与 supersession） | 「有没有commit，没有就打回让它重提做得到。为什么有没有前缀就做不到一样的行为」「那就软提醒。不硬要求。不要什么东西都做的那么复杂」 |
| `consumer-repo-invasion` | `zero-write-to-served-repo` | 「我记得不是说我们不侵入别人的仓库吗。你这个还不算侵入？」「什么时候还允许我们的角色包干这样的事情了」 |

0066 的 `gate-power`（`bounce-not-reject-not-fail-role`）、`gate-2-domain`（开放前缀域，[#367](https://github.com/Akagilnc/ak-pi-workflow-roles/pull/367) 已更正记法）、`gate-1` / `gate-1-status-matrix`、`gate-3` / `gate-5` / `gate-6`、`durability-entry` 全部**原键原值不动**。陛下本轮「打回是打回重写。不是什么失败」按限定口径重申 0066 / 0055 已钉语义：typed 打回 = **本次交卷的响亮失败**，但 ≠ 拒收、≠ 角色失败、≠ 终止进程——不是把 `gate-power` 改写成无条件的「不是失败」。正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## 处置分落

1. **闸②进交卷接缝（软提醒，与闸①同形）**：`arm()` 已记 baseline HEAD。`assertAcceptable()` 在既有 HEAD 比对之外，对**可可靠观察的提交集合**读标题，判定平台前缀（开放前缀域，如实标注即合法，循宪法 #10）。
   - **可可靠观察集合**：仅当 baseline 是当前 HEAD 的祖先时，为 `git log` 结构化输出所列、从 baseline 排他走到 HEAD 的那批 commit（`baseline..HEAD`）。输入是结构化 log，不解析 shell 命令串。
   - **不可靠 / 不可见（本闸不追）**——下列情形不在可可靠观察集合内，本轮**不**引入分支限制、reflog 追踪或硬拒收（若要，须另呈陛下，超出本轮软提醒裁定）：
     - **中途换分支**：旧分支上产生、已不在当前 HEAD 祖先链上的 commit 不可见；新 HEAD 上相对 baseline 多出的、非本 run 所写的历史可能被一并看见。
     - **reset**：被甩出当前 HEAD 祖先链的 commit 不可见；reset 到 baseline 之前则 baseline 不再是祖先，本闸无可靠窗口。
     - **一轮多个 commit**：只要仍落在上述可靠窗口内，标题逐条可见；已不在窗口内的不可见。
     - **baseline 非 HEAD 祖先**（换 tip、checkout 无关提交等）：`baseline..HEAD` 不再是「自 arm 以来本工作树前进」的忠实窗口，本闸**不**把它当作可可靠观察集合，不做前缀软提醒。
     - **零新增但 HEAD 改变**（例如 HEAD 移到另一已存在 tip、快进到他人提交）：若 baseline 仍为祖先，窗口内可能出现非本 run 所写标题，仍按所见标题做软提醒；若因此不再是祖先，同上无可靠窗口。
   - **软提醒行为（一次写清，与闸①对齐）**：在 `completed` / `partially_completed` 且可可靠观察集合非空、其中存在缺平台前缀的标题时——**打回一次** typed「观察到缺前缀 commit，请重写后再交」。**同 run 再交视为确认**，放行，不再因前缀缺省二次打回（软提醒，不硬要求）。`planned` / `refused` / `unfinished` 不触发本闸。集合为空或无可靠窗口 → 本闸不打回（闸①对「零新 commit」的既有逻辑不动）。
2. **删 git 钩子机制全套**：install、scope 断言、migrate、prunable worktree 处理、公开 CLI 迁移入口及其专属测试。
3. **闸④不另建机器**（驱动方综合）：非前进式改写的**机器强制删除**；纪律仍由全局宪法 #7 与大理寺看卷承接，与 0066 原文「钩子漏网不加第二道机器，归大理寺看卷」同向。真出现漏网案例再议，不预建。`gate-2-4-enforcement` **不再作为一个整体**被单一新 carrier 取代——②迁交卷接缝，④随钩消失，去向不同。
4. **已装机器的一次性卸载（所有权边界）**：
   - **可发现范围**（只承诺这一范围，**不**笼统承诺清掉所有 clone）：当前被服务工作树所在仓库、以及该仓库 git 可枚举的 worktree 列表内、且仍指向本包钩子目录的安装痕迹。不扫用户主目录、不扫无关仓库、不为卸载另造全局扫描或回滚机制。
   - 处理 stale `core.hooksPath` 与钩子目录时：**只**拆除本包写入的指向与本包自有钩子文件；**不得**删除或覆盖非本包内容。
   - **不可恢复危害须记账**：若用户原有 `core.hooksPath` 曾被本包覆盖，卸载后**无法恢复**原值（本包未保存被覆盖前的用户值）；接受该残缺，不为它另造回滚。
   - `extensions.worktreeConfig=true` 与已被搬进 `config.worktree` 的 `core.bare` / `core.worktree` 不可安全回滚（同仓其他 worktree 可能已依赖），留痕接受，同样不为它另造回滚机制。
5. **[#355](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/355)（收窄钩子 scope）随本 ADR 作废**；PR #364 已关闭不合，分支保留作过程史。

## 具名 supersession / 射程修订

- **修订** [ADR 0066](0066-worker-typed-submission-gates.md)，具名如下（其余决策键与闸门语义原文不动，含 `gate-power` = `bounce-not-reject-not-fail-role`）：
  1. **闸②后移到交卷接缝**：承载由 `reference-transaction` 改为本 ADR `gate-2-carrier` = `submission-seam-bounce`；行为为与闸①同形的一次软提醒，而非 commit 前硬拦。
  2. **闸④的机器强制删除**：非前进式改写不再有钩子层机器；不另建替代机器。
  3. **`gate-2-4-enforcement` 不再作为一个整体被单一新 carrier 取代**：原键值 `reference-transaction-before-history` 随钩子机制作废；②④ 去向不同（②→交卷软提醒，④→无机器），不得写成「整个键迁到交卷接缝」。
  4. **`gate-set` 中 `git-no-amend` 的机器实现消失**：集合名目仍记 0066 历史决策，但 `git-no-amend` 不再有包内机器强制。
  5. **`before-history`（commit 成真之前）时机失效**：打回时机从「commit 成真之前」后移到「交卷时」；补前缀若需改史，不再与闸④机器互锁。
- **不 supersede** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)：本 ADR 把「消费者仓零侵入」从记录落点扩展到闸门实现，方向一致。
- **不 supersede** [ADR 0055](0055-shape-validation-failure-must-not-abort-the-run.md)：typed 打回仍是本次交卷的响亮失败，≠ 终止进程（与 0066 一致）。

## Consequences

- 消费者仓恢复零侵入：包不再在被服务仓库留任何**新**配置或文件；卸载仅清可发现范围，并接受 hooksPath 原值不可恢复与 worktreeConfig 留痕。
- 净删：钩子安装、scope 断言、migrate、prunable 处理及其专属测试全部消失；新增只有交卷闸里对可可靠观察集合读一次 `git log` 并比对前缀。
- 打回时机从「commit 成真之前」后移到「交卷时」。闸④机器强制同时消失；②④ 不再作为同一前置闸互锁。
