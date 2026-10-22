# #1237 存量测试质量清理交卷

基线：`7997ffb2`；票面：2026-10-22T06:52:19Z。本文是施工记录，不是新测试规范，也不限制后续审核。未调用大理寺。

## 方法与边界

盘点基线全部 137 个 `*.test.ts`：unit 19、contract 27、integration 87、adjudication 1、package 2、根目录 1；逐文件处置为改 20、删 12、留 105。先逐文件核入口与断言，再打开候选上下文、生产调用点、承接测试及历史。类别仅采用票面五项：M＝内部结构（含镜像），T＝非契约文本，D＝重复结论，S＝失效行为，C＝单纯覆盖率；B 表示留下的行为测试，不是第六项判坏标准。混合文件的“改”包含删除其中坏案，保留其他行为。

不以目录、ADR、负向案或暂停席身份豁免；也不把所有字符串一刀切：CLI argv、JSON 编码、URL/路径、SPDX、外部协议字段属于契约；调用者/上游提交的 opaque payload 原样穿透也属于契约。它们不同于断言包生成的提示词、建议文案或源码组织。计量冻结历史卷宗的结构化统计不是约束 LLM 新产出。

本次没有新造生产函数、测试工具或扫描器。左拾遗改用已有 `roleTurnHostFromStructuredOutputRounds`，真实链路为 `runAkRole → prepareRoleEnvelope → ingestStructuredOutput → ledger → Terminal`，不再由夹具直接替它封卷。退役其无生产调用的旧 validator、再导出及旧测试；同时删除废弃的测试专用 Soul 清单。

改造优先的具体落点：
- 左拾遗在同一既有空弹章入口案中纳入 completed、bounce、pass、只有 countersignStatus 的对象；断言 exitCode、accepted、原始 payloads。
- CLI option 表的自比对、人工全集和 `ok >= 10` 不另造替身。有效的 analyst 模式冲突及重复 option 负向输入并入现有公开入口拒收表，断言零写入/零 dispatch，不删必要失败路径。
- Navigator 保留 lookup 的记录、无宿主会话、筛选维度、advice/no-advice/unavailable；不以表中的建议全文作 oracle。提示词、Soul、固定 dispatch 的文字效果不换形造哨兵。其语义正确性不由机械测试裁定。
- npm 清单案改为执行 tarball manifest 指定的 bin；许可证、peer、禁止随包复制 method Skills、禁自动注册等对安装者有意义的发布契约仍留。不恢复已撤掉的真实宿主安装/冷启动矩阵。

## 逐文件表

路径、行号均指本次修改后的工作树；完整删除的文件仍占基线一行。承接者只承接写出的行为，不冒称承接被删的内部布局或文案。

