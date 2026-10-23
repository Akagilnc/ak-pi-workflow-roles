# #1237 存量测试质量清理交卷

基线：`7997ffb2`；首版：`c950d019`；第二版：`19b7dc7a`。第二版依台院 `01a1628d-443a-71f0-8de8-e9d1c5d92674@inspector/receipts/1.json` 与大理寺 `01a1628f-9dcb-765c-abc5-09b80ad9ed25@judge/receipts/1.json` 的 A/B/C、J1–J5 续修；第三版依大理寺同 run `receipts/2.json` 的 R2-A/R2-B/R2-C 续修（见文末「第三轮」）；第四版依同 run `receipts/3.json` 的 R3-A/R3-B 续修（见文末「第四轮」）；第五版依同 run `receipts/4.json` 的 R4-A/R4-B 续修（见文末「第五轮」）；第六版依同 run `receipts/5.json` 的 R5-A 续修（见文末「第六轮」）；第七版依大理寺 `01a163ff-00d1-7ee0-ae50-de4209edc7c3@judge/receipts/2.json` 的 R6-A/R6-B 续修（见文末「第七轮」）；第八版是对现存全部测试文件的整卷复扫（见文末「第八轮」），每行末尾的「第八轮整卷复扫」即本轮结论。本文是施工记录，不是新测试规范，不限制后续审核；本腿未派角色、未送审。

当前结算以文末「第十七轮」及逐条账 R17 为准；前十六轮保留为历史取证，尤其第十五轮 runId 缺口判断已撤回。

## 方法与边界

盘点基线全部 137 个 `*.test.ts`：unit 19、contract 27、integration 87、adjudication 1、package 2、根目录 1；累计处置为改 67、删 17、留 53（其中原 integration argv 文件迁移到 unit，旧路径计删，新路径不冒充基线文件）。原 105 个“留”文件已按案复核；本轮改表不再以整个文件有行为案为由豁免其中坏案。先逐文件核入口与断言，再打开候选上下文、生产调用点、承接测试及历史。类别仅采用票面五项：M＝内部结构（含镜像），T＝非契约文本，D＝重复结论，S＝失效行为，C＝单纯覆盖率；B 表示留下的行为测试，不是第六项判坏标准。混合文件的“改”包含删除其中坏案，保留其他行为。

不以目录、ADR、负向案或暂停席身份豁免；也不把所有字符串一刀切：CLI argv、JSON 编码、URL/路径、SPDX、外部协议字段属于契约；调用者/上游提交的 opaque payload 原样穿透也属于契约。它们不同于断言包生成的提示词、建议文案或源码组织。计量冻结历史卷宗的结构化统计不是约束 LLM 新产出。

本次没有新造生产函数、测试工具或扫描器。左拾遗改用已有 `roleTurnHostFromStructuredOutputRounds`，真实链路为 `runAkRole → prepareRoleEnvelope → ingestStructuredOutput → ledger → Terminal`，不再由夹具直接替它封卷。退役其无生产调用的旧 validator、再导出及旧测试；同时删除废弃的测试专用 Soul 清单。

改造优先的具体落点：
- 左拾遗在同一既有空弹章入口案中纳入 completed、bounce、pass、只有 countersignStatus 的对象；断言 exitCode、accepted、原始 payloads。
- CLI option 表的自比对、人工全集和 `ok >= 10` 不另造替身。有效的 analyst 模式冲突及重复 option 负向输入并入现有公开入口拒收表，断言零写入/零 dispatch，不删必要失败路径。
- Navigator 整表与按席查询在公开入口互证，不导入内部建议常量；attendance 对照同次 lookup 原回执的状态行。Notary 盲审保父正文变化而 dispatch 不变；Soul 随机输入、engine 文件原字节穿透保留，不锁包内模板措辞。首版将这些输入契约误删，本轮补回并变异验证。
- npm 清单案改为执行 tarball manifest 指定的 bin；许可证、peer、禁止随包复制 method Skills、禁自动注册等对安装者有意义的发布契约仍留。不恢复已撤掉的真实宿主安装/冷启动矩阵。

## 逐文件表

路径与承接行号指本次工作树，后续移动以具名行为为准。完整删除及迁移的文件仍占基线一行。承接者只承接写出的行为，不冒称承接被删的内部布局或文案。