| 测试文件 | 类别 | 处置及理由／入口、结果／承接者 |
| --- | --- | --- |
| `test/unit/activation-envelope-module.test.ts` | B | 留：ledger home 拒相对路径；writer 的短写/EAGAIN 输入得到完整 schema-valid JSONL。 |
| `test/unit/canonical-json.test.ts` | B | 留：规范 JSON 是格式契约；排序、非法值和原异常身份，不是业务文案快照。 |
| `test/unit/engine-material.test.ts` | D | 删：路径危险字符/自由 engine 名已由 `test/integration/public-cli-engine-axis.test.ts:232` 的 CLI/config 输入接住。 |
| `test/unit/gate-officer-resume-accounting.test.ts` | B | 留：结构化投影区分 abort、无 scoped payload、有效状态与回执，不猜最后一行。 |
| `test/unit/headless-host-argv.test.ts` | B | 留：Claude MCP env 文档与 JSON result 解码是外部宿主协议，不是复制包内 registry。 |
| `test/unit/host-neutral-role-envelope.test.ts` | M | 改：删只查 flags/hooks 存在的空壳案；保留真实 factory 注册默认旗后 env fallthrough 的返回值。非 Pi 激活由 `test/integration/role-envelope-engine-axis.test.ts:68` 接住；不保 handler 布局。 |
| `test/unit/host-retry-verdict-relay.test.ts` | B | 留：executeTurn 经假 ACP 边界，opaque retry 原样作为下一次调用输入。 |
| `test/unit/judge-recording-anti-forge.test.ts` | S | 删：只对无生产调用的 on-demand helper 拼 synthetic digest，没有消费任何证据卷；承接者 null，不声称证明录音真伪。 |
| `test/unit/merger-contract.test.ts` | M | 删：手拼内部 envelope 的 blank attemptId，不是公开输入；`test/integration/public-cli-merger.test.ts:181` 接住从真实 Git 派生后 dispatch/settle，内部 blank 身份案承接者 null。 |
| `test/unit/navigator-route-table.test.ts` | T | 删：静态建议逐行字数/非空；`test/integration/public-cli-navigator-lookup.test.ts:74` 接住 lookup，文案质量承接者 null。 |
| `test/unit/package-home-seam.test.ts` | B | 留：显式 home、ledger 路径边界与 typed failure 的纯路径决策。 |
| `test/unit/pi-adapter-agent-start.test.ts` | M/T | 改：SDK adapter 输出只断言 typed readingMaterial 不泄漏、stdin 只解一次、spawn env 无正文；删拿同一 renderer 重算预期和提示词异同。 |
| `test/unit/process-cancel.test.ts` | T | 改：删诊断句式锁，保留 signal aborted、首信号名与 dispose。 |
| `test/unit/public-cli-option-definitions.test.ts` | M/D/C | 删：表→表、required 全集、owner 元数据与全 option 计数；phase/required/attach 由 `test/integration/public-cli-coder.test.ts:333`、`test/integration/public-cli-fixer.test.ts:152`、各角色 argv 案承接；模式负向并入 `test/integration/analyst-public-cli-sweep.test.ts:93`，重复 option 并入 `test/integration/public-cli-failure-settlement.test.ts:36`。help 元数据见 `test/integration/public-cli-cli.test.ts:108`。 |
| `test/unit/public-cli-registry.test.ts` | M/D | 删：整份 registry 抄表与重复 capabilities；承接 `test/integration/public-cli-cli.test.ts:108`、`:407` 及各席真实调用；内部字段/顺序没有独立承接者。 |
| `test/unit/public-cli-ticket-argv.test.ts` | B | 留：公开 argv grammar 的 ticket 数值、附件、source locator 归一化。 |
| `test/unit/test-agent-dir-guard.test.ts` | B | 留：测试夹具写真机器 agent tree 的负向契约，不调用真实写入。 |
| `test/unit/ticket-provenance.test.ts` | B | 留：provenance 文件边界的 malformed/empty 区分与范围数据透传。 |
| `test/unit/user-dialogue-stdin.test.ts` | B | 留：opaque stdin 编解码、碰撞及外部 CLI stdin 参数，不锁 prompt 包装文案。 |
| `test/contract/adr-0086-host-dossier-copy.test.ts` | B | 留：实际卷写失败抛 typed infrastructure 与原 cause；不因 ADR 标签而留。 |
| `test/contract/analyst-412-library-index-book-scope.test.ts` | B | 留：legacy index 与公开 cohort 的 book:N 作用域隔离。 |
| `test/contract/analyst-413-r2-findings.test.ts` | D/T | 改：删 synthetic helper 分类重复案与报错句子断言；保留真实读边界 malformed 失败及 runAnalyst 的 root:foo cache-miss 回填（`:77`）。 |
| `test/contract/analyst-b2-frame-buckets-actions.test.ts` | M | 改：删直接拼 A2 中间数据喂 kernel 的案；并回同文件 `runAnalyst` 真入口案（`:154`），在 owned 源 session 副本设置 record span 10→20s、message tool span 0→30s，断言输出 wall/tool/action 均 10s、model 0；原独立手算统计仍留。 |
| `test/contract/analyst-book-key-failure-honesty.test.ts` | B | 留：真实 repo/git 故障的 fallback 与 cause/status，区别非 repo 和基础设施故障。 |
| `test/contract/analyst-gate-cycles.test.ts` | B | 留：从冻结卷宗统计轮次、拒收/缺损、cohort 聚合，断言结构化计量。 |
| `test/contract/collector-self-collect.test.ts` | M | 改：删 meta.worker/phases 查表；保留真实 extension 激活后的工具可达/禁止旧收集工具。公开收卷承接 `test/integration/public-cli-collector.test.ts:47`。 |
| `test/contract/countersign-role.test.ts` | M/S/T | 改：删 schema identity/第三方 shape、孤立旧 validator、开场长度；保留空 Soul 激活失败和 tool 原样终止。公开 status/收卷承接 `test/integration/public-cli-countersign-run.test.ts:224`，内部 validator 拒收不要求恢复。 |
| `test/contract/doctor-case.test.ts` | B | 留：loadDoctorCase 读取真实 fixture 卷宗，费用、缺损、路径及证据分页；待设计不等于失效。 |
| `test/contract/doctor-role.test.ts` | T | 改：删随机 Soul 字节哨兵；保留激活工具能力面与提交后 terminate、candidate、cost。 |
| `test/contract/durable-session-write-failure.test.ts` | B | 留：真实 envelope/public terminal 的持久化失败优先级，保留宿主事实。 |
| `test/contract/gatekeeper-pass-envelope.test.ts` | B | 留：submission gate 的 pass/escalate/transport_failure/no_receipt 结构化分支及 officer 身份。 |
| `test/contract/gatekeeper-projection.test.ts` | D/S | 删：孤立投影 helper 的原样返回；承接 `test/integration/public-cli-merger-run.test.ts:423` 各席公开 sealed→Terminal 及 `test/contract/submission-ledger.test.ts:435` 原 params 落账。 |
| `test/contract/gleaner-left-role.test.ts` | M/S | 删并入：真实入口收卷行为在 `test/integration/public-cli-gleaner-left-run.test.ts:90`；不保死 helper 拒 bounce/pass。 |
| `test/contract/judge-role.test.ts` | M/T/D | 改：删 handler 全集、focused worker 注册/文案重复案及 assertDelivers；从 extension/runtime 到 tool、ledger closure 的空 Soul/未完成提醒/原卷数据等行为仍留。worker phase 承接 `test/integration/public-cli-coder.test.ts:122`、`test/integration/public-cli-fixer.test.ts:152`；Soul 文案无机械承接者。 |
| `test/contract/navigator-attendance-lifecycle.test.ts` | B | 留：受控 promise/clock 驱动 attendance grace、取消和 settlement；不是实际宿主并发测试。 |
| `test/contract/navigator-attendance.test.ts` | B | 留：缺状态、无行、arrival、取消、failure/no-terminal；opaque 上游失败真因传递不是锁系统报错句式。 |
| `test/contract/notary-role.test.ts` | M/T/D | 删：旗绑定和 payload helper 重复、audited Soul XML 模板；承接 `test/integration/public-cli-notary.test.ts:170`、`:301`、`:367` 及 `test/integration/audited-run-identity-1166.test.ts` 的身份字段；模板本身承接者 null。 |
| `test/contract/oauth-keepalive.test.ts` | B | 留：手动 scheduler、刷新服务边界、single-flight 与 warning 类型/原 cause，不连真实 OAuth。 |
| `test/contract/publish-registry-workflow.test.ts` | B | 留：实际发布脚本、恶意 CHANNEL 不执行 shell、tag/publish 调用输入；外部命令用假 registry 边界。 |
| `test/contract/role-envelope-tool-error.test.ts` | B | 留：真实 tool/envelope 的 isError 与 round infrastructure 分界及持久化故障。 |
| `test/contract/secretariat-role.test.ts` | B | 留：公开工具能力面、任意状态原卷和终止/落账先于 audit。 |
| `test/contract/secretariat-static-scan.test.ts` | M | 删：文件名/三符号源码 regex 及 options 全集不是运行行为，无法改好为同一结构禁令的行为案；结构禁令承接者 null。现有 `test/integration/public-cli-secretariat-run.test.ts:400` 接住真实 gate，`:672` 接住 escalate 不派 gate，不声称证明全仓无第二机制。 |
| `test/contract/session-opening-materials.test.ts` | M | 删：直接让 join helper 读不存在文件，只重证 fs ENOENT；独立 OS 语义承接者 null，不造缺文件证明测试。空 Soul 激活失败仍由 `test/contract/judge-role.test.ts:532` 接住。 |
| `test/contract/sitian-facade-contracts.test.ts` | B | 留：append/read 门面真正写出/读回的卷、重复记录、malformed 行与诊断。 |
| `test/contract/submission-ledger.test.ts` | B | 留：真实 ledger host 的原参数、多提交、基础设施/可改拒绝、未知 run、append failure。 |
| `test/contract/ticket-trajectory.test.ts` | B | 留：公开渲染/写页入口，HTML data-* 字段、链接、read-only 与刷新/失败；不比展示文案。 |
| `test/integration/acp-unknown-client-request.test.ts` | B | 留：假本机 ACP 对端的 JSON-RPC method-not-found 后连接仍可用。 |
| `test/integration/activation-envelope-contract.test.ts` | B | 留：真实 Git common-dir/worktree 身份、spawn cause、durable principal 接纳边界。 |
| `test/integration/analyst-399-book-scope.test.ts` | B | 留：公开 book/ticket/空集合/损坏卷作用域，不因暂停 analyst 删。 |
| `test/integration/analyst-c1-sweep-index.test.ts` | B | 留：runAnalyst sweep 写页/index、LOC 与 lastActivity 的独立手算值。 |
| `test/integration/analyst-c1-sweep-pages.test.ts` | B | 留：入口上的非法 changedLines、倒置时间、live/terminal 区别。 |
| `test/integration/analyst-c2-cohort.test.ts` | B | 留：cohort 合并、全 absent vacancy、cache-miss 重算，非统计展示模板。 |
| `test/integration/analyst-c3-model-groups.test.ts` | B | 留：library runAnalyst 的 model-group 计算、alias 与无 model 排除；CLI 暂停此 face 不抹掉仍支持的库行为。 |
| `test/integration/analyst-c4-ticket-scope.test.ts` | B | 留：typed ticket 与 legacy 范围差异，真实卷宗到 run IDs。 |
| `test/integration/analyst-compute-if-missing.test.ts` | B | 留：公开检索的回填、错误页作用域、写失败与损坏单 run。 |
| `test/integration/analyst-entry.test.ts` | B | 留：唯一 runAnalyst 入口的独立 fixture 统计与原子写页、损坏/活跃卷处理。 |
| `test/integration/analyst-public-bundle-families.test.ts` | B | 留：公开 bundle 装配 metric families，验证打包后的能力不是复制模块文件表。 |
| `test/integration/analyst-public-cli-sweep.test.ts` | D/C | 改：既有 runAkRole 零写入负向表接入模式混用/缺参/重复 token，替代 option 表镜像；保留成功 sweep 落账。 |
| `test/integration/analyst-public-cli.test.ts` | M | 改：删 PUBLIC_ROLE_ARGV 查表案；`:116` 公开 ticket 与其余 scope/usage/ghostLegs 已实际消费 parser。 |
| `test/integration/audited-run-identity-1166.test.ts` | T/D | 改：保留公开 gate/resubmit/direct 的 auditedRun 身份、schema 输入、原卷；peer JSON 直接解析比结构；删固定 dispatch 等文案比较、readable helper 自比和只剩重复 summons 计数的 Judge 案。resummon 承接 `test/integration/public-cli-same-ticket-resume.test.ts:193`；本文件 `:453` 仍实走 countersign 重交与 notary 身份。 |
| `test/integration/countersign-notary-gate.test.ts` | B | 留：真实 countersign 工具完成先于 gate、escalate 与未知状态原样提交。 |
| `test/integration/dossier-resolution.test.ts` | B | 留：HostContext/卷指针读取确实隔离不同 run，不是文案样本计数。 |
| `test/integration/engine-detour-cancel-idle.test.ts` | B | 留：受控本机 child/参数/AbortSignal/静默，边界无真实宿主模型。 |
| `test/integration/engine-detour-usage-ledger.test.ts` | B | 留：公开 detour→usage ledger 的计量、scope、UTF-8、写失败原事实。 |
| `test/integration/engine-material.test.ts` | D | 删：notes discovery helper 重复；承接 `test/integration/public-cli-engine-axis.test.ts:232` 自由 engine/缺 notes 真实输入及 `test/integration/public-cli-engine-startup-material.test.ts:86` typed material。 |
| `test/integration/factory-board-true-home.test.ts` | B | 留：冻结 true-home 卷宗经公开 board 渲染得到 data 字段及 read-only；不跑活宿主。 |
| `test/integration/factory-board.test.ts` | B | 留：board/snapshot 入口的 family、计量、错误、写保护与 DOM 控件行为；结构化 DOM 属性不是图片/文案 oracle。 |
| `test/integration/gate-officer-resume-accounting.test.ts` | T | 改：保留实际 officer summons/resume、scope/host/run 计量和 no-dossier 字段，删固定 dispatch 句子比较。 |
| `test/integration/headless-codex-host.test.ts` | B | 留：executeTurn 驱动本机假 CLI 的协议、schema 调用输入、thread 绑定/恢复与失败；不调用真实 Codex。 |
| `test/integration/host-retry-verdict-relay.test.ts` | B | 留：headless 与 ACP 是不同外部宿主协议；验证 opaque retry 的真实 stdin 输入，不是同 helper 重测。 |
| `test/integration/host-session-acp-grok-usage-compact.test.ts` | B | 留：假 ACP host 的实际 session 文件复制、usage 及缺文件/失败路径。 |
| `test/integration/host-session-acp-write-fail.test.ts` | B | 留：host-session 写失败保住宿主 turn，不以记录错误改写宿主结果。 |
| `test/integration/host-session-live-records.test.ts` | B | 留：本机假 headless native dossier 到 session 副本、指针与失败保真。 |
| `test/integration/merger-git-state.test.ts` | B | 留：真实本机 Git merge 状态、无 merge、unborn、损坏身份，不用虚构中间对象。 |
| `test/integration/merger-role.test.ts` | B | 留：Merger runtime 从 host 入口接卷，不因 Git 完成条件拒收，角色能力面可见。 |
| `test/integration/package-home-cli-seam.test.ts` | B | 留：真实 CLI 子进程的 HOME/profile 隔离及缺 profile 时 help/需 home 命令分界。 |
| `test/integration/pipeline-lifecycle-formalization.test.ts` | B | 留：公开组合根换宿主后仍落同一 typed Terminal，非 registry 查表。 |
| `test/integration/public-cli-1132-delivery-request.test.ts` | B | 留：公开催交、计数、audit 子卷 ceiling 与后续失败，不是数生成句子。 |
| `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts` | B | 留：入口 relocation→inspector→resume 的结构化路径无陈旧 unbound，不匹配任意叙述。 |
| `test/integration/public-cli-argv-parsers.test.ts` | B | 留：公开 argv grammar 与实际 admission/Git 的 phase、opaque prerequisites、正整数及 engine 决策。 |
| `test/integration/public-cli-attach-path-passthrough.test.ts` | B | 留：公开传入 opaque path，实际 host flags/请求保持路径，不读取或解释内容。 |
| `test/integration/public-cli-auto-resume-dispatch-throw.test.ts` | B | 留：公开 retry loop 保每次 cause、sink 故障、后续成功与原始异常身份。 |
| `test/integration/public-cli-auto-resume-limit-422.test.ts` | B | 留：真实 config/入口决定 dispatch 次数，零/非法/大整数边界与无写入。 |
| `test/integration/public-cli-bin-startup.test.ts` | B | 留：真实 built bin 可启动、exit 状态，不比 help 文案；与 tarball 安装产物接缝不同。 |
| `test/integration/public-cli-cli.test.ts` | B | 留：公开 capabilities、跨进程 config、unknown command 零写入及各席 invocation。 |
| `test/integration/public-cli-coder.test.ts` | B | 留：公开 Coder phase、opaque status、audit failure、model/thinking 与 resume；宿主边界提供输入。 |
| `test/integration/public-cli-collector.test.ts` | B | 留：真实收卷 groups 到 report、PR admission 与 retired option，不把 evidence seat 当 construction。 |
| `test/integration/public-cli-config.test.ts` | B | 留：实际 config persistence/inheritance/clear/未知 seat 往返，全部 fixture home。 |
| `test/integration/public-cli-countersign-run.test.ts` | B | 留：公开 admission、status、同 session 恢复、ticket assertion 与旧 attempt 残卷隔离。 |
| `test/integration/public-cli-diarist-run.test.ts` | B | 留：公开 dialogue/diarist 的源卷字节、范围选择、迁移/分票/追加/恢复，不锁新生成叙事。 |
| `test/integration/public-cli-doctor.test.ts` | B | 留：公开 case admission、完成/拒绝、mandatory audit、officer escalation；待设计不豁免也不自动删。 |
| `test/integration/public-cli-engine-axis.test.ts` | B | 留：CLI/config→host 的 engine/model 输入优先级、自由名、语法错误、clear；非 engine 清单镜像。 |
| `test/integration/public-cli-engine-resume-detour.test.ts` | B | 留：初始/自动/显式恢复上的 engine 及 live seat table axes，输出 typed 请求。 |
| `test/integration/public-cli-engine-startup-material.test.ts` | T/M | 改：runAkRole→prepared host，只断言 typed kind/name/model、handbook 字段类型与输入 dispatch；删包内文档字节自比对。 |
| `test/integration/public-cli-escalation-resume.test.ts` | B | 留：公开 gate escalation/continue/transport_failure 到同次父卷与恢复路由。 |
| `test/integration/public-cli-explicit-internal.test.ts` | B | 留：假 CLI 子进程 argv/stdin/env、PATH、SIGTERM/关闭与投递错误，不调用真实模型。 |
| `test/integration/public-cli-failure-artifacts.test.ts` | B | 留：实际 public terminal/artifact 写故障、旧卷隔离及宿主结果不被产物错误顶替。 |
| `test/integration/public-cli-failure-provider-stop.test.ts` | B | 留：真实 public 入口只认宿主 typed report，不从旧 transcript 推造 provider failure。 |
| `test/integration/public-cli-failure-real-entry.test.ts` | B | 留：公开 entry 的 typed failure 与 packageFact/timeout、封卷后非零退出；保存而不洗白。 |
| `test/integration/public-cli-failure-settlement.test.ts` | D/C | 改：既有零 dispatch/零 admission 的结构性错误表接住非 repeatable option 重复；其余实际 failure/Terminal 分支保留。 |
| `test/integration/public-cli-fixer.test.ts` | B | 留：公开 opaque prerequisites、phase、restore、声明 prerequisite_unmet 与各合法交卷状态。 |
| `test/integration/public-cli-gleaner-left-run.test.ts` | S | 改：`:90` 从真实 structured-output 收卷走到 Terminal，比原参数，覆盖 completed/bounce/pass/无 status；其余 base、非空弹章、resume 失败路径仍留。 |
| `test/integration/public-cli-host-axis.test.ts` | B | 留：公开 host 优先级、adapter request、session id、live axes 与假宿主 stdin/env，不限实际 host 文本。 |
| `test/integration/public-cli-instruction-seat.test.ts` | B | 留：公开各 instruction seat admission 到 typed terminal 的 role 差异。 |
| `test/integration/public-cli-judge.test.ts` | B | 留：公开 Judge decisionGate、结构拒收、audit no_receipt 和空请求不发明任务。 |
| `test/integration/public-cli-known-ticket-placement.test.ts` | B | 留：公开已知 ticket 对所有席的落盘位置，不用目录猜 ticket。 |
| `test/integration/public-cli-main-flow-p0.test.ts` | B | 留：无配置在 dispatch 前失败，以及真实公开 escalate→owner ruling→resume 主链。 |
| `test/integration/public-cli-merger-run.test.ts` | B | 留：公开共享 entry 每席 sealed→Terminal、同轮多提交和 failure/no_receipt，非静态 roster 断言。 |
| `test/integration/public-cli-merger.test.ts` | B | 留：公开 Merger 从真实 Git 派生 materials，再到 host/Terminal、resume 与 malformed 收卷。 |
| `test/integration/public-cli-navigator-attendance.test.ts` | T/M | 改：真实父入口到 Navigator lookup，断言 disposition、退出、run/receipt/session，不再复制表文案或匹配系统错误句子。 |
| `test/integration/public-cli-navigator-lookup.test.ts` | T/M | 改：真实 lookup 的 byRole/byStatus 维度、落原卷、零 host session、usage/记录失败；不导入建议常量自比对。 |
| `test/integration/public-cli-notary.test.ts` | B | 留：公开 source locator 输入边界与三态/no_receipt/transport、绑定继承和 Terminal；不是旧 helper 拒收测试。 |
| `test/integration/public-cli-process-cancel.test.ts` | B | 留：实际 CLI/process 信号入口产生结构化失败并停止受控 host child。 |
| `test/integration/public-cli-report-ticket.test.ts` | B | 留：公开中途认票→重定位→记录→恢复，包含真实持久化失败和不同 court 的卷隔离。 |
| `test/integration/public-cli-resume-416.test.ts` | B | 留：公开恢复受理、无文件尝试宿主、call-local retry 与 nested seat axes。 |
| `test/integration/public-cli-resume-callable-seats.test.ts` | B | 留：各 callable seat 的公开 resume 到精确 principal/Terminal，覆盖角色差异。 |
| `test/integration/public-cli-resume.test.ts` | B | 留：公开 exact principal、模型覆盖/继承、publication 恢复、lease 失败及 opaque ruling。 |
| `test/integration/public-cli-reviewer.test.ts` | B | 留：公开双 lens/single lens、失败 sibling 保留、scope 与 same session，不用模型输出模板。 |
| `test/integration/public-cli-same-ticket-resume.test.ts` | B | 留：公开 re-summon/new/manual resume 的不同身份与审官继续路径，非 ticket 相等就猜 session。 |
| `test/integration/public-cli-seat-pipeline.test.ts` | B | 留：真实 public route/提交/report 与 diarist/countersign 二次 summons 不偷续前 run；非配置表自比对。 |
| `test/integration/public-cli-seat-self-ticket.test.ts` | B | 留：typed 票号声明才归位，纯文本不推票号，malformed declaration 不拒原卷。 |
| `test/integration/public-cli-secretariat-run.test.ts` | B | 留：公开中书省→diarist/countersign/notary 链、escalation 与 host failure，不按文本判结论。 |
| `test/integration/report-ticket-adapter-exit-copy.test.ts` | B | 留：公开真实 adapter（假 CLI/ACP 对端）中途 relocation 后 exit-copy 和 resume 仍在 ticket。 |
| `test/integration/resume-missing-host-session-id.test.ts` | B | 留：executeTurn 无 bound session id 不新建，以及 required disposal failure 保宿主事实。 |
| `test/integration/role-envelope-engine-axis.test.ts` | M/T | 改：删 judge/auditor 与 Pi root 两组人工材料清单及 packagedMaterials helper。剩真实 envelope 的 tools/list、request/env 隔离及 no-dossier 字段；具体材料表承接者 null，不能靠机械测它应读哪些法。 |
| `test/integration/run-terminal-artifacts.test.ts` | B | 留：实际持久化 API 写/读 terminal，unknown/损坏文件与 sibling 隔离。 |
| `test/integration/run-test-all.test.ts` | B | 留：npm 脚本是对外形式语言调用输入（不是叙事）；真实 runner child argv、选集、HOME 隔离及 exit/SIGTERM。未因 #1206 判词自动留，独立核其外部契约后留。 |
| `test/integration/test-agent-dir-model-seed.test.ts` | B | 留：fixture models seed 的文件边界、listener cleanup，不写机器 agent tree。 |
| `test/integration/test-process-env.test.ts` | B | 留：实际子进程环境隔离、own home 清理/非 own home 不删的测试基础设施接口。 |
| `test/integration/test-user-profile-preload.test.ts` | B | 留：真实 process preload 的 userInfo/HOME/profile 可用性与隔离，不改宿主配置。 |
| `test/integration/ticket-snapshot-family-edges.test.ts` | B | 留：冻结 GitHub payload 经真实 snapshot 接口得 parent/blockedBy；GraphQL 是形式语言，错误 alias 对应结构校验。 |
| `test/integration/ticket-trajectory-binding.test.ts` | B | 留：真实 ledger index/render 消费 typed ticket、legacy、unbound 与 ambiguous run 路径。 |
| `test/integration/worker-submission-gates.test.ts` | B | 留：真正 Git/受控 gate 输入的提醒次数、unborn/失败、开放 commit 前缀及旧 hook 清理；不是盯提示句子。 |
| `test/adjudication/activation-bare-seam.test.ts` | B | 留：extension 激活入口的 git/durable principal 故障、原 cause、零加载及退出/abort 策略。 |
| `test/package/npm-identity-metadata.test.ts` | M/D | 改：tarball manifest bin→真实 --help 正常退出；删 source/Soul/module/packet 手工清单和重复 license 排除。许可证/peer/无 method Skills/禁自动激活仍是安装者契约。 |
| `test/package/published-dist-import-closure.test.ts` | B | 留：实际 build 后用生态 esbuild 解析真实 import edges 并加载根模块；不是手抄模块全集。 |
| `test/primary-aware-cleanup.test.ts` | B | 留：真实 cleanup 接口区分主失败与清理失败，结构化 cause/AggregateError 保真。 |