| 测试文件 | 类别 | 处置及理由／入口、结果／承接者 |
| --- | --- | --- |
| `test/unit/activation-envelope-module.test.ts` | D | 改（第八轮整卷复扫，原判留）：首案后半 resolveActivationLedgerHome(绝对路径)===resolve(home,".ak-roles") 与 test/unit/package-home-seam.test.ts:19 同结论，删；相对路径拒收与 writer 重试留第十二轮账：a/D 3。无未证 null。 |
| `test/unit/canonical-json.test.ts` | S | 删：ADR 0030 已撤格式契约，Doctor 只有死导入，无消费调用；承接者 null。连同 canonicalJson/Bytes、私有递归序列化、错误类型与打包入口退役，不制造 consumer。第十二轮账：a/S 5、a/退役 4。无未证 null。 |
| `test/unit/engine-material.test.ts` | B | 本票误判为重复，第十轮改正：路径危险字符与精确 `.`/`..`、空名、NUL 不是重复结论，有承接 `test/integration/public-cli-engine-axis.test.ts:82`。第十轮：该拒收块原先只有 `../escape`、斜杠、反斜杠，走不到精确 `.`/`..`、空名、NUL。`.`/`..`/NUL 补进同一 `--engine` 拒收块；空名被虚线旗解析丢掉，改走同一案的 `set-engine`。第十二轮账：b 6。无未证 null。 |
| `test/unit/gate-officer-resume-accounting.test.ts` | B | 留：结构化投影区分 abort、无 scoped payload、有效状态与回执，不猜最后一行。第八轮整卷复扫：未命中。 |
| `test/unit/headless-host-argv.test.ts` | B | 留：Claude MCP env 文档与 JSON result 解码是外部宿主协议，不是复制包内 registry。第八轮整卷复扫：未命中。 |
| `test/unit/host-neutral-role-envelope.test.ts` | M | 改：删只查 flags/hooks 存在的空壳案；保留真实 factory 注册默认旗后 env fallthrough 的返回值。该空壳只锁 flag/hook 存在，无行为承接者，本账记 a/M，不是未审 null；不保 handler 布局。第九轮更正：role-envelope-engine-axis.test.ts:69 是 engine detour，不是非 Pi 激活。第八轮整卷复扫：未命中。第十二轮账：a/M 4。无未证 null。 |
| `test/unit/host-retry-verdict-relay.test.ts` | B | 留：executeTurn 经假 ACP 边界，opaque retry 原样作为下一次调用输入。第八轮整卷复扫：未命中。 |
| `test/unit/judge-recording-anti-forge.test.ts` | S | 删：只对无生产调用的 on-demand helper 拼 synthetic digest，没有消费任何证据卷；承接者 null，不声称证明录音真伪。第十二轮账：a/S 4。无未证 null。 |
| `test/unit/merger-contract.test.ts` | M | 删：手拼内部 envelope 的 blank attemptId，不是公开输入；`test/integration/public-cli-merger.test.ts:181` 接住从真实 Git 派生后 dispatch/settle，内部 blank 身份案承接者 null。第十二轮账：a/M 4。无未证 null。 |
| `test/unit/navigator-route-table.test.ts` | T | 删：静态建议逐行字数/非空；`test/integration/public-cli-navigator-lookup.test.ts:74` 接住 lookup，文案质量承接者 null。第十二轮账：a/T 3。无未证 null。 |
| `test/unit/package-home-seam.test.ts` | B | 留：显式 home、ledger 路径边界与 typed failure 的纯路径决策。第八轮整卷复扫：未命中。 |
| `test/unit/pi-adapter-agent-start.test.ts` | M/T/S | 改：首案 `:70` 改为按 Pi runner 串接三段真实形状回调（Soul 返 systemPrompt，两段只返 readingMaterial），断言最终 prompt 含 BASE、Soul 与两份材料的 auditedRun 输入且 typed 字段不漏给 Pi；stdin 只解一次、spawn env 无正文仍留。不用同 renderer 重算预期。第七轮（R6-A）：更正上文「spawn env 无正文仍留」：该案只断言 `AK_ROLE_SUMMONS_INSTRUCTION` 缺席，此名自 #1199 起无生产者，整案删，承接者 null；随之删 `src/pi/role-turn-host.ts` 只为剥此名的 `delete env.AK_ROLE_SUMMONS_INSTRUCTION`（删后全仓零命中）。第八轮整卷复扫：未命中。第十二轮账：a/D 2、a/M 1、a/S 3、b 7、仍在 1。第十四轮（R12-A）：无 readingMaterial 时 systemPrompt 原样留下补进同一案 :89，改好 1；其余 b 6。无未证 null。 |
| `test/unit/process-cancel.test.ts` | T | 改：删诊断句式锁，保留 signal aborted、首信号名与 dispose。第八轮整卷复扫：未命中。第十二轮账：a/T 1。无未证 null。 |
| `test/unit/public-cli-option-definitions.test.ts` | M/D/C | 删：表→表、required 全集、owner 元数据与全 option 计数；phase/required/attach 由 `test/integration/public-cli-coder.test.ts:333`、`test/integration/public-cli-fixer.test.ts:41`、各角色 argv 案承接；模式负向并入 `test/integration/analyst-public-cli-sweep.test.ts:93`，重复 option 并入 `test/integration/public-cli-failure-settlement.test.ts:36`。help/owner 元数据自比无行为承接者，本账记 a/M。第十二轮账：a/D 30、a/M 29。无未证 null。 |
| `test/unit/public-cli-registry.test.ts` | M/D | 删：整份 registry 抄表与重复 capabilities；角色路由承接 `test/integration/public-cli-cli.test.ts:374` 的公开 invocation 案及各席真实调用；help 自比、内部字段/顺序承接者 null。第十二轮账：a/M 27。无未证 null。 |
| `test/unit/public-cli-ticket-argv.test.ts` | S/D/M | 改：删无生产消费者 parsePositiveTicketNumber 案并退役函数；删 notary `--source-run` 与 analyst `--ticket` 解析重复（公开 notary source-run 由 `test/integration/audited-run-identity-1166.test.ts:372`、`test/integration/public-cli-notary.test.ts:266` 接住，analyst `--ticket` 由 `test/integration/analyst-public-cli.test.ts:116` 接住）。「parse 结果无 ticket 键」是内部结构断言，无行为承接者，本账记 a/M。第九轮更正：公开 `--ticket` 拒收是另一案 `test/integration/public-cli-countersign-run.test.ts:168`，不是该结构断言的承接；保 countersign 附件与指令。第八轮整卷复扫：未命中。第十二轮账：a/D 5、a/M 2、a/S 5。无未证 null。 |
| `test/unit/test-agent-dir-guard.test.ts` | B | 留：测试夹具写真机器 agent tree 的负向契约，不调用真实写入。第八轮整卷复扫：未命中。 |
| `test/unit/ticket-provenance.test.ts` | B | 留：provenance 文件边界的 malformed/empty 区分与范围数据透传。第八轮整卷复扫：未命中。 |
| `test/unit/user-dialogue-stdin.test.ts` | B | 留：opaque stdin 编解码、碰撞及外部 CLI stdin 参数，不锁 prompt 包装文案。第八轮整卷复扫：未命中。 |
| `test/contract/adr-0086-host-dossier-copy.test.ts` | B | 留：实际卷写失败抛 typed infrastructure 与原 cause；不因 ADR 标签而留。第八轮整卷复扫：未命中。 |
| `test/contract/analyst-412-library-index-book-scope.test.ts` | B | 留：legacy index 与公开 cohort 的 book:N 作用域隔离。第八轮整卷复扫：未命中。 |
| `test/contract/analyst-413-r2-findings.test.ts` | T | 改：本票误判为重复，第十一轮改正。synthetic helper 分类不是重复结论，是 `isSyntheticAnalystBookKey` 的唯一守卫，已在同文件 U3 案 `:205`、`:211` 改好。报错句子断言仍删（T）；保留真实读边界 malformed/empty 及 runAnalyst 的 root:foo cache-miss 回填（`:74`）；同步删失实的“with the file path”名称与注释。第八轮整卷复扫：未命中。第十一轮（R10-A）：`:74` 的 issue/cohort 显式 bookKey 走不到 `isSyntheticAnalystBookKey`。同一 U3 案补了 projectRoot-only 调用：`:205` 断言 basename `root:foo` 不是合成键，`:211` 断言 `root:<absolute>` 是合成键。隔离副本把该函数改成 `return true` 或 `return false`，该案都报红。第十二轮账：a/T 1、改好 4、仍在 1。改好见账内隔离变异。无未证 null。 |
| `test/contract/analyst-b2-frame-buckets-actions.test.ts` | M/D | 改：删直接拼 A2 中间数据喂 kernel 的案；并回同文件 `runAnalyst` 真入口案（`:154`），在 owned 源 session 副本设置 record span 10→20s、message tool span 0→30s，断言输出 wall/tool/action 均 10s、model 0，裁剪端点为帧起止；原独立手算统计仍留。第八轮整卷复扫（D）：删紧跟 equal 之后同值的 notEqual（同一断言重复）；runAnalyst 手算帧桶留第十二轮账：a/D 1、b 10。第十四轮（R12-A）：端点、和式、actions 条数与 kind 补进同一裁剪段 :208–:213，改好 5；wall/tool/model/duration 与跳过 clip 的桶不等仍为 b 5。无未证 null。 |
| `test/contract/analyst-book-key-failure-honesty.test.ts` | B | 留：真实 repo/git 故障的 fallback 与 cause/status，区别非 repo 和基础设施故障。第八轮整卷复扫：未命中。 |
| `test/contract/analyst-gate-cycles.test.ts` | B | 留：从冻结卷宗统计轮次、拒收/缺损、cohort 聚合，断言结构化计量。第八轮整卷复扫：未命中。 |
| `test/contract/collector-self-collect.test.ts` | M/S | 改：删 meta.worker/phases 查表；保留真实 extension 激活后的工具可达/禁止旧收集工具。公开收卷承接 `test/integration/public-cli-collector.test.ts:46`。第八轮整卷复扫（S）：删 7 个已退役 code-collection 工具名缺席的循环（src 零产出，#1088 已删）；输出工具在册与激活、host bash 不拦、write 被拦留第十二轮账：a/M 4、a/S 2。无未证 null。 |
| `test/contract/countersign-role.test.ts` | M/S/T | 改：删 schema identity/第三方 shape、孤立旧 validator、开场长度；空 Soul 拒载留在本文件。公开 converged/continue 收卷由 `test/integration/public-cli-countersign-run.test.ts:185` 接住，内部 validator 拒收不要求恢复。第十轮：类别去掉 D。第八轮把「execute 原样收」记成与 secretariat-role.test.ts「records any status」同结论，不实——该案只执行中书省注册。原样收（含未知字符串 status）由 `test/contract/judge-role.test.ts:388` 执行给事中自己的注册，不是重复结论。第十一轮（R10-B）：台院声明必填与给事中不要求台院字段的承接是 `test/integration/public-cli-cli.test.ts:276`（#620）与 `test/integration/audited-run-identity-1166.test.ts:466`（#1195）。第十二轮账：a/M 17、b 19、a/T 1、a/退役 5。第十四轮（R12-A）：evidence、soul、裸 converged、escalate+note、legacy clauses 补进 :388，改好 7；其余 b 12。无未证 null。 |
| `test/contract/doctor-case.test.ts` | B | 留：loadDoctorCase 读取真实 fixture 卷宗，费用、缺损、路径及证据分页；待设计不等于失效。第八轮整卷复扫：未命中。 |
| `test/contract/doctor-role.test.ts` | T | 改：随机 Soul 是输入穿透而非文案哨兵，已补回宿主 systemPrompt 包含输入的断言；保工具能力面、terminate、candidate、cost，不锁 packaged Soul。第八轮整卷复扫：未命中。第十二轮账：a/T 1。无未证 null。 |
| `test/contract/durable-session-write-failure.test.ts` | B | 留：真实 envelope/public terminal 的持久化失败优先级，保留宿主事实。第八轮整卷复扫：未命中。 |
| `test/contract/gatekeeper-pass-envelope.test.ts` | S/D | 改：删退役 officer-pointer 零行哨兵；保submission gate 的 pass/escalate/transport_failure/no_receipt 结构化分支及 officer 身份。第八轮整卷复扫（D）：#1028 表删 continue/converged 两行原样映射（test/unit/gate-officer-resume-accounting.test.ts #969 案同结论且带路由与 runId）；needs_reask、escalate 带 infrastructureFailure 与 requireSubmissionGate 各分支留第十二轮账：a/S 1。无未证 null。 |
| `test/contract/gatekeeper-projection.test.ts` | D/S | 删：孤立投影 helper 的原样返回；承接 `test/integration/public-cli-seat-pipeline.test.ts:35` 各席公开入口 accepted 收卷（换宿主收卷 `test/integration/pipeline-lifecycle-formalization.test.ts:28`；第九轮改指：原承接的 merger-run 全角色表已在第八轮删除）及 `test/contract/submission-ledger.test.ts:174` 的真实多提交原 params 落账；孤立投影函数已删除。第十二轮账：a/退役 3。无未证 null。 |
| `test/contract/gleaner-left-role.test.ts` | M/S | 删并入：真实入口收卷行为在 `test/integration/public-cli-gleaner-left-run.test.ts:90`；不保死 helper 拒 bounce/pass。第十二轮账：a/D 5、a/M 5、a/S 1。无未证 null。 |
| `test/contract/judge-role.test.ts` | M/T/D/S | 改：删 handler 全集、focused worker 注册/文案重复案及 assertDelivers；从 extension/runtime 到 tool、ledger closure 的空 Soul/未完成提醒/原卷数据等行为仍留。worker phase 承接 `test/integration/public-cli-coder.test.ts:122`、`test/integration/public-cli-fixer.test.ts` 默认 phase 案；空白 unfinished reason 并入本文件 `:629` 的 runtime→tool→收卷案，缺理由/两次提醒/理由重交边界均留。Soul 模板无承接者。第三轮补回 Worker/Judge 输入递送：`:351` Judge、`:587` Coder、`:847` Fixer 既有案断言 `before_agent_start` 返回的 systemPrompt 含 BASE、所载 Soul 与 phase（只查输入到达，不锁标签布局）。第四轮（R3-B）：`:319` 无角色案删 `handlers.has("tool_call") === false` 注册布局锁及与之相抵的注释，改为调用已注册（若有）的 `tool_call` 钩子、断言返回 undefined（不干预工具）；不加载、不加角色工具的既有断言留。第七轮（R6-A）：删 `result.usage === undefined`（#756 已撤 judge 对父回执的 usage 投影，src 无此字段的产出者）。第八轮整卷复扫（D）：删「judge output tool returns an unreadable status」。第九轮更正：当时所指案只送对象型未知 status，不覆盖被删案的字符串型未知 status。字符串与对象型未知 status 现由同文件 `:388` 对 judge 自己的注册断言原样收第十二轮账：a/D 4、a/M 12、a/S 2、b 4、a/T 3、仍在 1。无未证 null。 |
| `test/contract/navigator-attendance-lifecycle.test.ts` | T | 改：删 grace 报错句式锁；保受控 promise/clock 驱动 attendance grace、取消和 settlement；不是实际宿主并发测试。第八轮整卷复扫：未命中。第十二轮账：a/T 1。无未证 null。 |
| `test/contract/navigator-attendance.test.ts` | B | 留：缺状态、无行、arrival、取消、failure/no-terminal；opaque 上游失败真因传递不是锁系统报错句式。第八轮整卷复扫：未命中。 |
| `test/contract/notary-role.test.ts` | M/T | 本票误判为重复，第十一轮改正：旗绑定不是重复结论，是 `readNotaryTicketFlag` 的唯一守卫，公开入口产不出非法值，本账记 c/null。payload helper 已退役，不是重复。audited Soul XML 模板无行为承接者，本账记 a/T。身份字段与 source-run 边界见 `test/integration/public-cli-notary.test.ts:168`、`:266`、`:332` 及 `test/integration/audited-run-identity-1166.test.ts` 的身份字段与 Soul 输入穿透。第十一轮（R10-A）：「blank unbound; valid binds; invalid throws」是 `readNotaryTicketFlag` 的唯一守卫，上述公开入口产不出非法值，仓内无现成扩展激活案能把非法旗送进去，本账记 c/null。模板无行为承接者，本账记 a/T。第十二轮账：a/M 2、a/T 1、a/退役 8、c/null 8。c/null 仅 readNotaryTicketFlag，公开入口产不出非法旗。无未证 null。 |
| `test/contract/oauth-keepalive.test.ts` | B | 留：手动 scheduler、刷新服务边界、single-flight 与 warning 类型/原 cause，不连真实 OAuth。第八轮整卷复扫：未命中。 |
| `test/contract/publish-registry-workflow.test.ts` | B | 留：实际发布脚本、恶意 CHANNEL 不执行 shell、tag/publish 调用输入；外部命令用假 registry 边界。第八轮整卷复扫：未命中。 |
| `test/contract/role-envelope-tool-error.test.ts` | B | 留：真实 tool/envelope 的 isError 与 round infrastructure 分界及持久化故障。第八轮整卷复扫：未命中。 |
| `test/contract/secretariat-role.test.ts` | D/S | 改：删伪多宿主同构循环、重复 unknown status 及旧工具哨兵；保真实工具能力面、任意状态原卷与 ledger。真实多宿主链由 public-cli-secretariat-run 的既有表承接。第八轮整卷复扫（D）：删「output commits original payload to the ledger」——test/contract/submission-ledger.test.ts「one turn two submissions」「ledger records LLM params」同结论；激活工具面与原样收留第十二轮账：a/D 8、a/S 1。无未证 null。 |
| `test/contract/secretariat-static-scan.test.ts` | M | 删：文件名/三符号源码 regex 及 options 全集不是运行行为，无法改好为同一结构禁令的行为案；结构禁令承接者 null。现有 `test/integration/public-cli-secretariat-run.test.ts:400` 接住真实 gate，`test/integration/public-cli-secretariat-run.test.ts:650` 接住 escalate 不派 gate，不声称证明全仓无第二机制。第十二轮账：a/M 10。无未证 null。 |
| `test/contract/session-opening-materials.test.ts` | M | 删：直接让 join helper 读不存在文件，只重证 fs ENOENT；独立 OS 语义承接者 null，不造缺文件证明测试。空 Soul 激活失败仍由 `test/contract/judge-role.test.ts:574` 接住。第十二轮账：a/M 3。无未证 null。 |
| `test/contract/sitian-facade-contracts.test.ts` | M | 改：删路径子串内布局锁；保append/read 门面真正写出/读回的卷、重复记录、malformed 行与诊断。第八轮整卷复扫：未命中。第十二轮账：a/M 1。无未证 null。 |
| `test/contract/submission-ledger.test.ts` | D/M/S | 改：删手列每角色的同构账本循环；保真实 ledger host 的原参数、多提交、基础设施/可改拒绝、未知 run、append failure。第七轮（R6-A）：legacy 记录案删「新记录不带 `priorEventId`」两句（#1089 已删该链，src 零命中）；同案 legacy 记录可读的正向断言留，案名随之改为只陈述该行为。第八轮整卷复扫：未命中。第十二轮账：a/D 6、a/S 3。无未证 null。 |
| `test/contract/ticket-trajectory.test.ts` | M | 改：删 refresh 阈值常量自比；保公开渲染/写页入口，HTML data-* 字段、链接、read-only 与刷新/失败；不比展示文案。第八轮整卷复扫：未命中。第十二轮账：a/M 1。无未证 null。 |
| `test/integration/acp-unknown-client-request.test.ts` | B | 留：假本机 ACP 对端的 JSON-RPC method-not-found 后连接仍可用。第八轮整卷复扫：未命中。 |
| `test/integration/activation-envelope-contract.test.ts` | B | 留：真实 Git common-dir/worktree 身份、spawn cause、durable principal 接纳边界。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-399-book-scope.test.ts` | B | 留：公开 book/ticket/空集合/损坏卷作用域，不因暂停 analyst 删。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-c1-sweep-index.test.ts` | B | 留：runAnalyst sweep 写页/index、LOC 与 lastActivity 的独立手算值。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-c1-sweep-pages.test.ts` | B | 留：入口上的非法 changedLines、倒置时间、live/terminal 区别。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-c2-cohort.test.ts` | B | 留：cohort 合并、全 absent vacancy、cache-miss 重算，非统计展示模板。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-c3-model-groups.test.ts` | B | 留：library runAnalyst 的 model-group 计算、alias 与无 model 排除；CLI 暂停此 face 不抹掉仍支持的库行为。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-c4-ticket-scope.test.ts` | D | 改（第八轮整卷复扫，原判留）：删精确集合 deepEqual 之后的四句 includes===false（同一结论重复）及随之无用的四个常量第十二轮账：a/D 4。无未证 null。 |
| `test/integration/analyst-compute-if-missing.test.ts` | B | 留：公开检索的回填、错误页作用域、写失败与损坏单 run。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-entry.test.ts` | S | 改：删已退役 a2SeamProbe/version 字段哨兵；保唯一 runAnalyst 入口的独立 fixture 统计与原子写页、损坏/活跃卷处理。第八轮整卷复扫：未命中。第十二轮账：a/S 2。无未证 null。 |
| `test/integration/analyst-public-bundle-families.test.ts` | B | 留：公开 bundle 装配 metric families，验证打包后的能力不是复制模块文件表。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-public-cli-sweep.test.ts` | D/C | 改：既有 runAkRole 零写入负向表接入模式混用/缺参/重复 token，替代 option 表镜像；保留成功 sweep 落账。第八轮整卷复扫：未命中。 |
| `test/integration/analyst-public-cli.test.ts` | M/D | 改：删 PUBLIC_ROLE_ARGV 查表案；第三轮删解析案中「空 argv 为 issue 查询」重复（承接 `:160` 公开 bare call），不安全整数等独有边界留；`:116` 公开 ticket 与其余 scope/usage/ghostLegs 已实际消费 parser。第八轮整卷复扫：未命中。第十二轮账：a/D 1、a/M 3。无未证 null。 |
| `test/integration/audited-run-identity-1166.test.ts` | T/D/S | 改：保公开 gate/resubmit/direct 的 auditedRun 身份、schema 输入、原卷；补回 notary prompt≠父正文及同父重交正文改变但 prompt 不变，随机自身/audited Soul 穿透。删模板与重复 summons 计数，不删盲审契约。第三轮：`:152` auditor 改用生产 subject Soul 装载器并比对包内 `souls/<subject>-auditor.md` 字节；`:159` 起各官席断言生产参考材料装载器每次所返的非空内容都原样进入 startup materials（至少载入一次；不锁装载次数，台院 I3-1 后改）。第七轮（R6-A）：删 `decisiveFacts.notaryTerminal === undefined`（#1195 `1ea12daa` 已撤他席终局投影，src 零产出）；同案 role/kind 与原卷 payload 正向断言留。另删两处「非身份材料中带 sourceRunPath/runDirectory 的条数为 0」及只为它存在的 `packageAuditedPathMaterials` 本地 helper（#1166 `ddc9a1dd` 已撤 inspector-parent-binding 路径材料，src 无产出这类材料的路径）；身份材料 deepEqual 留，文件头不再声称守「不加目录路径」。第八轮整卷复扫（S）：删审官工具面不含 ak_get_run_dossier（#1166 ddc9a1dd 已撤，src 零产出）及只为它取 toolNames 的支路；四审席共享身份、同伴原卷、clauses 分席留第十二轮账：a/D 9、a/S 4、a/T 8、仍在 2。无未证 null。 |
| `test/integration/countersign-notary-gate.test.ts` | B | 删文件，行为留（第十轮改类别）：第八轮标 D 不成立。三案是给事中自己的原样收，不是与中书省「records any status」的重复结论。原样收（含未知字符串 status）在 `test/contract/judge-role.test.ts:388`，执行给事中自己的注册第十二轮账：b 10。第十四轮（R12-A）：裸 converged 与 escalate+note 补进 :388，改好 7；未知字符串 status 仍为 b 3。无未证 null。 |
| `test/integration/dossier-resolution.test.ts` | B | 留：HostContext/卷指针读取确实隔离不同 run，不是文案样本计数。第八轮整卷复扫：未命中。 |
| `test/integration/engine-detour-cancel-idle.test.ts` | S | 改（第八轮整卷复扫，原判留）：删「silent detour child is not cut by a package-owned tool idle backstop」——只证已删的 183s idle 闸不再触发（机制已退役、无生产者）；取消传递、spawn 失败与参数错留第十二轮账：a/S 2、仍在 1。无未证 null。 |
| `test/integration/engine-detour-usage-ledger.test.ts` | B | 留：公开 detour→usage ledger 的计量、scope、UTF-8、写失败原事实。第八轮整卷复扫：未命中。 |
| `test/integration/engine-material.test.ts` | D | 删：notes discovery helper 重复；承接 `test/integration/public-cli-engine-axis.test.ts:82` 自由 engine/缺 notes 真实输入及 `test/integration/public-cli-engine-startup-material.test.ts:86` typed material。第十二轮账：a/退役 4。无未证 null。 |
| `test/integration/factory-board-true-home.test.ts` | D/S | 删：依赖本机旧卷、缺卷 skip，所谓独立 oracle 复用生产判定；fixer accepted 事实并入 factory-board 的冻结 family 案，计量/排序/read-only 已由该文件实测。孤儿真家目录 helper 同删。第十二轮账：a/D 51。无未证 null。 |
| `test/integration/factory-board.test.ts` | T/M/S | 改：删“未知票 ×0”、阈值自比和退役字段黑名单；保 data-unknown-count、筛选/排序、read-only、真实计量，叙事不冒充收卷；并入冻结 fixture 的 fixer accepted 事实。第八轮整卷复扫：未命中。第十二轮账：a/M 4、a/S 1、a/T 1、仍在 1。无未证 null。 |
| `test/integration/gate-officer-resume-accounting.test.ts` | T/S | 改：保实际 officer summons/resume、scope/host/run 计量；盲审通过 prompt 不等父正文、恢复前后不变观察，不比较固定句子。第七轮（R6-A）：删 #879 案宿主包装里的 `"materials" in request === false`（`RoleTurnRequest` 无此字段，src 无产出者）；删整个「#1092 station-child notary has no case-dossier pointer material」案：其 attachments/case-dossier、`.case-dossier-stage` ENOENT 与 kind `case-dossier-pointer` 计数 0 都是 #1092 已撤机制的哨兵，余下 converged 投影由本文件 #821 案、盲审 prompt≠父正文由 #879 案（`:291`）承接，stationChild `prepareRoleEnvelope` 原样回 prompt 无独有行为。第八轮整卷复扫：未命中。第十二轮账：a/D 4、a/S 6、a/T 2、仍在 1。无未证 null。 |
| `test/integration/headless-codex-host.test.ts` | S | 改：删退役 dossier 文件哨兵及孤儿调用；保executeTurn 驱动本机假 CLI 的协议、schema 调用输入、thread 绑定/恢复与失败；不调用真实 Codex。第八轮整卷复扫：未命中。 |
| `test/integration/host-retry-verdict-relay.test.ts` | B | 留：headless 与 ACP 是不同外部宿主协议；验证 opaque retry 的真实 stdin 输入，不是同 helper 重测。第八轮整卷复扫：未命中。 |
| `test/integration/host-session-acp-grok-usage-compact.test.ts` | S | 改：删退役 dossier 文件哨兵；保假 ACP host 的实际 session 文件复制、usage 及缺文件/失败路径。第七轮（R6-A）：再删 copy record payload 的 `"ordinal" in … === false`（#1161 `d361c716` 后 landing 不再产出 ordinal，host-session 路径零产出）。第八轮整卷复扫：未命中。第十二轮账：a/S 1。无未证 null。 |
| `test/integration/host-session-acp-write-fail.test.ts` | T | 改：stderr 分块计数改观察已报告；保记录失败不打断宿主 turn 的返回值。第八轮整卷复扫：未命中。第十二轮账：a/C 1。无未证 null。第十五轮旧腿（R13-A）：当时只阻断 warning 的修法已由 R14-A 封驳。第十五轮新腿：同案 :94–107 保 pointer、warning、copy 三阶段写失败；log 全程阻断，以真实 session/prompt 分隔观察；三种 catch 分阶段变异各红，详见 deletion-ledger 末 P/C/W。 |
| `test/integration/host-session-live-records.test.ts` | T/S | 改：删 stderr 分块计数及退役 dossier 哨兵；保本机假 headless native dossier 到 session 副本、指针与失败保真。第七轮（R6-A）：再删 copy record payload 的 `"ordinal" in … === false`（同上）。第八轮整卷复扫：未命中。第十二轮账：a/S 1、a/C 2。无未证 null。第十五轮旧腿（R13-A）：当时仅 warning 受阻的修法已由 R14-A 封驳。第十五轮新腿：同案 :230–245 保 pointer、warning、copy 写失败，仍保覆盖原件及缺源留好副本；三种 catch 分阶段变异各红，详见 deletion-ledger 末 P/C/W。 |
| `test/integration/merger-git-state.test.ts` | B | 留：真实本机 Git merge 状态、无 merge、unborn、损坏身份，不用虚构中间对象。第八轮整卷复扫：未命中。 |
| `test/integration/merger-role.test.ts` | B | 改（第十轮改类别）：第八轮标 D 不成立。删去的 escalate / completed 原样收不是与中书省「records any status」的重复结论；已并入 `test/contract/judge-role.test.ts:388`，执行校书郎自己的注册。无 Git 激活、空冲突材料、工具面留，同席内部没有另一条成立的重复第十二轮账：b 7。第十四轮（R12-A）：第二次 escalate 与 completed 原样收补进 :388，改好 5；escalate 不查 Git 仍为 b 2。无未证 null。 |
| `test/integration/package-home-cli-seam.test.ts` | B | 留：真实 CLI 子进程的 HOME/profile 隔离及缺 profile 时 help/需 home 命令分界。第八轮整卷复扫：未命中。 |
| `test/integration/pipeline-lifecycle-formalization.test.ts` | B | 留：公开组合根换宿主后仍落同一 typed Terminal，非 registry 查表。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-1132-delivery-request.test.ts` | S | 改（第七轮 R6-A，原判留）：删两处 `decisiveFacts.officerPayloads === undefined`（#1195 已撤父侧 officer payload 拷贝，src 只剩 `gatekeeper-role.ts` 一句注释）；公开催交、计数、audit 子卷 ceiling、实际审席 role/kind 与 directionUnsettled 等结构化结果留。第八轮整卷复扫：未命中。第十二轮账：a/S 2。无未证 null。 |
| `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts` | S | 改（第七轮 R6-A，原判留）：删禁名表 attachments/fix-packet.md/task.md/prerequisites.json 与 attachment 的 `frozenPath` 缺席断言（均无生产者）；入口 relocation→inspector→resume 的必备拓扑文件、leg session、结构化路径无陈旧 unbound、admitted 原样路径留。第八轮整卷复扫：未命中。第十二轮账：a/S 2。无未证 null。 |
| `test/integration/public-cli-argv-parsers.test.ts` | D/M | 删原路径／迁移：grammar 案移至 `test/unit/public-cli-argv-parsers.test.ts`；删重复 Collector wait-ms、Coder admission、engine resolver。第三轮再删迁移件中与公开入口同规则同结论者：Coder/Fixer 默认 apply 与显式 plan（承接 `test/integration/public-cli-coder.test.ts:333`、`test/integration/public-cli-fixer.test.ts:41`）、Fixer 已给 prerequisites 路径（同 `:41`）、未知旗与空 `--project`（承接 `test/integration/public-cli-failure-settlement.test.ts:36`）、Collector `--pr`（承接 `test/integration/public-cli-collector.test.ts:87`）。只有解析案能抓的独有边界逐项留在新路径：位置参数拼接、空白 `--project`、缺值 `--attach`（并入 `:8`，取自已删的 Judge 解析案）、Collector `--repo`（`:34`）、Doctor 语法（`:38`）、空 prerequisites 保 opaque 与缺值拒收（`:82`）。迁入后的 `test/unit/public-cli-argv-parsers.test.ts` 第八轮整卷复扫：未命中。第十二轮账：a/D 45、a/M 1、a/S 4。无未证 null。 |
| `test/integration/public-cli-attach-path-passthrough.test.ts` | S | 改（第七轮 R6-A，原判留）：删 run 目录 `attachments` 不存在、attachment 上 frozenPath/sha256/byteLength/provenancePath 缺席、`request-manifest.json` ENOENT、admitted `manifestDigest` 缺席（均为 #1165/#1166/#1169 已撤的冻结副本与摘要，src attachment 投影不产出）；公开传入 opaque path、实际 host flags/请求保持路径、cwd 可异留。第八轮整卷复扫：未命中。第十二轮账：a/S 7。无未证 null。 |
| `test/integration/public-cli-auto-resume-dispatch-throw.test.ts` | B | 留：公开 retry loop 保每次 cause、sink 故障、后续成功与原始异常身份。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-auto-resume-limit-422.test.ts` | D | 改（第八轮整卷复扫，原判留）：删两条直调 runWithAutoResumeLoop 注入 N=4/N=0 的案——同文件经 runAkRole 的 configured N=1/N=0 两案同结论（N→N+1 次派发、0 不续）；配置读写、CLI 拒收与非法注入值留第十二轮账：a/D 4、仍在 2。无未证 null。 |
| `test/integration/public-cli-bin-startup.test.ts` | B | 留：真实 built bin 可启动、exit 状态，不比 help 文案；与 tarball 安装产物接缝不同。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-cli.test.ts` | M/D | 改：删 help/registry 同源自比及重复 resolver；保 CLI config 写盘/不被 local flags 改写、unknown command 零写入、各席 invocation；不再谎称跨进程。第五轮（R4-B）：CLI config 公开案在 bare `config set` 后接一次 Coder 派发，断言 `request.model` 为无 thinking 的持久选择（承接原 config 直接案的持久化 effective selection）；`:` 空后缀经 `config set` 落盘为 `thinking: ""`（opaque 边界）；删对 gatekeeper `resolveEffectiveSeat(...).source` 的 helper 复核（同结论在 `public-cli-config` #620 优先级案）。台院 I5-1 后：删 `roles --model kimi-coding/k3-256k` 块及其 #346 注释——前轮删了其后的 effective helper 断言，块里只剩 exit 0，注释所称「不编造 thinking」已没有断言；裸模型合法由 `public-cli-coder` bare 案（argv、invocation 无 thinking）承接，roles 读不落盘由本案 `overrideResult` 承接。同形状复扫（本票删断言后紧前只剩 exit 断言的块）其余命中都还有独有断言：`overrideResult` 保盘字节不变，`rolesAfter` 在 gate 继承行渲染上独有。第八轮整卷复扫：未命中。第十二轮账：a/D 7、a/M 6。无未证 null。 |
| `test/integration/public-cli-coder.test.ts` | S | 改：删退役 task/dossier 哨兵，宿主中性 /skill: 负向契约保留；保公开 Coder phase、opaque status、audit failure、model/thinking 与 resume；宿主边界提供输入。第五轮（R4-B）：既有「structurally malformed --model is rejected」案由单个 `:provider/model` 扩为同一循环中的空串、无斜杠、空 provider、前导冒号四种坏输入，断言不派发且非零退出（承接原 config 直接拒收案；前导斜杠在 invocation 路径只有这里抓得到）。第七轮（R6-A）：更正上文：当时并未删净。本轮删 resume 案 `--ak-coder-task` 缺席（#1168 已撤，src 零命中）与 session 下 `worker-submission-gate` 目录不存在（src 只在旧件迁移器认该名，运行时不建）；`--skill`、`--thinking` 是 Pi 真实旗，缺席为分支辨别，留。第八轮整卷复扫（S）：更正上文「宿主中性 /skill: 负向契约保留」——`/skill:` 自 `42c7b2d3` 起 src 零产出，resume 请求 prompt 不以它开头的断言是退役机制哨兵，删；`--skill`/`--thinking` 是 Pi 真实旗，留。第十二轮账：a/D 3、a/S 5。无未证 null。 |
| `test/integration/public-cli-collector.test.ts` | D/S | 改：合并 groups/MERGED 重复案，改真实 structured-output→ledger→Terminal，含 lawful ticket；保 CLI/parser 负向输入，不重复两份 wait-ms 拒收。原 `stdout.length > 0` 不在本案补回：accepted 交付走同一 `presentTerminal`，由 `test/integration/public-cli-judge.test.ts:294`、`:386` 的整段 stdout 非空接住（第四轮变异见文末）。第八轮整卷复扫（S）：删「rejects retired --wait-ms」——已退役旗，src 无此旗专门处理，拒收即通用未知旗（公开拒收表 test/integration/public-cli-failure-settlement.test.ts:36 承接）；回执原样穿透与 --pr 绑定留第十二轮账：a/D 7、a/S 2、a/C 1。无未证 null。 |
| `test/integration/public-cli-config.test.ts` | M/D | 改：删 16 席 roster 镜像；local model/thinking 从 runAkRole 真 dispatch 到 request.model，磁盘不变；保 persistence/inheritance/clear/未知 seat，全部 fixture home。第五轮（R4-B）：删六个与公开入口同规则同结论的直接案——disk round-trip（同 `public-cli-cli` config set judge/navigator 落盘）、persistent effective source（同本文件未知 seat 读取案的 persistent 断言）、bare invocation 与带后缀 invocation 的解析/effective（承接 `public-cli-coder` bare 与后缀两段的 argv、invocation 记录，`--model`+`--thinking` 合并由本文件 command-local 案承接）、malformed/opaque（拒收并入 Coder 公开拒收循环，bogus/xhigh 与未知 provider 已由 Coder 公开案承接，空后缀并入 CLI config 案）、persistent bare（落盘同 CLI config 案，argv 同 Coder bare，持久 effective selection 并入 CLI config 案派发观察）。`formatModelSpec` 只供 roles/config 的 TSV 呈现，不另锁。继承、清除、engine residual、持久化拒收、未知 seat 读写各案独有，保留。第八轮整卷复扫：未命中。第十二轮账：a/D 31、a/M 3、a/T 3、仍在 2。无未证 null。 |
| `test/integration/public-cli-countersign-run.test.ts` | S/D | 改：删退役旧旗与 dossier 哨兵；保公开 admission、status、同 session 恢复、ticket assertion 与旧 attempt 残卷隔离。第八轮整卷复扫（D）：删「countersign admission binds the countersign role without inventing a ticket」（直调 admitPublicRole+buildInstructionSeatTurnRequest）——同文件「public countersign path: no 起居郎 handoff stays unbound」经公开入口同结论；附件 frontmatter 不认票等留第十二轮账：a/D 3、a/S 1、仍在 2。无未证 null。 |
| `test/integration/public-cli-diarist-run.test.ts` | S | 改：删退役字段/文件哨兵；保公开 dialogue/diarist 的源卷字节、范围选择、迁移/分票/追加/恢复，不锁新生成叙事。第七轮（R6-A）：再删 `volume.lines.every(line => !("line" in line))`（#926 `9aef80b5` 撤 amendments 后行对象无 line 字段，src 不产出）；同案不可解析原字节落卷的正向断言留。第八轮整卷复扫：未命中。第十二轮账：a/D 1、a/S 3。无未证 null。 |
| `test/integration/public-cli-doctor.test.ts` | B | 留：公开 case admission、完成/拒绝、mandatory audit、officer escalation；待设计不豁免也不自动删。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-engine-axis.test.ts` | M/D | 改：删名册 length===16、重复 resolver/roundtrip/unset 案；保逐席实际 dispatch 与轴优先级，新增输入并入既有负向表：损坏磁盘 engine 经 CLI exit2 且零 dispatch。第八轮整卷复扫：未命中。第十二轮账：a/D 12、a/M 1、仍在 1。无未证 null。 |
| `test/integration/public-cli-engine-resume-detour.test.ts` | B | 留：初始/自动/显式恢复上的 engine 及 live seat table axes，输出 typed 请求。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-engine-startup-material.test.ts` | T/M | 改：runAkRole→prepared host，handbook/dispatchHandbook 等于源文件 UTF-8 的递送契约；保 typed kind/name/model、输入 dispatch，不检查文档措辞。第五轮（R4-A）：此前预期值经生产选路 `resolveEngineMaterialPath`／`resolveEngineDispatchMaterialPath` 计算，与被测读取共用同一选择，错配时双方同错；改为独立读取 `resources/engines/cursor.md` 与 `resources/engine-dispatch.md`，两案同改，删该 import。第八轮整卷复扫：未命中。第十二轮账：b 2。无未证 null。 |
| `test/integration/public-cli-escalation-resume.test.ts` | B | 留：公开 gate escalation/continue/transport_failure 到同次父卷与恢复路由。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-explicit-internal.test.ts` | B | 留：假 CLI 子进程 argv/stdin/env、PATH、SIGTERM/关闭与投递错误，不调用真实模型。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-failure-artifacts.test.ts` | T | 改：删 stdout/stderr 分块计数及死变量；保实际 public terminal/artifact 写故障、旧卷隔离及宿主结果不被产物错误顶替。第四轮（R3-A）：删计数时连交付观察一并删掉是误删；no_receipt 交付在 `:76` 既有 malformed session 案断言整段 stdout 非空；current.json 写入被拒、Terminal 无产物引用时仍须交付，在 `:143` 既有写故障案断言；普通失败交付由共享 `assertPublicFailureSettlement`（`test/helpers/failure-settlement-kit.ts:95`）接住；其余同路径案不逐例补回。第八轮整卷复扫：未命中。第十二轮账：a/C 7。无未证 null。 |
| `test/integration/public-cli-failure-provider-stop.test.ts` | B | 留：真实 public 入口只认宿主 typed report，不从旧 transcript 推造 provider failure。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-failure-real-entry.test.ts` | T/M/S | 改：删输出分块计数；第三轮把 `stderr[0]` 取首块改为整段输出非空，不依赖写入分块；第四轮这两处并入共享 `assertPublicFailureSettlement` 的 stdout/stderr 交付观察（`test/helpers/failure-settlement-kit.ts:95`、`:96`），本文件删去分块观察。第十一轮（R10-A）：宿主 stderr 原样穿透不是分块计数，也不是重复结论，已在 `:296` 改好。`production knownFailure channel` 案在 `:296` 断言整段 stderr 包含注入的 hostStderr（值包含，不用正则）。kit 的非空只观察交付。隔离副本拿掉 hostStderr 附带后该案报红。保公开 entry 的 typed failure 与 packageFact/timeout、封卷后非零退出；保存而不洗白。第七轮（R6-A）：删两处 `notEqual(…, "MissingProviderCredential")`（#987 删前置凭证闸后 src 无产出此名的代码）；「无 cause」由同案 `errorBody.cause === undefined` 守着，留。第八轮整卷复扫：未命中。第十二轮账：a/M 1、a/S 2、a/C 4、改好 1。改好见账内隔离变异。无未证 null。 |
| `test/integration/public-cli-failure-settlement.test.ts` | D/C/M | 改：既有零 dispatch/零 admission 的结构性错误表接住非 repeatable option 重复；第三轮删两处 `stdout.length === 1` 写入次数锁，保 exitCode、Terminal、payload 结构化断言（两案均 accepted，交付观察由 `test/integration/public-cli-judge.test.ts:294`、`:386` 承接；失败案经共享 kit 观察 stdout/stderr 交付）；拒收表的「零写入／有诊断」不锁分块数，留。其余实际 failure/Terminal 分支保留。第八轮整卷复扫：未命中。第十二轮账：a/C 2。无未证 null。 |
| `test/integration/public-cli-fixer.test.ts` | D/S | 改：低层 admission 重复案合入既有公开 opaque prerequisites 表（含 bad-grammar），删除本地孤儿 helper/旧字段哨兵；保公开 opaque prerequisites、phase、restore、声明 prerequisite_unmet 与各合法交卷状态。第七轮（R6-A）：再删漏下的一处 `"packetPath" in admitted === false` 及类型注解里随之无用的 `packetPath`/`prerequisites` 字段。第八轮整卷复扫：未命中。第十二轮账：a/D 10、a/M 1、a/S 13、仍在 1。无未证 null。 |
| `test/integration/public-cli-gleaner-left-run.test.ts` | S/D | 改：`:90` 从真实 structured-output 收卷走到 Terminal，比原参数，覆盖 completed/bounce/pass/无 status；第三轮删 `--bogus` 未知旗解析重复（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），必填 `--base` 解析案独有，留；其余 base、非空弹章、resume 失败路径仍留。第八轮整卷复扫：未命中。第十二轮账：a/D 6、仍在 5。无未证 null。 |
| `test/integration/public-cli-host-axis.test.ts` | S | 改（第八轮整卷复扫，原判留）：删三族宿主 prompt 不以 `/skill:` 开头（`42c7b2d3` 后零产出）与 judge run 下无 `*-home` 子目录（#717 `ce69787d` 已撤 run 级 grok home）四处哨兵；prompt 含原话、planned 回执、HOME 继承等结构化断言留，#822 案名改为陈述所留行为。第十二轮账：a/S 5。无未证 null。 |
| `test/integration/public-cli-instruction-seat.test.ts` | D | 改（第八轮整卷复扫，原判留）：表内 dispatch 行与 pass 行同结论（门下省回执原样进 terminal），删 dispatch 行第十二轮账：a/D 2。无未证 null。 |
| `test/integration/public-cli-judge.test.ts` | D/M/S | 改：删两条直接解析案——未知旗与空 `--project`/`--project=` 重复公开拒收表（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），附件/project 正向重复 `test/integration/public-cli-attach-path-passthrough.test.ts:46`；独有的位置参数拼接、空白 `--project`、缺值 `--attach` 移入 `test/unit/public-cli-argv-parsers.test.ts:8`。删两处 `stdout.length === 1` 写入次数锁，改整段 stdout 非空（`:294`、`:386`，即 accepted 交付观察）。保公开 Judge decisionGate、结构拒收、audit no_receipt 和空请求不发明任务。第七轮（R6-A）：删 internal 激活 argv 不含 `burden` 的断言（src 只在公开拒收拼写里认 burden，internal argv 无产出路径）；公开 burden 拒收仍由拒收表守。第八轮整卷复扫：未命中。第十二轮账：a/D 9、a/S 2、a/C 4。无未证 null。 |
| `test/integration/public-cli-known-ticket-placement.test.ts` | B | 留：公开已知 ticket 对所有席的落盘位置，不用目录猜 ticket。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-main-flow-p0.test.ts` | B | 留：无配置在 dispatch 前失败，以及真实公开 escalate→owner ruling→resume 主链。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-merger-run.test.ts` | D | 改（第八轮整卷复扫，原判留）：删「every packaged role accepts via shared sealed→Terminal entry」——各席经 runAkRole 收 accepted 与 test/integration/public-cli-seat-pipeline.test.ts「every active seat routes, submits, and settles」同结论，换宿主收卷由 test/integration/pipeline-lifecycle-formalization.test.ts 承接；随删只剩它用的行表与五个种子 helper；多次提交、post-seal/no-receipt/infrastructure 留第十二轮账：a/D 5。无未证 null。 |
| `test/integration/public-cli-merger.test.ts` | S/D | 改：删退役 dossier/旧 manifest 字段哨兵；第三轮删解析案中未知旗与空 `--project` 重复（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），Merger 专属的公开 packet 字段拒收与附件正向留；保公开 Merger 从真实 Git 派生 materials，再到 host/Terminal、resume 与 malformed 收卷。第七轮（R6-A）：再删 materials 上 `"task"`/`"authority"` 缺席两句（#1168 已撤，且与同案 materials 键集 deepEqual 重复）。第八轮整卷复扫（S）：再删 transport prompt 不以 `/skill:` 开头（同上，零产出）；prompt 含原话留。第十二轮账：a/D 3、a/S 4。无未证 null。 |
| `test/integration/public-cli-navigator-attendance.test.ts` | T/M | 改：真实父入口到 lookup，建议对应同次回执 byStatus[status]，不同 status 有区别、缺行无建议；父失败 diagnostic 等于输入真因，保 disposition/run/receipt/session。第八轮整卷复扫：未命中。第十一轮（R10-B）：不可用真因断言曾被改弱，第十轮在 `:261` 恢复为与独立复现的文件系统错误值相等，不锁包装措辞。第十二轮账：a/T 4。无未证 null。 |
| `test/integration/public-cli-navigator-lookup.test.ts` | T/M | 改：真实整表与 coder/reviewer/judge 筛选互证，能抓错角色与只剩 coder 的整表；保落原卷、零 host session、usage/记录失败，不导入内部建议常量。记录失败案删 `/EISDIR/` 正则（锁诊断措辞）；第四轮补最小交付观察 `:150` stderr 整段非空——此案无 Terminal，诊断只在 stderr。第八轮整卷复扫：未命中。第十二轮账：a/M 5、a/T 1。无未证 null。 |
| `test/integration/public-cli-notary.test.ts` | D | 改：删与公开负向案重复的 locator/run-state 底层调用；保公开 source locator 输入边界与三态/no_receipt/transport、绑定继承和 Terminal；不是旧 helper 拒收测试。第八轮整卷复扫：未命中。第十二轮账：a/D 4。无未证 null。 |
| `test/integration/public-cli-process-cancel.test.ts` | B | 留：实际 CLI/process 信号入口产生结构化失败并停止受控 host child。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-report-ticket.test.ts` | S | 改：删退役 officer-pointer/旧目录哨兵；保公开中途认票→重定位→记录→恢复，包含真实持久化失败和不同 court 的卷隔离。第七轮（R6-A）：再删 `"runDirectory" in reported === false`（#1171 `ffadda6f` 已从 `ReportTicketResult` 删去该字段）与进度行 model/host/thinking 缺席三句（`TicketProgressLine` 从未有这三字段，无生产者）。第八轮整卷复扫：未命中。第十二轮账：a/S 5、改好 1。改好见账内隔离变异。无未证 null。 |
| `test/integration/public-cli-resume-416.test.ts` | S/D | 改：删 resume-continue 死哨兵；lawful no_receipt/audit_escalation 的 budget 改2，实际验证不重试，删重复 lawful helper 判定；保公开恢复受理、无文件尝试宿主、call-local retry 与 nested seat axes。第八轮整卷复扫：未命中。第十二轮账：a/D 2、a/S 2、a/C 1。无未证 null。 |
| `test/integration/public-cli-resume-callable-seats.test.ts` | B | 留：各 callable seat 的公开 resume 到精确 principal/Terminal，覆盖角色差异。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-resume.test.ts` | S/T | 改：删 resume-continue 哨兵；quota prose 案验证宿主原 diagnostic、cause 缺席，不凭文案分类；保公开 exact principal、模型覆盖/继承、publication 恢复、lease 失败及 opaque ruling。第七轮（R6-A）：再删 live run 目录下 `attachments` 不存在（#1165 起不再拷附件，src 无建此目录的路径）；admitted 原样路径断言留。第八轮整卷复扫：未命中。第十二轮账：a/S 2、a/T 1、仍在 1。无未证 null。 |
| `test/integration/public-cli-reviewer.test.ts` | D/S | 改：解析案删未知旗与空 `--project` 重复（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），并删文件内同一条 inline prose 拒收的第一份（保留带齐其余前置的那份）；`--base`/`--lens`/`--authority-ref` 语法与 reviewer 不收 `--attach` 是独有边界，留。公开双 lens/single lens、失败 sibling 保留、scope 与 same session 留。第七轮（R6-A）：删三处 `--ak-review-task` 缺席（#236 已撤）与 admitted 上 `taskPath`/`taskSha256` 缺席（src 零命中）；`--ak-station-child` 缺席是在役旗的分支辨别，留。第八轮整卷复扫（D/S）：删 project 下无 `docs` 目录（src 无写 docs 的路径）与 resume 对话不含 `/skill:`（紧前一句已断言等于原话，且零产出）；解析案删「省略 lens 即双轴」的正向 deepEqual（同文件「default dual-lens admits both axes」经 runAkRole 同结论），拒收语法与各拼写留，案名随之改。第十二轮账：a/D 5、a/S 7。无未证 null。 |
| `test/integration/public-cli-same-ticket-resume.test.ts` | S | 改：删退役 officer-pointer 哨兵；保公开 re-summon/new/manual resume 的不同身份与审官继续路径，非 ticket 相等就猜 session。第七轮（R6-A）：再删两处 run 目录 `attachments` ENOENT（同上，无生产者）；admitted 原样路径与外部原件可变留。第八轮整卷复扫：未命中。第十二轮账：a/S 3。无未证 null。 |
| `test/integration/public-cli-seat-pipeline.test.ts` | B | 留：真实 public route/提交/report 与 diarist/countersign 二次 summons 不偷续前 run；非配置表自比对。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-seat-self-ticket.test.ts` | B | 留：typed 票号声明才归位，纯文本不推票号，malformed declaration 不拒原卷。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-secretariat-run.test.ts` | D/S | 改：三宿主既有表并入 converged/escalate 原回执及零 nested gate 断言，删伪重复宿主案承接的空结论；保公开中书省→diarist/countersign/notary 链、escalation 与 host failure，不按文本判结论。第七轮（R6-A）：删四案中 `decisiveFacts.countersignTerminal`/`notaryTerminal === undefined`（#1195 `1ea12daa` 已撤他席终局投影，src 零产出）；各案 role/kind 与原回执正向断言留。第八轮整卷复扫：未命中。第十二轮账：a/D 5、a/S 7。无未证 null。 |
| `test/integration/report-ticket-adapter-exit-copy.test.ts` | B | 留：公开真实 adapter（假 CLI/ACP 对端）中途 relocation 后 exit-copy 和 resume 仍在 ticket。第八轮整卷复扫：未命中。 |
| `test/integration/resume-missing-host-session-id.test.ts` | B | 留：executeTurn 无 bound session id 不新建，以及 required disposal failure 保宿主事实。第八轮整卷复扫：未命中。 |
| `test/integration/role-envelope-engine-axis.test.ts` | M/T/S | 改：删 judge/auditor 与 Pi root 两组人工材料清单及 packagedMaterials helper。剩真实 envelope 的 tools/list、request/env 隔离；恢复随机 Soul 输入到 systemPrompt.body 的穿透。第三轮 `:128` 在不覆写装载器的既有案断言包内 `souls/judge.md` 字节进入 systemPrompt。具体材料全集承接者 null，不机械裁定应读哪些法。第七轮（R6-A）：#1092 并发案删种入的 `attachments/case-dossier` 旧文件与按 kind `case-dossier-pointer` 计数为 0（生产零产出该 kind，种文件碰不到断言）；余下「并发 envelope 各自保留 prompt、不写 parent 的 AK_ROLE_RUN_DIR/AK_ROLE_COURT_ATTEMPT」是在役负向（`src/report-ticket-tool.ts:139` 生产中确会写 process.env），案名改为陈述该行为，不并入 #818 案（那案只守 engine env、不带 courtAttemptId）。第八轮整卷复扫：未命中。第十二轮账：a/M 6、a/S 3、b 2。第十四轮（R12-A）：审计官 subject Soul 字节补进同一案 :126，改好 1；judge 随机 Soul 仍为 b 1。无未证 null。 |
| `test/integration/run-terminal-artifacts.test.ts` | B | 留：实际持久化 API 写/读 terminal，unknown/损坏文件与 sibling 隔离。第八轮整卷复扫：未命中。 |
| `test/integration/run-test-all.test.ts` | M | 改：删除 package.json scripts 原串镜像，形式语言不是自比豁免；保真实 runner child argv、选集、HOME 隔离及 exit/SIGTERM。第八轮整卷复扫：未命中。第十二轮账：a/M 6。无未证 null。 |
| `test/integration/test-agent-dir-model-seed.test.ts` | B | 留：fixture models seed 的文件边界、listener cleanup，不写机器 agent tree。第八轮整卷复扫：未命中。 |
| `test/integration/test-process-env.test.ts` | B | 留：实际子进程环境隔离、own home 清理/非 own home 不删的测试基础设施接口。第八轮整卷复扫：未命中。 |
| `test/integration/test-user-profile-preload.test.ts` | B | 留：真实 process preload 的 userInfo/HOME/profile 可用性与隔离，不改宿主配置。第八轮整卷复扫：未命中。 |
| `test/integration/ticket-snapshot-family-edges.test.ts` | M | 改：删只测试 fixture runner 自己拒绝 query 的两案及手工 query builder；保冻结 GitHub payload→真实 snapshot 的 parent/blockedBy、分页等结果，fixture 自测承接者 null。第八轮整卷复扫：未命中。第十二轮账：a/M 3。无未证 null。 |
| `test/integration/ticket-trajectory-binding.test.ts` | D | 改：删重复 legacy/计数，保真实 ledger index/render 消费 typed ticket、legacy、unbound 与 ambiguous run 路径。第八轮整卷复扫（D）：「flat run without ticketNumber」案 length===0 后紧跟同义 some===false，删后者第十二轮账：a/D 5、仍在 1。无未证 null。 |
| `test/integration/worker-submission-gates.test.ts` | S | 本票误判为重复，第二轮改正：unfinished reason 不是重复结论，有承接 `test/contract/judge-role.test.ts:629`。独有空白输入仍走 runtime 收卷；删旧目录哨兵（S），保真实 Git 的 commit 提醒、unborn/失败、开放前缀及现役 hook 清理。第八轮整卷复扫：未命中。第十二轮账：a/S 1、b 9。无未证 null。 |
| `test/adjudication/activation-bare-seam.test.ts` | B | 留：extension 激活入口的 git/durable principal 故障、原 cause、零加载及退出/abort 策略。第八轮整卷复扫：未命中。 |
| `test/package/npm-identity-metadata.test.ts` | M/D/S | 改：tarball manifest bin→真实 --help 正常退出；删 source/Soul/module/packet 手工清单和重复 license 排除。许可证/peer/无 method Skills/禁自动激活仍是安装者契约。第七轮（R6-A）：删 tarball 不含 `patches`、不含 `resources/methods/` 两句（`patches/` 与 `resources/methods` 已从仓删除，`b75a1fe4` 等，无生产者；前六版把它们判作安装者契约留，本轮依大理寺对御史台 C1 边界的驳回「判据是被断言缺席的名字有无生产者，与断言面是否落盘无关」改删）；bin 真实 --help、空自动注册、许可证/peer 留，案名改为陈述所留行为。第八轮整卷复扫：未命中。第十二轮账：a/D 3、a/M 15、a/S 4。无未证 null。 |
| `test/package/published-dist-import-closure.test.ts` | B | 留：实际 build 后用生态 esbuild 解析真实 import edges 并加载根模块；不是手抄模块全集。第八轮整卷复扫：未命中。 |
| `test/primary-aware-cleanup.test.ts` | M | 删（第七轮 R6-B，原判留不成立）：只测测试夹具 `test/helpers/primary-aware-cleanup.ts`，无生产入口，且不在 package.json 任一测试 glob、`scripts/run-test-all.mjs` TIERS 或 CI 之内，从未执行；改不成真入口测试。承接者 null。夹具本身仍被 60 余个测试文件使用，不动。第十二轮账：a/M 12。无未证 null。 |

## 进口账（已冻结卷宗分析）

以下指针根均为 `~/.ak-roles/books/ak-pi-workflow-roles/`。旧版回执保存在 `current.json` 的 `submission.latest.accepted` 或 `terminal.body.outcome`，不假造不存在的 `receipts/` 文件。只把实读的席位列为有证据，不从 merge/commit 作者反推“所有席都审过”。

| 类 | 来源与进入事实 | 实读审核回执／漏点 |
| --- | --- | --- |
| M 内部结构／镜像 | #924：`fa29385a`／`1214035b` 的 secretariat 静态扫描；#524：`4d1a0246` 引入 `EXPECTED_PACKAGED_ROLE_METADATA`；#922：`2a223329` 引入 Soul/reference 两组清单。 | **不能统称所有闸都没发现。** #924 御史台 `924/runs/01a0aa8a-5f5f-7b78-9333-05881cb50b3c@reviewer/current.json` 的 completeness **C2 已明确指出**三符号源码 regex 是内部结构平行契约，建议删除并用现有公开 tracer。当前基线仍在，说明“发现后未落实/后续又留下”，不能写成“没看见”。本地该票未查得将作监、台院、大理寺、审刑院的相应最终处置回执，后续裁决来源不明；#524/#922 相应审核席来源不明。 |
| T 非契约文本 | #1192：navigator lookup/attendance 将建议表内容当 oracle；#582：`3146a77f` 留 Notary 开场模板。首版把 `0ad8a100` 的 Doctor 随机 Soul 输入穿透误记为哨兵，本轮撤回该归类。 | #1192 有将作监 `1192/runs/01a14eb7-544f-7591-a876-66fe7f778cdc@coder/receipts/3.json`、台院 `1192/runs/01a14ed5-38de-75c1-8db1-f2344e1418d8@inspector/receipts/3.json`、大理寺 `1192/runs/01a14ee5-74ad-7f9b-8f04-bdefab1b82f2@judge/receipts/7.json`。最后一卷自述测试 27/27、重复/内部结构类已结清，但表文案 oracle 仍存活。它还说明后续 P3 修理不再等新御史台，不能把旧 reviewer 范围冒充最后 HEAD 的复核。审刑院的内容审查结论未据此推断。#582 对应审核来源不明；Doctor 输入穿透不是坏案，不列进口。 |
| D 重复结论 | #502：`5931ba8c` 增左拾遗，后 `92209d7d` 等调整。#413：synthetic book helper 与 root:foo 真入口案并存，本票误判为重复，第十一轮改正为改好（`isSyntheticAnalystBookKey` 唯一守卫，表 `:205`/`:211`），不列 D 进口。 | #502 大理寺 `502/runs/01a05a60-a1de-7781-9ac3-4c8d0e956826@judge/current.json` 的 standards-2 曾删 schema introspection/empty-nonempty helper 重复，但**特许保留 callable binding 与非法 discriminator**。这解释了按实例整改后仍保 helper 层的进口；不是“从来没有审测试质量”。该回执具修内司附件并自报 35/35，其他席来源不明。#413 已撤出 D，不另追进口审核链。 |
| S 失效行为 | 同一 #502 validator 后被 #836 原样收卷所淘汰，测试及再导出未随入口退役。`git grep validateRecordedGleanerLeftOutput -- src` 在本票施工前只有定义/导入/再导出，无调用。 | 上行 #502 大理寺回执明确认可当时 validator 分界；不能倒推那时已违后来 #836 的法。当前应归类为契约改变后未退役。#836 改契约时究竟哪些席检查并漏掉这组存量测试，来源不明。修复不恢复拒收：现票与给事中第六卷、符宝郎第九卷已确认只记录。 |
| S 失效行为（退役机制的复生哨兵，第七轮补） | 撤机制的同一张票里，把原先断言「有」的测试改成断言「没有」：#1092 `861c2d1f`（case-dossier）、#1195 `1ea12daa`（notaryTerminal/countersignTerminal/officerPayloads）、#1168 `88b36c99`（--ak-coder-task、merger task/authority）、#236 `51ec6c3e`（--ak-review-task）、#1165/#1166/#1169（frozenPath、request-manifest、attachments 目录）、#1089 `e7eb038d`（priorEventId）、#987 `ff3ec84f`（MissingProviderCredential）、#1161 `d361c716`（ordinal；该字段由 #1081 `1c77076d` 引入）、#1171 `ffadda6f`（reported.runDirectory）、#756 `f7e4bbf5`（judge usage）、#1199（AK_ROLE_SUMMONS_INSTRUCTION）、#926 `9aef80b5`（line amendments）、#1043 后 `b75a1fe4`（resources/methods）。 | 实读一卷：#1092 大理寺 `1092/runs/01a0e164-933f-79ab-831f-50a233539df8@judge/history.jsonl` 把新增 170 行的 `public-cli-no-case-dossier-delivery.test.ts` 判为「平行证明性测试」P2，并写明「现有测试接缝可承接负向行为」，即认可 gate-officer、engine-axis 两处「不再装载」哨兵作承接；陛下对那份新文件答「2 不用可能，就是瞎搞」（源卷 uuid `654babe3-2517-4153-9ff7-c11b59ba787f`，见同 run `current.json` 的 admitted.instruction）。漏点：判了新文件，没判同形的存量哨兵。本票自己的 S 类施工按名字而非按形状扫，前六轮又漏下 51 条缺席断言语句，另有两处 kind 计数、两处路径材料计数与一组禁名表（大理寺 `1237/runs/01a163ff-00d1-7ee0-ae50-de4209edc7c3@judge/receipts/2.json` R6-A）。其余各票放行这些断言的席位未逐卷核，来源不明。 |
| C 单纯覆盖率 | #342：`c8dccb2d`（另一历史支线同题为 `f40f21fa`）的 public dashed option 遍历、计数 `ok >= 10`、人工规则 covered 集合。 | #342 大理寺 `342/runs/01a0057a-62fd-790c-b6d9-776f714a320c@judge/current.json` 审到 `b1c24cbe`，该 revision 实际仍有此遍历/计数；回执认可 typed 表与聚焦回归并报 8/8。将作监/修内司和御史台经历在该票目录有记录，但本表不以仅存在目录作为已审核这一类的证据，其他席内容结论来源不明。该票早于 2026-08-24 质量法立法，不能以今天法源伪造当日违规；后续存量扫没消除才是本票要记的事实。有效语法负向已并回真实入口，不以覆盖率代替行为。 |
| M 只测夹具且无运行入口（第七轮补） | `a692f709`（2026-08-04，「test(reviewer): primary-aware teardown for cleanup races」，提交信息无票号）加入根目录 `test/primary-aware-cleanup.test.ts`，只测 `test/helpers/primary-aware-cleanup.ts`；package.json 各 glob 与 run-test-all TIERS 从未包含根目录。 | 来源不明：未找到对应票号与审核席回执。本票前六版逐文件表判它「留」，由大理寺 `1237/runs/01a163ff-00d1-7ee0-ae50-de4209edc7c3@judge/receipts/2.json` R6-B 指出。 |
| D 重复结论（第八轮补） | ① 第八轮误判，第十轮撤出 D：给事中（#632/#753 `69764925` 起的 countersign-notary-gate、countersign-role）、校书郎（`c3cdc17c` merger-role）的原样收不是「同一共享接缝按角色各证一遍」。同一共享函数不是重复结论；二者各走自己的注册，在 `test/contract/judge-role.test.ts:388`。仍记 D 的只剩中书省那份「交卷进账本」：本票第二版 `19b7dc7a` 补回契约时引入，与 submission-ledger 同结论。② 内部接缝与公开入口各证一遍：#422 `7e2cb20f` 直调 `runWithAutoResumeLoop`；#519 全角色 accepted 表与 #505 seat-pipeline；countersign 直调 `admitPublicRole`。③ 同一断言连写：精确集合后再逐个 includes===false、equal 后同值 notEqual。 | #422 有大理寺回执目录 `422/runs/01a02ab2-d9f3-7f24-a006-7e1beb04cc42@judge`、#632 有 `632/runs/01a06d58-f6b1-7b67-a2fb-9d468ecfb3bf@judge`，本轮未逐卷核其对这些案的处置，审核席放行情形来源不明。本票自身：前七版逐文件表把上述文件判「留」或只按点名删，第二版还新引入了一处重复——施工席自己也是进口之一。给事中、校书郎两项是第八轮施工误判，不是历史审核席的放行记录。 |
| S 失效行为（退役机制复生哨兵，第八轮补扫） | #1088 `72bfdf83` 撤 code-collection 工具时把「有」改成「没有」（collector-self-collect 的 7 个工具名）；#1166 `ddc9a1dd` 撤 `ak_get_run_dossier` 与路径材料后留下的缺席断言；#836/#1214 撤包内工具 idle 闸 `bc673bfa` 后留下的「183s 不掐」案；collector `--wait-ms` 退役后留下的拒收案。 | #1088 有台院 `1088/runs/01a0e15f-e804-7b98-8d96-096bf92fc9fc@inspector` 与大理寺 `1088/runs/01a0e16a-847b-7623-8a5b-11004d07ce06@judge` 目录，未逐卷核；其余来源不明。漏点同第七轮：第七轮的形状扫描没有覆盖「循环里 `.has(name)===false`」「`toolNames.includes(X)===false`」「按字段过滤计数为 0」「定时器推进后仍未结束」这几种写法。 |