## 进口账（已冻结卷宗分析）

以下指针根均为 `~/.ak-roles/books/ak-pi-workflow-roles/`。旧版回执保存在 `current.json` 的 `submission.latest.accepted` 或 `terminal.body.outcome`，不假造不存在的 `receipts/` 文件。只把实读的席位列为有证据，不从 merge/commit 作者反推“所有席都审过”。

| 类 | 来源与进入事实 | 实读审核回执／漏点 |
| --- | --- | --- |
| M 内部结构／镜像 | #924：`fa29385a`／`1214035b` 的 secretariat 静态扫描；#524：`4d1a0246` 引入 `EXPECTED_PACKAGED_ROLE_METADATA`；#922：`2a223329` 引入 Soul/reference 两组清单。 | **不能统称所有闸都没发现。** #924 御史台 `924/runs/01a0aa8a-5f5f-7b78-9333-05881cb50b3c@reviewer/current.json` 的 completeness **C2 已明确指出**三符号源码 regex 是内部结构平行契约，建议删除并用现有公开 tracer。当前基线仍在，说明“发现后未落实/后续又留下”，不能写成“没看见”。本地该票未查得将作监、台院、大理寺、审刑院的相应最终处置回执，后续裁决来源不明；#524/#922 相应审核席来源不明。 |
| T 非契约文本 | #1192：navigator lookup/attendance 将建议表内容当 oracle；#582：`3146a77f` 留 Notary 开场模板；`0ad8a100` 的 Doctor Soul 随机哨兵。 | #1192 有将作监 `1192/runs/01a14eb7-544f-7591-a876-66fe7f778cdc@coder/receipts/3.json`、台院 `1192/runs/01a14ed5-38de-75c1-8db1-f2344e1418d8@inspector/receipts/3.json`、大理寺 `1192/runs/01a14ee5-74ad-7f9b-8f04-bdefab1b82f2@judge/receipts/7.json`。最后一卷自述测试 27/27、重复/内部结构类已结清，但表文案 oracle 仍存活。它还说明后续 P3 修理不再等新御史台，不能把旧 reviewer 范围冒充最后 HEAD 的复核。审刑院的内容审查结论未据此推断。#582/Doctor 对应审核来源不明。 |
| D 重复结论 | #502：`5931ba8c` 增左拾遗，后 `92209d7d` 等调整；#413：synthetic book helper 与 root:foo 真入口案并存。 | #502 大理寺 `502/runs/01a05a60-a1de-7781-9ac3-4c8d0e956826@judge/current.json` 的 standards-2 曾删 schema introspection/empty-nonempty helper 重复，但**特许保留 callable binding 与非法 discriminator**。这解释了按实例整改后仍保 helper 层的进口；不是“从来没有审测试质量”。该回执具修内司附件并自报 35/35，其他席与 #413 的对应回执来源不明。 |
| S 失效行为 | 同一 #502 validator 后被 #836 原样收卷所淘汰，测试及再导出未随入口退役。`git grep validateRecordedGleanerLeftOutput -- src` 在本票施工前只有定义/导入/再导出，无调用。 | 上行 #502 大理寺回执明确认可当时 validator 分界；不能倒推那时已违后来 #836 的法。当前应归类为契约改变后未退役。#836 改契约时究竟哪些席检查并漏掉这组存量测试，来源不明。修复不恢复拒收：现票与给事中第六卷、符宝郎第九卷已确认只记录。 |
| C 单纯覆盖率 | #342：`c8dccb2d`（另一历史支线同题为 `f40f21fa`）的 public dashed option 遍历、计数 `ok >= 10`、人工规则 covered 集合。 | #342 大理寺 `342/runs/01a0057a-62fd-790c-b6d9-776f714a320c@judge/current.json` 审到 `b1c24cbe`，该 revision 实际仍有此遍历/计数；回执认可 typed 表与聚焦回归并报 8/8。将作监/修内司和御史台经历在该票目录有记录，但本表不以仅存在目录作为已审核这一类的证据，其他席内容结论来源不明。该票早于 2026-08-24 质量法立法，不能以今天法源伪造当日违规；后续存量扫没消除才是本票要记的事实。有效语法负向已并回真实入口，不以覆盖率代替行为。 |