其余未精确追到源票/审核组合的局部案（例如 synthetic anti-forge、B2 中间对象 clipping）均记来源不明，不编造过席链。没有证据证明每个历史审核席审到同一 HEAD；存在一席记录不等于全流程都放行。

## 自审与验证

- 入口：左拾遗改由真实 envelope 执行提交，替换直接 sealed fixture；option 失败输入并回已有 runAkRole 表；tarball 指向的 bin 被真正执行。
- 断言：移除材料清单、生成文案、同 renderer 重算和覆盖率计数；补回选择、盲审不变性、原字节与随机 Soul 输入穿透。J1 用公开查询结果互证，不用内部常量 oracle；提示词/建议具体语义没有换成快照或模板。
- 退役：左拾遗、Countersign validator、Notary project/retain、Gatekeeper project、anti-forge、listEngineMaterialNames、parsePositiveTicketNumber、canonical JSON 及其调用残留已移除；第六轮再退役测试删除后只剩定义的 help 投影、拒收拼写汇总、建议字数常量、五个 schema 别名与 Fixer admission 选项类型（见「第六轮」）；同时删除 true-home、query builder、retired dossier、本地 Fixer admission 等孤儿测试 helper。基线已无调用且本票未作废的 validateRecorded* 不扩大删除。未修改 Soul、质量法、真配置或安装。
- TDD/引入回归证据：已有左拾遗真入口案绿；临时把旧 validator 接回实际 `ingestStructuredOutput`，同一案在 bounce 输入红（exitCode 实得 1、期望 0；tests 1/pass 0/fail 1）；恢复后绿。第一次误把变异接在同样未被该链调用的 `validateAcceptedDetails`，案仍绿，已撤回，**不作为证明**。没有为变异另建永久证明测试。
- B2 另做变异：临时跳过 `clipToolsToFrame`，同一 `runAnalyst` 源 session 案报红（toolBucket 30s ≠ 10s）；恢复后绿。该跳过不证明裁剪端点字符串。第十四轮把端点补进同一裁剪段：不改写 startedAt 时 :212 实得 00:00:00、期望 00:00:10；只不改写 endedAt 时 :213 实得 00:00:30、期望 00:00:20。没有把源数据绕过 reader 拼给 kernel，也没有另加测试函数。
- 左拾遗变异是旧拒收逻辑的可达性实验，不声称回退了完整历史版本，也不声称执行过真实 LLM。
- 全量只在最终待合并 HEAD 上由 CI 执行，本施工交卷不是该状态。

### 第二轮变异与聚焦证据

命令前缀均为 `node --import tsx --import ./scripts/test-process-env-preload.mjs --test`。变异只临时修改生产调用点，逐项运行现有案，随后恢复；没有永久变异工具或新增证明案。下表“红”数字为 tests/pass/fail，日志根 `/tmp/1237-r2-`（同一工作机，可由本腿工具调用核对）。

| 临时变异／契约 | 既有入口案与命令尾部 | 红／日志后缀 |
| --- | --- | --- |
| Notary 改读父正文，含同父重交 | `test/integration/audited-run-identity-1166.test.ts test/integration/gate-officer-resume-accounting.test.ts` | 8/5/3；`mut-notary-all.log` |
| lookup 错取 reviewer / 整表只剩 coder | `--test-name-pattern='--role: only' test/integration/public-cli-navigator-lookup.test.ts` | 各1/0/1；`mut-nav-role-final.log`、`mut-nav-full-final.log` |
| status 固定选 converged | `test/integration/public-cli-navigator-attendance.test.ts` | 10/6/4；`mut-nav-status.log` |
| handbook / dispatchHandbook 改空串 | `--test-name-pattern='#1167 public fixer' test/integration/public-cli-engine-startup-material.test.ts` | 各1/0/1；`mut-handbook.log`、`mut-dispatch-handbook.log` |
| Pi 只剥 readingMaterial 不折叠 | `--test-name-pattern='Pi adapter strips' test/unit/pi-adapter-agent-start.test.ts` | 1/0/1；`mut-pi-fold.log` |
| envelope 丢 Soul | `--test-name-pattern='shared envelope registers engine' test/integration/role-envelope-engine-axis.test.ts` | 1/0/1；`mut-envelope-soul.log` |
| Notary 丢自身 / audited Soul | `--test-name-pattern='#1166 direct' test/integration/audited-run-identity-1166.test.ts` | 各1/0/1；`mut-notary-soul.log`、`mut-audited-soul.log`，Terminal 保留对应 includes 输入断言的原异常 |
| Doctor 丢 Soul | `--test-name-pattern='Doctor activation delivers' test/contract/doctor-role.test.ts` | 1/0/1；`mut-doctor-soul.log` |
| 父失败真因换成 generic fallback | `--test-name-pattern='parent host failure' test/integration/public-cli-navigator-attendance.test.ts` | 1/0/1；`mut-parent-cause.log`，expected PARENT HOST BOOM，actual role run failed with exit 1 |
| lawful 仅认 accepted，错误重试 no_receipt/audit_escalation | `--test-name-pattern='^F1: (audit_escalation\|no_receipt)' test/integration/public-cli-resume-416.test.ts` | 2/0/2；`mut-lawful-resume.log`，autoResumeCount 2≠0 |
| 空白理由误当有效（去 trim） | `--test-name-pattern='coder apply unfinished without reason' test/contract/judge-role.test.ts` | 1/0/1；`mut-blank-reason.log` |