其余未精确追到源票/审核组合的局部案（例如 synthetic anti-forge、B2 中间对象 clipping）均记来源不明，不编造过席链。没有证据证明每个历史审核席审到同一 HEAD；存在一席记录不等于全流程都放行。

## 自审与验证

- 入口：左拾遗改由真实 envelope 执行提交，替换直接 sealed fixture；option 失败输入并回已有 runAkRole 表；tarball 指向的 bin 被真正执行。
- 断言：移除材料清单、生成文案、同 renderer 重算和覆盖率计数；留下公开结构、输入原卷、格式协议与计量。提示词/建议具体语义没有换成快照、哨兵或模板。
- 退役：左拾遗无调用 validator 及其再导出、原 helper 测试、packagedMaterials 和 RELEASE_SOUL_INVENTORY 测试夹具已移除。未修改 Soul、质量法、真配置或安装。
- TDD/引入回归证据：已有左拾遗真入口案绿；临时把旧 validator 接回实际 `ingestStructuredOutput`，同一案在 bounce 输入红（exitCode 实得 1、期望 0；tests 1/pass 0/fail 1）；恢复后绿。第一次误把变异接在同样未被该链调用的 `validateAcceptedDetails`，案仍绿，已撤回，**不作为证明**。没有为变异另建永久证明测试。
- B2 另做变异：临时跳过 `clipToolsToFrame`，同一 `runAnalyst` 源 session 案报红（toolBucket 30s ≠ 10s）；恢复后绿。没有把源数据绕过 reader 拼给 kernel，也没有另加测试函数。
- 左拾遗变异是旧拒收逻辑的可达性实验，不声称回退了完整历史版本，也不声称执行过真实 LLM。
- 聚焦命令与最终结果见本席终局回执；全量只在最终待合并 HEAD 上由 CI 执行，本施工交卷不是该状态。