恢复绿：`mutations-restored.log` 为上述 A 类相关11文件 72/72/0；J1 改为公开入口互证后 `judge-fixes.log` 为31/31/0；最后 Notary/理由变异恢复后，`test/integration/audited-run-identity-1166.test.ts test/integration/gate-officer-resume-accounting.test.ts test/contract/judge-role.test.ts` 为22/22/0（`last-restored.log`）。

本轮触及面聚焦：命令前缀加 `$(git diff HEAD --name-only --diff-filter=AM -- 'test/**/*.test.ts') test/unit/public-cli-argv-parsers.test.ts`，输出 `tests 354 / pass 354 / fail 0 / duration_ms 19605.121375`（`focused-final.log`）。构建入口退役另验 `test/package/published-dist-import-closure.test.ts test/package/npm-identity-metadata.test.ts`，输出 `tests 4 / pass 4 / fail 0 / duration_ms 3751.560917`（`package.log`）。`pnpm exec tsc --noEmit` exit0；`git diff --check` 无输出。严格 unused 扫描另有基线遗留诊断，不冒称该额外扫描绿。

自审逐项：本轮没有新增生产函数；新增行中的 test 名均为既有案改名/合并或4个 parser 案迁移，未扩增案数。Doctor `harness` 为原地扩充 startup 捕获，不是第二套 harness。逐个对照同入口：空白理由并入 judge-role，groups/MERGED 并入 Collector，多宿主 original receipt 并入 Secretariat，true-home accepted 并入冻结 board；其余无平行案可再合并。完整 diffItems 随第二轮回执逐名呈交。第三轮没有新增测试函数或生产函数；Pi adapter 首案、unit parser 三案、Merger 解析案只是原案改名，逐名列入第三轮回执。

### 第三轮（大理寺 receipts/2.json R2-A/B/C）

命令前缀同上。变异只临时改生产调用点，跑后从备份恢复，`git diff --exit-code -- src` 为空；未新增测试函数或生产函数。

| 类／临时变异 | 既有案 | 结果 |
| --- | --- | --- |
| R2-A Worker 删 `${soul}`（coder、fixer） | `test/contract/judge-role.test.ts` | 14 案 2 败（`:553`、`:813`） |
| R2-A Worker / Judge 删 `${event.systemPrompt}` 或 Judge 删 `${soul}` | 同上 | 各 1 败 |
| R2-A Pi fallback `systemPrompt ?? ""` | `test/unit/pi-adapter-agent-start.test.ts` | 3 案 1 败（`:70`） |
| R2-A 参考材料回调不返回 / 主席或 auditor 参考装载器返 "" | `test/integration/audited-run-identity-1166.test.ts` | 3/3、2/3、3/3 败 |
| R2-A 生产 Soul 装载器（主席／auditor）返固定串 | `audited-run-identity-1166` 加 `role-envelope-engine-axis` | 主席 1 败（engine-axis `:128` 所在案），auditor 2 败 |
| R2-C 位置拼接、空白 project、缺值 attach／prerequisites、空 prerequisites、`--repo` | unit+contract+integration 全目录 | 每项仅 `test/unit/public-cli-argv-parsers.test.ts` 对应案 1 败（缺值 prerequisites 那次另有 `role-envelope-engine-axis` 的 #1092 并发案以 ENOTEMPTY 清理失败报红，与 prerequisites 无关） |
| R2-C 未知旗、显式 phase、`--pr`、`--source-run`、analyst 空 argv 改 sweep | 同上 | 公开承接者红：拒收表等 4 败、Coder/Fixer 公开 6 败、`#676 J2` 1 败、130 败、analyst bare 等 5 败 |

R2-B 只删写入次数锁，不需变异；改后 `public-cli-failure-settlement`、`public-cli-judge`、`public-cli-failure-real-entry` 23/23 绿。触及的 12 个测试文件聚焦 74/74/0；`pnpm exec tsc --noEmit` exit0。

基线就缺、不是本票改弱的：reviewer 父席、Collector、Merger 的 Soul 递送，以及 filed 席、Notary、Doctor 的 BASE 保留——基线与 HEAD 都没有能抓的断言，本轮不另建证明案，列为缺口。生产 Soul 装载器读哪份文件，只用包内文件字节比对 Judge 与 auditor 两处，不抄 role→文件全表。

台院 I3-1（`01a1636a-9df8-790c-95ff-fcaded9826a7@inspector/receipts/1.json`）后：删 `audited-run-identity-1166` 对注入参考装载器的调用次数等值断言。复验：`src/role-runtime.ts` 装载点前多调一次同参装载（送达不变）→ 1166 3/3 绿；`roleReferenceMaterials = ""` → 3/3 败；恢复后 `git diff --exit-code -- src` 为空。同形状扫描（本票测试净增中对 `.length`/calls/count/loads/dispatched 的等值断言）在 `538df48b` 只命中这一处，改后零命中。

### 第四轮（大理寺 receipts/3.json R3-A/B）

R3-A 交付辨别力：本票删的 stdout/stderr 观察逐条见回执 classResults；按交付分支各留一处最小观察（整段输出非空，不锁分块、措辞），不逐例补回。新增 `test/helpers/failure-settlement-kit.ts:95`–`:96`（失败 stdout/stderr，经 kit 覆盖全部失败案）、`test/integration/public-cli-failure-artifacts.test.ts:76`（no_receipt stdout）、`:143`（current.json 写入被拒仍交付）、`test/integration/public-cli-navigator-lookup.test.ts:150`（无 Terminal 的记录失败 stderr）；`test/integration/public-cli-failure-real-entry.test.ts` 两行同义 stderr 观察并入 kit 后删除。

R3-B 注册布局锁：同形状扫描（测试中对 hook 注册表 has/size/keys 的断言）只命中 `test/contract/judge-role.test.ts` 一处，已改为行为断言。`tools.has` 断言是模型可见工具面（行为），`activation-bare-seam` 的 `assert.ok(found)` 是调用前置，不同类。

变异（备份→改生产调用点→跑→从备份恢复，`git status --short src` 为空）：

| 临时变异 | 聚焦文件 | 结果 |
| --- | --- | --- |
| `presentFailureTerminal` 删 `io.stdout` | failure-artifacts/settlement/real-entry/provider-stop、navigator-lookup、public-cli-judge/collector、judge-role、collector-self-collect | 59 案 15 败（14 例 kit 失败交付、1 例 no_receipt） |
| `presentFailureTerminal` 删失败 stderr | 同上 | 15 败，均 kit stderr 观察 |
| `presentTerminal` 删 accepted 分支 stdout | 同上 | 2 败（public-cli-judge `:294`、`:386` 所在案） |
| `presentTerminal` 删 held 回放 | 同上 | 15 败 |
| 外层 catch 删 stderr 诊断 | 同上 | 1 败（navigator-lookup `:150`） |
| `tool_call` 钩子改为装载即注册（保原守卫，删惰性注册） | judge-role、collector-self-collect | 15/15 绿（大理寺 receipts/3.json 隔离复现：旧布局锁在同类重排下 2 案 1 败） |
| 装载即注册一个无条件 block 的 `tool_call` | 同上 | 2 败（无角色案、Collector 案） |
| `presentTerminal` 遇无产物引用的 Terminal 即不交付 | 第一组 | 2 败（failure-artifacts `:76` no_receipt 案、`:143` 写故障案）；`post-admission` 失败收尾处同样门控 59/59 绿，该案不走那个调用点 |

恢复后同一组 59/59 绿。另核 Collector accepted 交付：临时在其案补整段 stdout 观察，删 accepted 分支 stdout 即红、删 held 回放仍绿，确认走 accepted 分支，由 public-cli-judge 两案承接；探针已撤。

### 第五轮（大理寺 receipts/4.json R4-A/B）

R4-A 预期值借被测选路：同形状扫描（测试里以生产路径／选路函数算出预期，再与送达值比较）只命中 `public-cli-engine-startup-material` 四行，改为独立读取包内源文件。`public-cli-engine-axis` 的 `resolveEngineMaterialPath` 只作 `access()` 存在性前置，不充当预期；`readableGateItem` 几处是 `notEqual` 否定断言，真预期是独立的 `JSON.parse(prompt)` 等值；`resolveHostDossierLandingPath`／`resolveSitianRecordPath` 用于找输出落点，非输入递送预期——均不同类。

| 临时变异 | 聚焦文件 | 结果 |
| --- | --- | --- |
| `resolveEngineMaterialPath` 把 cursor 指向 `codex.md` | `public-cli-engine-startup-material` | 0 过 2 败（改前 2/2 绿） |
| `resolveEngineDispatchMaterialPath` 指向 `codex.md` | 同上 | 0 过 2 败（改前 2/2 绿） |

恢复后 2/2 绿，`git status --short src` 为空。

R4-B 模型配置重复结论：逐案对照（输入、生产调用链、断言）后的删并见逐文件表 `public-cli-config`／`public-cli-cli`／`public-cli-coder` 三行。变异（同上恢复）：

| 临时变异 | 聚焦文件 | 结果 |
| --- | --- | --- |
| `parseModelSpec` 的 `fallbackThinking ?? "low"` | `public-cli-config`、`public-cli-cli`、`public-cli-coder` | 24 案 3 败（CLI config、Coder bare、Coder 未知 model） |
| `seatModelOnly` 对 bare 行补 `thinking: "low"` | 同上 | 1 败（CLI config 案的持久 bare 派发） |
| 斜杠检查放宽为 `slash < 0`（接受空 provider） | 同上 | 1 败（Coder 公开拒收循环）；`config set` 另有落盘校验拒空 provider，invocation 路径会带空 provider 派发 |
| 空后缀折为 undefined | 同上 | 1 败（CLI config 案空后缀落盘） |
| 删空串守卫 | 同上 | 24/24 绿：空串随后被斜杠检查拒收，公开行为不变，生产冗余而非测试缺口 |

恢复后 24/24 绿，`git status --short src` 为空；`tsc --noEmit` exit0。

台院 I5-1 删 `bareRoles` 块后：config/cli/coder/startup-material 26/26 绿；`fallbackThinking ?? "low"` 与「parseModelSpec 拒裸模型」两种变异的失败集都还是 CLI config、Coder bare、Coder 未知 model 3 案，没有缩小。

### 第六轮（大理寺 receipts/5.json R5-A）

R5-A 测试删除后专用生产旧物未退役。判据：符号的基线消费者在本票删除或改写的测试里，且该消费者删除后当前全仓（src/test/scripts/extensions）只剩定义。基线就没有消费者的（如 `engineMaterialRelativeDirectory`、`projectLawfulAuditorOutput`、`CountersignVerdictParameters` 等 35 个）不属本类，不删。

| 退役项 | 基线消费者（已删） |
| --- | --- |
| `helpDocumentForCommand`（`src/public-cli/cli.ts`） | `test/unit/public-cli-option-definitions.test.ts` |
| `helpDocument()` 的 `executable`、`globalOptions` 字段及 cli.ts 的 `projectOwnerOptions` 导入 | `test/integration/public-cli-cli.test.ts` help 案、`test/unit/public-cli-option-definitions.test.ts:83` |
| `allRejectedSpellingTokens`（`src/public-cli/option-definitions.ts`） | `test/unit/public-cli-option-definitions.test.ts` |
| `NAVIGATOR_ADVICE_MAX_CHARS`（`src/navigator-route-table.ts`） | `test/unit/navigator-route-table.test.ts` |
| `countersignVerdictSchema`、`judgeVerdictSchema`、`notaryOutputSchema`、`auditorOutputSchema`、`inspectorOutputSchema` 五个 schema 别名及随之失效的导入 | `test/contract/countersign-role.test.ts` schema identity 案 |
| `AdmitFixerInvocationOptions`（`src/public-cli/invocation.ts`） | `test/integration/public-cli-fixer.test.ts` 本地 admission helper（第二版已删） |

保留边界：`helpDocument()` 的 `capabilities`（`renderHelp` 在读）和 `internalEntrypoint`（基线即无读者，不属本类）；`projectOwnerOptions`/`StructuredOptionProjection` 仍由 `renderHumanOwnerOptionLines` 消费；`InspectorOutputParameters` 基线即无消费者，不属本类，改为直接取 `inspectorSubmissionSchema` 的类型，不再经别名；`NAVIGATOR_ROUTE_TABLE` 只在本文件内还有生产读者，不删。第九轮：`GATE_OFFICER_SEATS` 在 gleaner-left 案删除后已无运行时取值读者（`isGateOfficerSeat` 读的是 `packagedProvinceConfig`，不是该数组），已删；`GateOfficerSeat` 改为从 `PUBLIC_ROLE_RECORDS` 的 `provinceConfig` 推导。真实 schema 声明仍由 `src/role-submission-declarations.ts` 直接取共享 schema。

复扫：同一扫描对当前树再跑，基线有测试消费者而当前只剩定义的导出为 0；`tsc --noEmit --noUnusedLocals --noUnusedParameters` 与基线相比没有新增未用项。`tsc --noEmit` exit0；import 了上述模块的 56 个测试文件加 engine-startup-material、navigator-lookup、notary、failure-artifacts、pi-adapter-agent-start、config、coder 共 392/392 绿。`ak-role --help`、`coder --help`、`analyst --help` 输出与 HEAD 逐字节相同。本轮没有新增测试或生产函数。

### 第七轮（大理寺 01a163ff…@judge receipts/2.json R6-A/R6-B）

R6-A 已退役机制的复生哨兵。判据按形状不按名字：测试断言某名字缺席（`"x" in o === false`、`o.x === undefined`、`hasOwn(o,"x") === false`、`args.includes(flag) === false`、`notEqual(v, NAME)`、`existsSync`/`access`/`readdir`/`lstat` 得 ENOENT、禁名表、按 kind 过滤计数为 0），而该名字在 src/extensions/scripts/souls 中、在被断言的那个对象或那个面上没有任何生产者，也不是外部 CLI 的真实旗或在役替代路径。扫描对 test/ 全树逐语句跑，命中 375 条，逐条对生产者；属本类的 51 条，加补扫（`length, 0` 计数形状、禁名表循环）找到的两处 kind 计数、1166 两处路径材料计数与一组禁名表，全部删除（明细见上表各行「第七轮」）。整案只剩哨兵的删整案（gate-officer #1092 station-child、pi-adapter #1199）；同案独有的正向或真负向结论保留（submission-ledger legacy 读取、failure-real-entry 的 `cause === undefined`、engine-axis 的并发 env 不写）。随改动作废的生产旧物：`src/pi/role-turn-host.ts` 中只为剥退役名的 `delete env.AK_ROLE_SUMMONS_INSTRUCTION`，删后全仓零命中。`config.ts` 的 `missingPublicProviderCredential` 基线即无调用方，不是本轮作废，不删。

不入本类（在役名字的分支辨别或真负向）：Pi 真实旗 `--continue`、`--skill`、`--thinking`；在役旗 `--ak-engine`、`--ak-station-child`、`--ak-notary-source-run`；持久化 report 的 `payloads`（`src/public-cli/settlement.ts:1560` 在役剥离）；navigator `byRole`/`byStatus`、process-cancel `cancelName`/`signal`、analyst `wallMs`/`durationMs`/`issueNumber`、publish `publishVersion`/`publishTag`、invocation 的 `thinking`/`engine`/`engineModel`、notary schema 的 `clauses`、迁移行的 `sessionParent`（`src/book-topology-record-class-migrators.ts:467` 产出）、`readingMaterial`、`knownFailure`/`hostFailure`/`cause`/`terminal`/`ticketNumber` 等在役字段的另一分支；拒收不建 run、relocation 后 unbound 叶消失、hooks 清理、symlink 写拒绝、迁移器消费旧件等在役路径的 ENOENT/existsSync。

R6-B：根目录 `test/primary-aware-cleanup.test.ts` 删除，承接者 null，进口账见上。test/agent-dir 两个闸类测试与 adjudication 层不动。

验证：全局零命中的一组（taskPath、taskSha256、--ak-review-task、--ak-coder-task、packetPath、priorEventId、frozenPath、provenancePath、request-manifest.json、case-dossier、MissingProviderCredential、notaryTerminal、countersignTerminal、AK_ROLE_SUMMONS_INSTRUCTION、fix-packet.md、prerequisites.json）`git grep -F <name> -- src extensions scripts souls` 均为 0，officerPayloads 只剩 `gatekeeper-role.ts:311` 一句注释；名字别处在役、只在被断言面上无产出的一组按面核：`ReportTicketResult`（`src/report-ticket-tool.ts:96`）无 runDirectory，`TicketProgressLine`（`src/ticket-progress.ts:50`）无 model/host/thinking，`TicketProvenanceLine`（`src/ticket-provenance-contracts.ts:55`）无 line，`src/judge-role.ts` 全文无 usage，host-session landing payload 无 ordinal，burden 只在 `src/public-cli/option-definitions.ts:221` 的拒收拼写，worker-submission-gate 只在 `src/worker-submission-gates.ts:3` 注释与迁移器常量，带路径的 inspector-parent-binding 材料删于 `ddc9a1dd`，`RoleTurnRequest` 无 materials；同一扫描复跑 324 条，均为上述不入本类的在役名；`tsc --noEmit` exit 0；本轮触及的 23 个测试文件聚焦 191/191 绿，补删后 audited-run-identity 3/3、engine-axis 复跑绿。本轮没有新增测试或生产函数。

### 第八轮（现存测试整卷复扫）

派单文字称「陛下新令」，未附原话或指针；本轮按票面既有授权施工（「目的」：扫全仓测试，覆盖 unit、contract、integration、adjudication、package 各目录和根目录；判坏唯一判据为 quality-law 那一句），不把派单文字标作陛下 authority。

尺子（判完不回改）：
- M 内部结构：断言对象是抄进来的清单、常量、注册表、源码组织或钩子布局。经模块接口在结构化返回值上断言的契约/单元测试不算 M（前几轮大理寺已认）。
- T 非契约文本：对包生成的自由文本（prompt、建议、diagnostic 措辞、help 正文）建机械依赖。CLI argv、JSON 键、路径、外部协议字段、opaque 原样穿透不算。
- D 重复结论：同一真入口或同一共享接缝的同一结论在两案以上，或同一案里同义断言连写。
- S 失效行为：被测机制在生产中已无产出路径（含退役名缺席哨兵与「已删机制不再触发」案）。
- C 单纯覆盖率：全集遍历逐项 trivially 断言、计数下限、人工 covered 集合。
判词已裁的边界照用：agent-dir 两闸、adjudication 层、Pi 真实旗（`--continue`、`--skill`、`--thinking`）、`settlement.ts:1560` 剥 payloads。本席另按同一产出者判据自判：显式拒收已删旗的在役分支（analyst `--project-root`/`--model-groups`、merger `--targetObjectId`，`src/public-cli/invocation.ts:913`、`:2460`）不入 S；`/skill:` 不是旗而是已撤的包内前缀（`42c7b2d3` 后零产出），入 S。

方法：先机械取候选，再开卷定性。① S：src 导出只剩定义而测试在用的反扫（7 个，开卷后均为在役或基线死物，不入本类）；② 第七轮缺席形状脚本加补扫（`.has(变量)`、`includes(常量)`、计数为 0）；③ T：`assert.match`/`doesNotMatch`/长字面量 includes 逐个开卷；④ 全部 122 个现存文件逐个读：小文件读全文，大文件读全部测试标题与断言行、对可疑处开卷到函数体。

结果：本轮开扫时现存 122 个文件，命中 22 个（21 个改、1 个整文件删除，表内带「第八轮整卷复扫（类）」或「原判留」字样），其余 100 个未命中；9 行由「留」翻为「改/删」（unit activation-envelope-module；integration merger-role、countersign-notary-gate、analyst-c4-ticket-scope、engine-detour-cancel-idle、public-cli-instruction-seat、public-cli-auto-resume-limit-422、public-cli-merger-run、public-cli-host-axis）。其中 coder、host-axis、merger、reviewer 四个是交卷前复核时补出：第一遍把 `/skill:` 误归为「Pi 真实旗」边界、漏核 reviewer 的 `docs` 与 host-axis 的 `*-home`，前判为留是因为前几轮只按点名类收、没有横向比对共享接缝与公开入口上的同一结论。删测试后作废的生产旧物：无（逐个核对本轮删去断言里出现的标识符，src 导出与 test/helpers 导出均无新增孤儿）。基线即死的 `src/host-contracts.ts:116` collector `waitMs` 类型字段、`src/judge-auditor.ts:7` `SOUL_AUDIT_TOOL_NAME` 别名不是本轮作废，不动。

验证：`npx tsc --noEmit` exit 0；每批改动后对触及文件跑聚焦测试（unit+contract 32/32、小 integration 29/29、大 integration 12/12、复核补删 41/41），全绿。复扫：第七轮缺席形状脚本在本轮末复跑，相对第七轮末 324 条减为 321 条（减少 3 条、新增 0 条）；本轮补扫命令（`.has/.includes/.startsWith/.endsWith(...) === false` 单行形状）在本轮起点 e898b1ab 上 45 条命中逐条定性，见回执。全量留待最终待合并 HEAD 由 CI 执行。本轮没有新增测试函数或生产函数，只有删除与案名改写。

### 第九轮（大理寺 01a163ff receipts/3.json R8-A/R8-B/R8-C）

R8-A：给事中、校书郎的原样收并入 `test/contract/judge-role.test.ts:388`，各走自己的注册；同一循环补字符串型未知 status。不另开文件，不新增别的案。

R8-B：上表承接说法按所指案的标题和断言改过。不实的改为实话或 null；行号漂移改指该案。

R8-C：删 `GATE_OFFICER_SEATS`。`isGateOfficerSeat` 仍读 `packagedProvinceConfig`。不另加生产禁令。

### 第十轮（大理寺 01a163ff receipts/4.json R9-A/R9-B）

R9-A：守在役分支、承接未经变异证明的删除或改弱，补进现有真入口，不另开文件、不新增测试函数。台院 `suspect`/`ticketComplexity` 必填与 `hits` 为数组，在现有台院公开入口 `test/integration/public-cli-cli.test.ts:276`（#620）上于 `runAkRole` 返回后断言（宿主回调里抛错会被入口接住）。引擎名精确 `.`/`..`、NUL 补进同一 `--engine` 拒收块；空名被虚线旗解析丢掉，改走同一案的 `set-engine`。导航员不可用真因与独立复现的文件系统错误做值相等，不锁包装措辞，位置 `test/integration/public-cli-navigator-attendance.test.ts:261`。给事中声明不要求台院字段，在现有 `test/integration/audited-run-identity-1166.test.ts:466`（#1195）返回后断言。

R9-B：进口账 ① 撤出给事中、校书郎的 D；逐文件表对应行类别改为 B 或去掉 D。中书省与 submission-ledger 的同结论仍记 D。

### 第十一轮（大理寺 01a163ff receipts/6.json R10-A/R10-B）

R10-A：逐条账在 `docs/research/issue-1237-deletion-ledger.md`。计数命令 `python3 docs/research/issue-1237-deletion-ledger.py`，当时 `COUNT 833` = 整文件 18 + 整案 115 + 断言 700，与表行 MATCH。第十一轮把未归类行写成 null，并在表内一刀切撤回承接；该句已由第十二轮作废。三例仍有效：宿主 stderr 原样穿透在 `test/integration/public-cli-failure-real-entry.test.ts:296`；`isSyntheticAnalystBookKey` 在 `test/contract/analyst-413-r2-findings.test.ts:205` 与 `:211`；notary 旗是公开入口产不出的非法值（表 `:61`）。

R10-B：`:51` 写入 `test/integration/public-cli-cli.test.ts:276` 与 `test/integration/audited-run-identity-1166.test.ts:466`。`:134` 写入导航员真因在 `:261` 被改弱后又恢复。

### 第十二轮（大理寺 I11-A）

逐条账不再把 null 当未审默认。每一行是 (a) 已裁坏形状并引此前判词，(b) 已有承接并引已有变异，或 (c) 补进现有案。`c/null` 只留 `readNotaryTicketFlag` 那 8 行。`--attach` 到达传输 prompt 补进 `test/integration/public-cli-report-ticket.test.ts:732`。隔离副本把 appendCallerFileFlagPaths 里的 --attach 前缀拿掉、只拼路径，该案红 false !== true；恢复后绿。

### 第十三轮（大理寺 01a163ff receipts/7.json R11-A）

R11-A：逐条账为改好、c/null 或 (b) 的删除，表类别与首句不再称重复，进口账不再列 D。`test/unit/engine-material.test.ts` 去掉 D，第十轮有承接。`test/contract/analyst-413-r2-findings.test.ts` 去掉 D，第十一轮改好。`test/contract/notary-role.test.ts` 去掉 D，旗绑定记 c/null。`test/integration/worker-submission-gates.test.ts` 去掉 D，unfinished reason 有承接 `:629`。`test/integration/public-cli-failure-real-entry.test.ts` 的宿主 stderr 不再称重复行，第十一轮改好。进口账 #413 撤出 D。

### 第十四轮（大理寺 01a163ff receipts/9.json R12-A）

R12-A：(b) 不再用组级变异免证。每行写打中该值的变异命令和报红的测试名。裁剪端点补进现有 `runAnalyst` 裁剪段，不另开案。给事中 evidence、soul、裸 converged、escalate+note、legacy clauses，校书郎第二次 escalate 与 completed，台院合法 payload 的 Value.Check，无 readingMaterial 时 systemPrompt 原样留下，审计官 subject Soul 字节，都并进已有案。没有新测试函数，没有新文件。

### 第十五轮（大理寺 01a163ff receipts/10.json R13）

R13-A：`a/C` / `a/T` / `a/M` / `a/D` 每一行写了有没有检查在役分支的输出或失败。ACP 与 headless 的 warning 申报改成分阶段观察，不恢复块数锁。空白 merger attemptId 记 c/null：公开入口只写 placed.runId。R13-B：计数按每次 assert 调用，含同行与内层调用；`python3 -I docs/research/issue-1237-deletion-ledger.py` 为 COUNT 849、MATCH 849。

### 第十五轮新腿（大理寺 01a163ff receipts/11.json R14-A/B）

R14-A：根因是旧腿为分开 warning 观察撤掉了 pointer、copy 失败输入。现在两个既有案的 log.jsonl 始终为目录；真实 session/prompt（ACP）、ingestStructuredOutput（headless）回调只分隔并重置申报观察，不移走阻断。首轮无原件守 warning，次轮有原件守 copy，各轮 pointer 也独立观察；headless 的后续覆盖与缺源保好副本保留。与 7997ffb2 的逐条 diff 已核：原必要失败输入全部保留，未恢复条数锁；没有新案、新生产函数或钩子。

R14-B（历史；runId 结论由第十六轮纠正）：逐条账的 32 条“助手无入口”套话按真实调用链重判。failure-settlement-kit 的 14 行有 runAkRole 入口，不再按夹具布局豁免；12 行引现有交付／退出码／诊断／navigator／artifacts／cause 守护和逐项变异，失败 Terminal.runId 类型与非空两行（#182/#183）实测变异仍绿，依本轮只改账处方记 c/null。根目录 cleanup 测试的 18 行含六条内层断言，都写明只测自造 body/cleanup，且是该已删测试不在 glob；夹具本身仍由 withTempRoot 等调用，不再误写夹具无使用方。详情及命令、红案名见 `issue-1237-deletion-ledger.md` 末 R14-A/B 取证。

交卷前自审：`git diff HEAD` 四文件逐一打开，`diffItems=[]`（无新增测试函数或生产函数）。两案沿 executeTurn 真入口，阶段只观察 stderr 是否发生，断言在返回后；不锁块数、措辞或提示词；退役 warning-only 观察与切换阻断逻辑已删。逐条对照 `git diff 7997ffb2 -- test/integration/host-session-acp-write-fail.test.ts test/integration/host-session-live-records.test.ts`，未撤另一阶段的失败输入。

聚焦验证：`node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/integration/host-session-acp-write-fail.test.ts test/integration/host-session-live-records.test.ts test/integration/public-cli-failure-settlement.test.ts`：12 pass / 0 fail，2011.798042 ms。`npx tsc --noEmit` exit 0；`python3 -I docs/research/issue-1237-deletion-ledger.py`：COUNT 849、MATCH 849，c/null 13；`git diff --check` exit 0。没有跑全量，没有改生产、配置或席位表。最小必要成本是复用两案与其回调增加阶段布尔观察、ACP 同夹具再走一次有原件路径，无新增测试机制。

## 第十六轮（R15-A / R15-B）

起点 `2f128022`，累计对照仍为 `7997ffb2`。依据大理寺 `01a163ff-00d1-7ee0-ae50-de4209edc7c3@judge/receipts/12.json`、符宝郎 `01a16409-cdb9-72b9-adda-86a54a6faead@notary/receipts/11.json`、台院 `01a16411-35e9-738f-afd0-e94edebd41be@auditor/receipts/10.json`（均在本票起居录）。不新增测试、不恢复条数锁、不改生产或全局配置。

### R15-A：纠正缺口账，不补并行守护

#182/#183 改为 (b)：`test/integration/engine-detour-usage-ledger.test.ts:810` 的 `first.terminal?.runId === runId` 是公开 host code 1 失败案，不是 accepted/no_receipt。原失败家族取样未包含它，不能从局部变异仍绿推出全仓缺口。

本轮在 `/tmp/r16-mutation` 用 `git archive 2f128022` 加本轮测试改动隔离复现，只将 `src/public-cli/settlement.ts:1717` 的失败返回 `{ roleOutcome, navigator, artifacts, runId: admitted.runId }` 改成 `runId: ""`。命令：

```sh
node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/integration/engine-detour-usage-ledger.test.ts test/integration/public-cli-process-cancel.test.ts
```

变异 exit 1，6 案 3 红，2561.136125 ms；撤销 exit 0，6/6 绿，2699.102334 ms。红案为：
- public entry: explicit resume is a new scope; reused toolCallId stays isolated; resumable redacts recordFile
- public entry: SIGTERM/SIGINT/SIGHUP settle non-success with signal name and stop host child
- public entry: SIGTERM beside a thrown host report keeps that report

其余 c/null 逐项复核见逐条账 #15、#131–#135、#137、#141–#142、#719–#720 及文末。没有再发现漏报的公开值相等承接。notary 的合法/缺省/bound 与注册归属不能套用非法值不可达，相关行已纠正说明；保留 R10-A 原裁未补状态，不借身份材料的其他字段冒称承接。当前 c/null 11、b 61。

### R15-B：全 test 树按蕴含关系删并

错误形状：同次调用、同一结果，已有精确值或整体 hand oracle，再检查其类型、存在、长度、成员、字段、派生和或排除不同值；也包括调用强断言助手后再逐字段重验同一结果。扫描从全部 test 文件的 assert 调用清单开始，不以判词样本为边界；再核循环输入、分支和前后调用。复扫使用同一组候选命令/清单，最终手工复核，候选扫描器只放临时目录，不成为测试或生产机制。

实际命令：`rg -n 'assert\\.' test`；`python3 /tmp/r16-scan.py > /tmp/r16-pairs.txt`，复扫同命令输出到 `/tmp/r16-pairs-after.txt`；累计删并文件范围 `git diff --name-status 7997ffb2 --`，本轮范围 `git diff --name-status 2f128022 --`。扫描器只复用账本 assert_calls 枚举候选，不作自由文本的生产判定。

下表是本轮逐文件表，覆盖上文旧轮次的留/改结论。命中以行为定位（表内保留历史坐标，基线原句与位置以逐条账为准），承接是本轮提交 `5ee5b065` 的修后行号；失败助手完整路径为 `test/helpers/failure-settlement-kit.ts:89–128`。基线每条另入逐条账 #851–#1033，非基线的 R13 回补也在本表列出。

| 文件 | 本轮命中（历史坐标） | 处置／修后承接 |
| --- | --- | --- |
| `test/contract/analyst-b2-frame-buckets-actions.test.ts` | 桶和、duration 投影、overlap sum/toolBucket、bash 字段；:208 clipped 桶和 | 已修；:136–140 精确桶与 actions，:176–178 clipped 三值。保强 hand oracle。 |
| `test/contract/judge-role.test.ts` | :565 completed.status（R13 回补） | 已修；:565 accepted.details 整体 deepEqual(completed)。 |
| `test/contract/secretariat-role.test.ts` | :76 active.includes(output) | 已修；:69 精确过滤命中数 1，蕴含成员存在。 |
| `test/contract/submission-ledger.test.ts` | :167 accepted 非 details；:542 recorded.length | 已修；:166 精确 params、:494 整体数组。 |
| `test/integration/analyst-399-book-scope.test.ts` | :294–295 两个排除成员 | 已修；:293 精确 ticketIds。 |
| `test/integration/analyst-c1-sweep-index.test.ts` | :182 row 存在；:209 重扫文件数 | 已修；:182 整体 row、:208 原文件数组。 |
| `test/integration/analyst-c3-model-groups.test.ts` | :217 grokDisplayRows.length | 已修；:217 rawGroupKey 精确数组。 |
| `test/integration/analyst-compute-if-missing.test.ts` | :485 issueNumber；:522 unscoped/scopedDisk 不等 | 已修；:476、485 与 disk 相等；:512、520 两者票号分别精确。 |
| `test/integration/analyst-entry.test.ts` | B1 存在/投影、B3 存在/逐字段、B4 death/absent-tail、:886 重复排除 a1 | 已修；:789 B1、:814 B3 整体 oracle；:801–809 B4 按行 oracle；:869 排除 a1。分支 unreadable 的自由 reason 特征观察保留。 |
| `test/integration/dossier-resolution.test.ts` | :51 a/b 目录非等 | 已修；:49–50 精确不同目录。 |
| `test/integration/engine-detour-usage-ledger.test.ts` | :520 stdoutByteLength 属性存在 | 已修；:519 精确 0。runId 失败守护保留 :810。 |
| `test/integration/factory-board.test.ts` | 时间/两轴非等、desc 非等、onBoard 成员、:1013 与 :1036 同值 | 已修；:1036 状态、:1121 时间、:1191–1202/:1286–1303 两轴精确值、:1637 排序、:2810/:2845 两次各自精确集合。独立 HTML 属性及跨 tick 观察保留。 |
| `test/integration/gate-officer-resume-accounting.test.ts` | :95 rounds.length；host/model 排除父值 | 已修；:95、99 精确投影；:184、190 精确 host/model。 |
| `test/integration/public-cli-1132-delivery-request.test.ts` | :241 kind 非 no_receipt | 已修；:232 精确 accepted。 |
| `test/integration/public-cli-auto-resume-dispatch-throw.test.ts` | :123、132 长度 | 已修；:123、131 attempt 精确数组。 |
| `test/integration/public-cli-coder.test.ts` | :113 summary | 已修；:108 accepted 整体相等。 |
| `test/integration/public-cli-escalation-resume.test.ts` | :439 role 非 judge | 已修；:416 精确 auditor。 |
| `test/integration/public-cli-failure-artifacts.test.ts` | helper 后 kind/cause/diagnostic、同路径 errorBody 重读、terminal 存在 | 已修；:229、359 调用原 failure-settlement-kit。独立 decisiveFacts errno 保留。 |
| `test/integration/public-cli-failure-provider-stop.test.ts` | helper 后 kind/cause/diagnostic、同路径 artifact 重验 | 已修；:68、185、298 调用原 kit；删未用 import。不同座与失败输入保留。 |
| `test/integration/public-cli-failure-real-entry.test.ts` | helper 后 kind/cause/diagnostic/identity | 已修；:411、584 调用原 kit；未指定精确诊断的类型/非空，以及 details/packageFact 独立字段保留。 |
| `test/integration/public-cli-failure-settlement.test.ts` | helper 后 kind/cause/diagnostic/exitCode；undefined 后排除标签 | 已修；:194、232、369、407、569 调用原 kit；timeout 的 timedOut、navigator 和 submissions 保留。 |
| `test/integration/public-cli-report-ticket.test.ts` | :1132 autoSummons 类型；:1134 传递等值 | 已修；:1127–1128 两值各自精确 firstInstruction。 |
| `test/integration/public-cli-resume-416.test.ts` | :255 重复 calls=3 | 已修；:247 同次结果已有精确值；删失实“只呈一次”旧注释。 |
| `test/integration/public-cli-resume-callable-seats.test.ts` | :256 sessionFile 存在 | 已修；:257 精确 sessionFile。 |
| `test/integration/public-cli-reviewer.test.ts` | lensRows.length、round 唯一性 | 已修；:559 round 精确连续数组。 |
| `test/integration/public-cli-same-ticket-resume.test.ts` | :1046、1100 传递非等 | 已修；:1035 精确 freshRunId；:1088–1089 新旧非等加 terminal 映射。 |
| `test/integration/public-cli-secretariat-run.test.ts` | :570 kind 非 audit_escalation；:592 重复 role | 已修；:563 精确 accepted、:581 精确 role。 |
| `docs/research/issue-1237-deletion-ledger.md` | #182/#183 错报及本轮删除未入账 | 已修；1032 行逐项与机械 where 序列相符。 |
| `docs/research/issue-1237-test-quality-sweep.md` | 旧 runId 判断及逐文件增量未同步 | 已修；本节为当前结算，前文保留历史。 |

复扫保留边界：oauth refresh/重启、navigator abort/dispose、各次 config/runAkRole/resume、看板 tick/DOM 事件前后是不同调用；B4 readable/unreadable、audited identity 已知/动态两路、engine failure/accepted 是不同分支；headless durable/presentation、notary identity/收卷是不同观察对象。`analyst-public-cli.test.ts:153–154` 的 oracle 由生产入口再算，不足以蕴含夹具 runId 存在，故留。ACP/headless 的 pointer、warning、copy 来自不同阶段/输入，整组不动；没有用重复之名回退第十五轮。

### 自验与自审

- 27 个触及测试文件：`node --import tsx --import ./scripts/test-process-env-preload.mjs --test $(git diff --name-only -- test)`，251/251，17331.001083 ms。
- 最后补删看板重复值与未用 import 后：`node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/integration/factory-board.test.ts test/integration/public-cli-failure-provider-stop.test.ts test/integration/host-session-acp-write-fail.test.ts test/integration/host-session-live-records.test.ts`，42/42，3378.769708 ms。
- `npx tsc --noEmit` exit 0；`git diff --check` exit 0。未跑全量。
- 机械基线账：1032 = 文件 18 + 案 115 + 断言 899；a/D 492、a/M 198、a/S 134、b 61、改好 35、a/T 34、a/退役 25、仍在 22、a/C 20、c/null 11。提交前按工作树版 diff 核对，提交后再用未改的 `python3 docs/research/issue-1237-deletion-ledger.py` 核 HEAD。
- `git diff HEAD` 自审：新增生产函数 0、新增测试函数 0，diffItems=[]；没有未跟踪仓内文件。只删蕴含检查及其专属局部变量/导入，所有强值守护、调用、不同失败输入仍在。无生产文件改动、无新通用件、无安装/真实席位配置写入。
- 最小必要成本：删除测试冗余，复用全部既有案；变异只用已有入口，不新造证明性测试。超过 400 行的主要是纯删除与逐条入账文档，不新增施工机制。

## 第十七轮（R16-D）

起点 `5ee5b065`。依据本轮大理寺 continue 回执：同次 result 已由 `assertPublicFailureSettlement` 检查，调用处仍重复 kind、cause、terminal diagnostic、error artifact diagnostic。漏扫原因是没有把 helper 输入的 result 与调用处 `result.terminal!` 作为同一个对象逐项对照；不能只追踪 helper 解构返回的 terminal。

实际扫类与复扫命令：`rg -n 'assertPublicFailureSettlement' test`，再以 `rg -n -A 38 'await assertPublicFailureSettlement\(' test/integration/public-cli-failure-{real-entry,artifacts,provider-stop,settlement}.test.ts` 打开全部 17 个调用点，逐项比对 `test/helpers/failure-settlement-kit.ts:78–132`。同时追踪输入 result、返回 terminal 和 errorRef 三种访问方式；没有新增扫描机制入仓。

| 文件／调用（起点行号） | 复核及修后结论 |
| --- | --- |
| `test/integration/public-cli-failure-real-entry.test.ts:286` | 已修：删除 :297、299、300、315 四断言及只服务 errorBody.diagnostic 的可选类型字段。承接分别为 kit:93、100、102、102+123。修后 :297 缩窄控制流仍在；stderr、decisiveFacts、packageFact、artifact 的其他字段与 attempt-history 均保留。 |
| `test/integration/public-cli-failure-real-entry.test.ts:355` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-real-entry.test.ts:411` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-real-entry.test.ts:488` | 无：errorBody.details/packageFact 不是 helper 检查的字段。 |
| `test/integration/public-cli-failure-real-entry.test.ts:522` | 无：details 缺省和 packageFact 的 timeout/exitCode 独立。 |
| `test/integration/public-cli-failure-real-entry.test.ts:584` | 无：decisiveFacts 独立；未传 diagnosticEquals，诊断类型/非空不由 helper 的值比较蕴含。 |
| `test/integration/public-cli-failure-artifacts.test.ts:229` | 无：保留的 decisiveFacts.errorCode 不是 artifact identity；类型缩窄不删。 |
| `test/integration/public-cli-failure-artifacts.test.ts:359` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-provider-stop.test.ts:68` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-provider-stop.test.ts:185` | 无：各输入调用后没有重复断言，不能跨输入合并。 |
| `test/integration/public-cli-failure-provider-stop.test.ts:298` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-settlement.test.ts:194` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-settlement.test.ts:232` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-settlement.test.ts:336` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-settlement.test.ts:369` | 无：调用后没有重复断言。 |
| `test/integration/public-cli-failure-settlement.test.ts:407` | 无：未传 diagnosticEquals；诊断类型/非空、details.timedOut 与 navigator 为独立观察。 |
| `test/integration/public-cli-failure-settlement.test.ts:569` | 无：payloads/submissions 不由 helper 检查，缩窄控制流保留。 |

本轮逐文件增量：测试文件仅上表 real-entry 改动；`docs/research/issue-1237-deletion-ledger.md` 新增 #1034–#1037 并把 R16 的行号显式锚定 `5ee5b065`；本文件补本节。没有重开已解决的 runId 账，也没有修改 pointer/warning/copy 案。

验证：修前 real-entry 8/8，1718.135791 ms；修后执行 `node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/integration/public-cli-failure-real-entry.test.ts test/integration/public-cli-failure-artifacts.test.ts test/integration/public-cli-failure-provider-stop.test.ts test/integration/public-cli-failure-settlement.test.ts`，30/30，2678.882709 ms。`npx tsc --noEmit` exit 0；账本工作树核算 COUNT/MATCH 1036（18 文件、115 案、903 断言；a/D 496，其余桶不变）。提交后仍用未改的计数脚本核 HEAD。未跑全量；无新增测试/helper/生产机制，新增函数逐项表为空，四条旧断言与专属类型字段均已删除。
