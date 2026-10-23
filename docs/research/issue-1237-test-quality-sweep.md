# #1237 存量测试质量清理交卷

基线：`7997ffb2`；首版：`c950d019`；第二版：`19b7dc7a`。第二版依台院 `01a1628d-443a-71f0-8de8-e9d1c5d92674@inspector/receipts/1.json` 与大理寺 `01a1628f-9dcb-765c-abc5-09b80ad9ed25@judge/receipts/1.json` 的 A/B/C、J1–J5 续修；第三版依大理寺同 run `receipts/2.json` 的 R2-A/R2-B/R2-C 续修（见文末「第三轮」）；第四版依同 run `receipts/3.json` 的 R3-A/R3-B 续修（见文末「第四轮」）；第五版依同 run `receipts/4.json` 的 R4-A/R4-B 续修（见文末「第五轮」）；第六版依同 run `receipts/5.json` 的 R5-A 续修（见文末「第六轮」）；第七版依大理寺 `01a163ff-00d1-7ee0-ae50-de4209edc7c3@judge/receipts/2.json` 的 R6-A/R6-B 续修（见文末「第七轮」）；第八版是对现存全部测试文件的整卷复扫（见文末「第八轮」），每行末尾的「第八轮整卷复扫」即本轮结论。本文是施工记录，不是新测试规范，不限制后续审核；本腿未派角色、未送审。

当前结算以文末「R18-B 复审修理」及逐条账 R18-B 为准；此前各轮保留为历史取证，尤其第十五轮 runId 缺口判断已撤回。

## 方法与边界

盘点基线全部 137 个 `*.test.ts`：unit 19、contract 27、integration 87、adjudication 1、package 2、根目录 1；累计处置为改 67、删 18、留 52（其中原 integration argv 文件迁移到 unit，旧路径计删，新路径不冒充基线文件）。原 105 个“留”文件已按案复核；本轮改表不再以整个文件有行为案为由豁免其中坏案。先逐文件核入口与断言，再打开候选上下文、生产调用点、承接测试及历史。类别仅采用票面五项：M＝内部结构（含镜像），T＝非契约文本，D＝重复结论，S＝失效行为，C＝单纯覆盖率；B 表示留下的行为测试，不是第六项判坏标准。混合文件的“改”包含删除其中坏案，保留其他行为。

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
| `test/contract/navigator-attendance-lifecycle.test.ts` | T/M | 第二十三轮 R24-A：grace 案删除手工 attendance/lookup 装配，改用生产依赖表，只在 summons 边界控制挂起与 abort；逐命中账见末节。此前：改：删 grace 报错句式锁；保受控 promise/clock 驱动 attendance grace、取消和 settlement；不是实际宿主并发测试。第八轮整卷复扫：未命中。第十二轮账：a/T 1。无未证 null。 |
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
| `test/integration/audited-run-identity-1166.test.ts` | T/D/S | 第二十二轮 R23-A：启动观察不接生产 attendance，见末节逐项账。此前：改：保公开 gate/resubmit/direct 的 auditedRun 身份、schema 输入、原卷；补回 notary prompt≠父正文及同父重交正文改变但 prompt 不变，随机自身/audited Soul 穿透。删模板与重复 summons 计数，不删盲审契约。第三轮：`:152` auditor 改用生产 subject Soul 装载器并比对包内 `souls/<subject>-auditor.md` 字节；`:159` 起各官席断言生产参考材料装载器每次所返的非空内容都原样进入 startup materials（至少载入一次；不锁装载次数，台院 I3-1 后改）。第七轮（R6-A）：删 `decisiveFacts.notaryTerminal === undefined`（#1195 `1ea12daa` 已撤他席终局投影，src 零产出）；同案 role/kind 与原卷 payload 正向断言留。另删两处「非身份材料中带 sourceRunPath/runDirectory 的条数为 0」及只为它存在的 `packageAuditedPathMaterials` 本地 helper（#1166 `ddc9a1dd` 已撤 inspector-parent-binding 路径材料，src 无产出这类材料的路径）；身份材料 deepEqual 留，文件头不再声称守「不加目录路径」。第八轮整卷复扫（S）：删审官工具面不含 ak_get_run_dossier（#1166 ddc9a1dd 已撤，src 零产出）及只为它取 toolNames 的支路；四审席共享身份、同伴原卷、clauses 分席留第十二轮账：a/D 9、a/S 4、a/T 8、仍在 2。无未证 null。 |
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
| `test/integration/public-cli-1132-delivery-request.test.ts` | S | 第二十二轮 R23-A：催交案不接生产 attendance，见末节逐项账。此前：改（第七轮 R6-A，原判留）：删两处 `decisiveFacts.officerPayloads === undefined`（#1195 已撤父侧 officer payload 拷贝，src 只剩 `gatekeeper-role.ts` 一句注释）；公开催交、计数、audit 子卷 ceiling、实际审席 role/kind 与 directionUnsettled 等结构化结果留。第八轮整卷复扫：未命中。第十二轮账：a/S 2。无未证 null。 |
| `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts` | S | 改（第七轮 R6-A，原判留）：删禁名表 attachments/fix-packet.md/task.md/prerequisites.json 与 attachment 的 `frozenPath` 缺席断言（均无生产者）；入口 relocation→inspector→resume 的必备拓扑文件、leg session、结构化路径无陈旧 unbound、admitted 原样路径留。第八轮整卷复扫：未命中。第十二轮账：a/S 2。无未证 null。 |
| `test/integration/public-cli-argv-parsers.test.ts` | D/M | 删原路径／迁移：grammar 案移至 `test/unit/public-cli-argv-parsers.test.ts`；删重复 Collector wait-ms、Coder admission、engine resolver。第三轮再删迁移件中与公开入口同规则同结论者：Coder/Fixer 默认 apply 与显式 plan（承接 `test/integration/public-cli-coder.test.ts:333`、`test/integration/public-cli-fixer.test.ts:41`）、Fixer 已给 prerequisites 路径（同 `:41`）、未知旗与空 `--project`（承接 `test/integration/public-cli-failure-settlement.test.ts:36`）、Collector `--pr`（承接 `test/integration/public-cli-collector.test.ts:87`）。只有解析案能抓的独有边界逐项留在新路径：位置参数拼接、空白 `--project`、缺值 `--attach`（并入 `:8`，取自已删的 Judge 解析案）、Collector `--repo`（`:34`）、Doctor 语法（`:38`）、空 prerequisites 保 opaque 与缺值拒收（`:82`）。迁入后的 `test/unit/public-cli-argv-parsers.test.ts` 第八轮整卷复扫：未命中。第十二轮账：a/D 45、a/M 1、a/S 4。无未证 null。 |
| `test/integration/public-cli-attach-path-passthrough.test.ts` | S | 改（第七轮 R6-A，原判留）：删 run 目录 `attachments` 不存在、attachment 上 frozenPath/sha256/byteLength/provenancePath 缺席、`request-manifest.json` ENOENT、admitted `manifestDigest` 缺席（均为 #1165/#1166/#1169 已撤的冻结副本与摘要，src attachment 投影不产出）；公开传入 opaque path、实际 host flags/请求保持路径、cwd 可异留。第八轮整卷复扫：未命中。第十二轮账：a/S 7。无未证 null。 |
| `test/integration/public-cli-auto-resume-dispatch-throw.test.ts` | B | 留：公开 retry loop 保每次 cause、sink 故障、后续成功与原始异常身份。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-auto-resume-limit-422.test.ts` | D | 改（第八轮整卷复扫，原判留）：删两条直调 runWithAutoResumeLoop 注入 N=4/N=0 的案——同文件经 runAkRole 的 configured N=1/N=0 两案同结论（N→N+1 次派发、0 不续）；配置读写、CLI 拒收与非法注入值留第十二轮账：a/D 4、仍在 2。无未证 null。 |
| `test/integration/public-cli-bin-startup.test.ts` | B | 留：真实 built bin 可启动、exit 状态，不比 help 文案；与 tarball 安装产物接缝不同。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-cli.test.ts` | M/D | 第二十二轮 R23-A：schema 观察不接生产 attendance，见末节逐项账。此前：改：删 help/registry 同源自比及重复 resolver；保 CLI config 写盘/不被 local flags 改写、unknown command 零写入、各席 invocation；不再谎称跨进程。第五轮（R4-B）：CLI config 公开案在 bare `config set` 后接一次 Coder 派发，断言 `request.model` 为无 thinking 的持久选择（承接原 config 直接案的持久化 effective selection）；`:` 空后缀经 `config set` 落盘为 `thinking: ""`（opaque 边界）；删对 gatekeeper `resolveEffectiveSeat(...).source` 的 helper 复核（同结论在 `public-cli-config` #620 优先级案）。台院 I5-1 后：删 `roles --model kimi-coding/k3-256k` 块及其 #346 注释——前轮删了其后的 effective helper 断言，块里只剩 exit 0，注释所称「不编造 thinking」已没有断言；裸模型合法由 `public-cli-coder` bare 案（argv、invocation 无 thinking）承接，roles 读不落盘由本案 `overrideResult` 承接。同形状复扫（本票删断言后紧前只剩 exit 断言的块）其余命中都还有独有断言：`overrideResult` 保盘字节不变，`rolesAfter` 在 gate 继承行渲染上独有。第八轮整卷复扫：未命中。第十二轮账：a/D 7、a/M 6。无未证 null。 |
| `test/integration/public-cli-coder.test.ts` | S | 改：删退役 task/dossier 哨兵，宿主中性 /skill: 负向契约保留；保公开 Coder phase、opaque status、audit failure、model/thinking 与 resume；宿主边界提供输入。第五轮（R4-B）：既有「structurally malformed --model is rejected」案由单个 `:provider/model` 扩为同一循环中的空串、无斜杠、空 provider、前导冒号四种坏输入，断言不派发且非零退出（承接原 config 直接拒收案；前导斜杠在 invocation 路径只有这里抓得到）。第七轮（R6-A）：更正上文：当时并未删净。本轮删 resume 案 `--ak-coder-task` 缺席（#1168 已撤，src 零命中）与 session 下 `worker-submission-gate` 目录不存在（src 只在旧件迁移器认该名，运行时不建）；`--skill`、`--thinking` 是 Pi 真实旗，缺席为分支辨别，留。第八轮整卷复扫（S）：更正上文「宿主中性 /skill: 负向契约保留」——`/skill:` 自 `42c7b2d3` 起 src 零产出，resume 请求 prompt 不以它开头的断言是退役机制哨兵，删；`--skill`/`--thinking` 是 Pi 真实旗，留。第十二轮账：a/D 3、a/S 5。无未证 null。 |
| `test/integration/public-cli-collector.test.ts` | D/S | 改：合并 groups/MERGED 重复案，改真实 structured-output→ledger→Terminal，含 lawful ticket；保 CLI/parser 负向输入，不重复两份 wait-ms 拒收。原 `stdout.length > 0` 不在本案补回：accepted 交付走同一 `presentTerminal`，由 `test/integration/public-cli-judge.test.ts:294`、`:386` 的整段 stdout 非空接住（第四轮变异见文末）。第八轮整卷复扫（S）：删「rejects retired --wait-ms」——已退役旗，src 无此旗专门处理，拒收即通用未知旗（公开拒收表 test/integration/public-cli-failure-settlement.test.ts:36 承接）；回执原样穿透与 --pr 绑定留第十二轮账：a/D 7、a/S 2、a/C 1。无未证 null。 |
| `test/integration/public-cli-config.test.ts` | M/D | 改：删 16 席 roster 镜像；local model/thinking 从 runAkRole 真 dispatch 到 request.model，磁盘不变；保 persistence/inheritance/clear/未知 seat，全部 fixture home。第五轮（R4-B）：删六个与公开入口同规则同结论的直接案——disk round-trip（同 `public-cli-cli` config set judge/navigator 落盘）、persistent effective source（同本文件未知 seat 读取案的 persistent 断言）、bare invocation 与带后缀 invocation 的解析/effective（承接 `public-cli-coder` bare 与后缀两段的 argv、invocation 记录，`--model`+`--thinking` 合并由本文件 command-local 案承接）、malformed/opaque（拒收并入 Coder 公开拒收循环，bogus/xhigh 与未知 provider 已由 Coder 公开案承接，空后缀并入 CLI config 案）、persistent bare（落盘同 CLI config 案，argv 同 Coder bare，持久 effective selection 并入 CLI config 案派发观察）。`formatModelSpec` 只供 roles/config 的 TSV 呈现，不另锁。继承、清除、engine residual、持久化拒收、未知 seat 读写各案独有，保留。第八轮整卷复扫：未命中。第十二轮账：a/D 31、a/M 3、a/T 3、仍在 2。无未证 null。 |
| `test/integration/public-cli-countersign-run.test.ts` | S/D | 改：删退役旧旗与 dossier 哨兵；保公开 admission、status、同 session 恢复、ticket assertion 与旧 attempt 残卷隔离。第八轮整卷复扫（D）：删「countersign admission binds the countersign role without inventing a ticket」（直调 admitPublicRole+buildInstructionSeatTurnRequest）——同文件「public countersign path: no 起居郎 handoff stays unbound」经公开入口同结论；附件 frontmatter 不认票等留第十二轮账：a/D 3、a/S 1、仍在 2。无未证 null。 |
| `test/integration/public-cli-diarist-run.test.ts` | S | 改：删退役字段/文件哨兵；保公开 dialogue/diarist 的源卷字节、范围选择、迁移/分票/追加/恢复，不锁新生成叙事。第七轮（R6-A）：再删 `volume.lines.every(line => !("line" in line))`（#926 `9aef80b5` 撤 amendments 后行对象无 line 字段，src 不产出）；同案不可解析原字节落卷的正向断言留。第八轮整卷复扫：未命中。第十二轮账：a/D 1、a/S 3。无未证 null。 |
| `test/integration/public-cli-doctor.test.ts` | B | 留：公开 case admission、完成/拒绝、mandatory audit、officer escalation；待设计不豁免也不自动删。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-engine-axis.test.ts` | M/D | 改：删名册 length===16、重复 resolver/roundtrip/unset 案；保逐席实际 dispatch 与轴优先级，新增输入并入既有负向表：损坏磁盘 engine 经 CLI exit2 且零 dispatch。第八轮整卷复扫：未命中。第十二轮账：a/D 12、a/M 1、仍在 1。无未证 null。 |
| `test/integration/public-cli-engine-resume-detour.test.ts` | B | 第二十二轮 R23-A：材料观察不接生产 attendance，见末节逐项账。此前：留：初始/自动/显式恢复上的 engine 及 live seat table axes，输出 typed 请求。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-engine-startup-material.test.ts` | T/M | 改：runAkRole→prepared host，handbook/dispatchHandbook 等于源文件 UTF-8 的递送契约；保 typed kind/name/model、输入 dispatch，不检查文档措辞。第五轮（R4-A）：此前预期值经生产选路 `resolveEngineMaterialPath`／`resolveEngineDispatchMaterialPath` 计算，与被测读取共用同一选择，错配时双方同错；改为独立读取 `resources/engines/cursor.md` 与 `resources/engine-dispatch.md`，两案同改，删该 import。第八轮整卷复扫：未命中。第十二轮账：b 2。无未证 null。 |
| `test/integration/public-cli-escalation-resume.test.ts` | B | 第二十二轮 R23-A：父卷提交不接生产 attendance，见末节逐项账。此前：留：公开 gate escalation/continue/transport_failure 到同次父卷与恢复路由。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-explicit-internal.test.ts` | B | 留：假 CLI 子进程 argv/stdin/env、PATH、SIGTERM/关闭与投递错误，不调用真实模型。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-failure-artifacts.test.ts` | T | 改：删 stdout/stderr 分块计数及死变量；保实际 public terminal/artifact 写故障、旧卷隔离及宿主结果不被产物错误顶替。第四轮（R3-A）：删计数时连交付观察一并删掉是误删；no_receipt 交付在 `:76` 既有 malformed session 案断言整段 stdout 非空；current.json 写入被拒、Terminal 无产物引用时仍须交付，在 `:143` 既有写故障案断言；普通失败交付由共享 `assertPublicFailureSettlement`（`test/helpers/failure-settlement-kit.ts:95`）接住；其余同路径案不逐例补回。第八轮整卷复扫：未命中。第十二轮账：a/C 7。无未证 null。 |
| `test/integration/public-cli-failure-provider-stop.test.ts` | B | 留：真实 public 入口只认宿主 typed report，不从旧 transcript 推造 provider failure。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-failure-real-entry.test.ts` | T/M/S | 改：删输出分块计数；第三轮把 `stderr[0]` 取首块改为整段输出非空，不依赖写入分块；第四轮这两处并入共享 `assertPublicFailureSettlement` 的 stdout/stderr 交付观察（`test/helpers/failure-settlement-kit.ts:95`、`:96`），本文件删去分块观察。第十一轮（R10-A）：宿主 stderr 原样穿透不是分块计数，也不是重复结论，已在 `:296` 改好。`production knownFailure channel` 案在 `:296` 断言整段 stderr 包含注入的 hostStderr（值包含，不用正则）。kit 的非空只观察交付。隔离副本拿掉 hostStderr 附带后该案报红。保公开 entry 的 typed failure 与 packageFact/timeout、封卷后非零退出；保存而不洗白。第七轮（R6-A）：删两处 `notEqual(…, "MissingProviderCredential")`（#987 删前置凭证闸后 src 无产出此名的代码）；「无 cause」由同案 `errorBody.cause === undefined` 守着，留。第八轮整卷复扫：未命中。第十二轮账：a/M 1、a/S 2、a/C 4、改好 1。改好见账内隔离变异。无未证 null。 |
| `test/integration/public-cli-failure-settlement.test.ts` | D/C/M | 改：既有零 dispatch/零 admission 的结构性错误表接住非 repeatable option 重复；第三轮删两处 `stdout.length === 1` 写入次数锁，保 exitCode、Terminal、payload 结构化断言（两案均 accepted，交付观察由 `test/integration/public-cli-judge.test.ts:294`、`:386` 承接；失败案经共享 kit 观察 stdout/stderr 交付）；拒收表的「零写入／有诊断」不锁分块数，留。其余实际 failure/Terminal 分支保留。第八轮整卷复扫：未命中。第十二轮账：a/C 2。无未证 null。 |
| `test/integration/public-cli-fixer.test.ts` | D/S | 改：低层 admission 重复案合入既有公开 opaque prerequisites 表（含 bad-grammar），删除本地孤儿 helper/旧字段哨兵；保公开 opaque prerequisites、phase、restore、声明 prerequisite_unmet 与各合法交卷状态。第七轮（R6-A）：再删漏下的一处 `"packetPath" in admitted === false` 及类型注解里随之无用的 `packetPath`/`prerequisites` 字段。第八轮整卷复扫：未命中。第十二轮账：a/D 10、a/M 1、a/S 13、仍在 1。无未证 null。 |
| `test/integration/public-cli-gleaner-left-run.test.ts` | S/D | 改：`:90` 从真实 structured-output 收卷走到 Terminal，比原参数，覆盖 completed/bounce/pass/无 status；第三轮删 `--bogus` 未知旗解析重复（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），必填 `--base` 解析案独有，留；其余 base、非空弹章、resume 失败路径仍留。第八轮整卷复扫：未命中。第十二轮账：a/D 6、仍在 5。无未证 null。 |
| `test/integration/public-cli-host-axis.test.ts` | S | 第二十二轮复审 R23-A：默认生产 host 间接装配不接无关 attendance，保真实 adapter、默认选择及拒绝分支，见文末补扫账。此前：改（第八轮整卷复扫，原判留）：删三族宿主 prompt 不以 `/skill:` 开头（`42c7b2d3` 后零产出）与 judge run 下无 `*-home` 子目录（#717 `ce69787d` 已撤 run 级 grok home）四处哨兵；prompt 含原话、planned 回执、HOME 继承等结构化断言留，#822 案名改为陈述所留行为。第十二轮账：a/S 5。无未证 null。 |
| `test/integration/public-cli-instruction-seat.test.ts` | D | 改（第八轮整卷复扫，原判留）：表内 dispatch 行与 pass 行同结论（门下省回执原样进 terminal），删 dispatch 行第十二轮账：a/D 2。无未证 null。 |
| `test/integration/public-cli-judge.test.ts` | D/M/S | 改：删两条直接解析案——未知旗与空 `--project`/`--project=` 重复公开拒收表（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），附件/project 正向重复 `test/integration/public-cli-attach-path-passthrough.test.ts:46`；独有的位置参数拼接、空白 `--project`、缺值 `--attach` 移入 `test/unit/public-cli-argv-parsers.test.ts:8`。删两处 `stdout.length === 1` 写入次数锁，改整段 stdout 非空（`:294`、`:386`，即 accepted 交付观察）。保公开 Judge decisionGate、结构拒收、audit no_receipt 和空请求不发明任务。第七轮（R6-A）：删 internal 激活 argv 不含 `burden` 的断言（src 只在公开拒收拼写里认 burden，internal argv 无产出路径）；公开 burden 拒收仍由拒收表守。第八轮整卷复扫：未命中。第十二轮账：a/D 9、a/S 2、a/C 4。无未证 null。 |
| `test/integration/public-cli-known-ticket-placement.test.ts` | B | 留：公开已知 ticket 对所有席的落盘位置，不用目录猜 ticket。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-main-flow-p0.test.ts` | B | 留：无配置在 dispatch 前失败，以及真实公开 escalate→owner ruling→resume 主链。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-merger-run.test.ts` | D | 改（第八轮整卷复扫，原判留）：删「every packaged role accepts via shared sealed→Terminal entry」——各席经 runAkRole 收 accepted 与 test/integration/public-cli-seat-pipeline.test.ts「every active seat routes, submits, and settles」同结论，换宿主收卷由 test/integration/pipeline-lifecycle-formalization.test.ts 承接；随删只剩它用的行表与五个种子 helper；多次提交、post-seal/no-receipt/infrastructure 留第十二轮账：a/D 5。无未证 null。 |
| `test/integration/public-cli-merger.test.ts` | S/D | 改：删退役 dossier/旧 manifest 字段哨兵；第三轮删解析案中未知旗与空 `--project` 重复（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），Merger 专属的公开 packet 字段拒收与附件正向留；保公开 Merger 从真实 Git 派生 materials，再到 host/Terminal、resume 与 malformed 收卷。第七轮（R6-A）：再删 materials 上 `"task"`/`"authority"` 缺席两句（#1168 已撤，且与同案 materials 键集 deepEqual 重复）。第八轮整卷复扫（S）：再删 transport prompt 不以 `/skill:` 开头（同上，零产出）；prompt 含原话留。第十二轮账：a/D 3、a/S 4。无未证 null。 |
| `test/integration/public-cli-navigator-attendance.test.ts` | T/M | 第二十三轮 R24-A：撤回前轮测试内重建 attendance/lookup 的修法，成功及 failingLookup 共用生产装配；只观察真实 public summon 返回，按生产 isPreparing 状态等待后清理，含父宿主失败。见末节逐项账。此前：改：真实父入口到 lookup，建议对应同次回执 byStatus[status]，不同 status 有区别、缺行无建议；父失败 diagnostic 等于输入真因，保 disposition/run/receipt/session。第八轮整卷复扫：未命中。第十一轮（R10-B）：不可用真因断言曾被改弱，第十轮在 `:261` 恢复为与独立复现的文件系统错误值相等，不锁包装措辞。第十二轮账：a/T 4。无未证 null。 |
| `test/integration/public-cli-navigator-lookup.test.ts` | T/M | 改：真实整表与 coder/reviewer/judge 筛选互证，能抓错角色与只剩 coder 的整表；保落原卷、零 host session、usage/记录失败，不导入内部建议常量。记录失败案删 `/EISDIR/` 正则（锁诊断措辞）；第四轮补最小交付观察 `:150` stderr 整段非空——此案无 Terminal，诊断只在 stderr。第八轮整卷复扫：未命中。第十二轮账：a/M 5、a/T 1。无未证 null。 |
| `test/integration/public-cli-notary.test.ts` | D | 改：删与公开负向案重复的 locator/run-state 底层调用；保公开 source locator 输入边界与三态/no_receipt/transport、绑定继承和 Terminal；不是旧 helper 拒收测试。第八轮整卷复扫：未命中。第十二轮账：a/D 4。无未证 null。 |
| `test/integration/public-cli-process-cancel.test.ts` | B | 留：实际 CLI/process 信号入口产生结构化失败并停止受控 host child。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-report-ticket.test.ts` | S | 第二十二轮 R23-A：认票及催交装配不接生产 attendance，见末节逐项账。此前：改：删退役 officer-pointer/旧目录哨兵；保公开中途认票→重定位→记录→恢复，包含真实持久化失败和不同 court 的卷隔离。第七轮（R6-A）：再删 `"runDirectory" in reported === false`（#1171 `ffadda6f` 已从 `ReportTicketResult` 删去该字段）与进度行 model/host/thinking 缺席三句（`TicketProgressLine` 从未有这三字段，无生产者）。第八轮整卷复扫：未命中。第十二轮账：a/S 5、改好 1。改好见账内隔离变异。无未证 null。 |
| `test/integration/public-cli-resume-416.test.ts` | S/D | 改：删 resume-continue 死哨兵；lawful no_receipt/audit_escalation 的 budget 改2，实际验证不重试，删重复 lawful helper 判定；保公开恢复受理、无文件尝试宿主、call-local retry 与 nested seat axes。第八轮整卷复扫：未命中。第十二轮账：a/D 2、a/S 2、a/C 1。无未证 null。 |
| `test/integration/public-cli-resume-callable-seats.test.ts` | B | 留：各 callable seat 的公开 resume 到精确 principal/Terminal，覆盖角色差异。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-resume.test.ts` | S/T | 改：删 resume-continue 哨兵；quota prose 案验证宿主原 diagnostic、cause 缺席，不凭文案分类；保公开 exact principal、模型覆盖/继承、publication 恢复、lease 失败及 opaque ruling。第七轮（R6-A）：再删 live run 目录下 `attachments` 不存在（#1165 起不再拷附件，src 无建此目录的路径）；admitted 原样路径断言留。第八轮整卷复扫：未命中。第十二轮账：a/S 2、a/T 1、仍在 1。无未证 null。 |
| `test/integration/public-cli-reviewer.test.ts` | D/S | 改：解析案删未知旗与空 `--project` 重复（承接 `test/integration/public-cli-failure-settlement.test.ts:36`），并删文件内同一条 inline prose 拒收的第一份（保留带齐其余前置的那份）；`--base`/`--lens`/`--authority-ref` 语法与 reviewer 不收 `--attach` 是独有边界，留。公开双 lens/single lens、失败 sibling 保留、scope 与 same session 留。第七轮（R6-A）：删三处 `--ak-review-task` 缺席（#236 已撤）与 admitted 上 `taskPath`/`taskSha256` 缺席（src 零命中）；`--ak-station-child` 缺席是在役旗的分支辨别，留。第八轮整卷复扫（D/S）：删 project 下无 `docs` 目录（src 无写 docs 的路径）与 resume 对话不含 `/skill:`（紧前一句已断言等于原话，且零产出）；解析案删「省略 lens 即双轴」的正向 deepEqual（同文件「default dual-lens admits both axes」经 runAkRole 同结论），拒收语法与各拼写留，案名随之改。第十二轮账：a/D 5、a/S 7。无未证 null。 |
| `test/integration/public-cli-same-ticket-resume.test.ts` | S | 第二十二轮 R23-A：工人恢复装配不接生产 attendance，见末节逐项账。此前：改：删退役 officer-pointer 哨兵；保公开 re-summon/new/manual resume 的不同身份与审官继续路径，非 ticket 相等就猜 session。第七轮（R6-A）：再删两处 run 目录 `attachments` ENOENT（同上，无生产者）；admitted 原样路径与外部原件可变留。第八轮整卷复扫：未命中。第十二轮账：a/S 3。无未证 null。 |
| `test/integration/public-cli-session-missing-fresh-summons.test.ts` | B | 第二十二轮复审 R23-A 同类邻接文件：沿默认生产 host 间接装配省略无关 attendance，保同/跨 host 恢复、new-run 及原失败断言；无新增删除账项，见文末补扫账。 |
| `test/integration/public-cli-seat-pipeline.test.ts` | B | 留：真实 public route/提交/report 与 diarist/countersign 二次 summons 不偷续前 run；非配置表自比对。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-seat-self-ticket.test.ts` | B | 留：typed 票号声明才归位，纯文本不推票号，malformed declaration 不拒原卷。第八轮整卷复扫：未命中。 |
| `test/integration/public-cli-secretariat-run.test.ts` | D/S | 第二十二轮 R23-A：工具及 adapter 两装配不接生产 attendance，见末节逐项账。此前：改：三宿主既有表并入 converged/escalate 原回执及零 nested gate 断言，删伪重复宿主案承接的空结论；保公开中书省→diarist/countersign/notary 链、escalation 与 host failure，不按文本判结论。第七轮（R6-A）：删四案中 `decisiveFacts.countersignTerminal`/`notaryTerminal === undefined`（#1195 `1ea12daa` 已撤他席终局投影，src 零产出）；各案 role/kind 与原回执正向断言留。第八轮整卷复扫：未命中。第十二轮账：a/D 5、a/S 7。无未证 null。 |
| `test/integration/report-ticket-adapter-exit-copy.test.ts` | B | 第二十二轮 R23-A：四处 adapter 装配不接生产 attendance，见末节逐项账。此前：留：公开真实 adapter（假 CLI/ACP 对端）中途 relocation 后 exit-copy 和 resume 仍在 ticket。第八轮整卷复扫：未命中。 |
| `test/integration/resume-missing-host-session-id.test.ts` | B | 留：executeTurn 无 bound session id 不新建，以及 required disposal failure 保宿主事实。第八轮整卷复扫：未命中。 |
| `test/integration/role-envelope-engine-axis.test.ts` | M/T/S/D | 第二十二轮 R23-A：#1092 不接生产 attendance；原 stationChild 三处已隔离，见末节逐项账。此前：改：删 judge/auditor 与 Pi root 两组人工材料清单及 packagedMaterials helper。剩真实 envelope 的 tools/list、request/env 隔离；恢复随机 Soul 输入到 systemPrompt.body 的穿透。第三轮 `:128` 在不覆写装载器的既有案断言包内 `souls/judge.md` 字节进入 systemPrompt。具体材料全集承接者 null，不机械裁定应读哪些法。第七轮（R6-A）：#1092 并发案删种入的 `attachments/case-dossier` 旧文件与按 kind `case-dossier-pointer` 计数为 0（生产零产出该 kind，种文件碰不到断言）；余下「并发 envelope 各自保留 prompt、不写 parent 的 AK_ROLE_RUN_DIR/AK_ROLE_COURT_ATTEMPT」是在役负向（`src/report-ticket-tool.ts:139` 生产中确会写 process.env），案名改为陈述该行为，不并入 #818 案（那案只守 engine env、不带 courtAttemptId）。第八轮整卷复扫：未命中。第十二轮账：a/M 6、a/S 3、b 2。第十四轮（R12-A）：审计官 subject Soul 字节补进同一案 :126，改好 1；judge 随机 Soul 仍为 b 1。I23-B：该 auditor 段与公开入口重复，删除其独立 run/env/envelope 前置；账 #628 改为 b，承接 test/integration/audited-run-identity-1166.test.ts:368–458（生产 subject Soul 观察 :137–139）。原 engine 行为、随机 Judge Soul、生产 Judge loader 与其他独有输入观察均保留。无未证 null。 |
| `test/integration/run-terminal-artifacts.test.ts` | B | 留：实际持久化 API 写/读 terminal，unknown/损坏文件与 sibling 隔离。第八轮整卷复扫：未命中。 |
| `test/integration/run-test-all.test.ts` | M | 改：删除 package.json scripts 原串镜像，形式语言不是自比豁免；保真实 runner child argv、选集、HOME 隔离及 exit/SIGTERM。第八轮整卷复扫：未命中。第十二轮账：a/M 6。无未证 null。 |
| `test/integration/test-agent-dir-model-seed.test.ts` | B | 留：fixture models seed 的文件边界、listener cleanup，不写机器 agent tree。第八轮整卷复扫：未命中。 |
| `test/integration/test-process-env.test.ts` | B | 留：实际子进程环境隔离、own home 清理/非 own home 不删的测试基础设施接口。第八轮整卷复扫：未命中。 |
| `test/integration/test-user-profile-preload.test.ts` | B | 留：真实 process preload 的 userInfo/HOME/profile 可用性与隔离，不改宿主配置。第八轮整卷复扫：未命中。 |
| `test/integration/ticket-snapshot-family-edges.test.ts` | M | 改：删只测试 fixture runner 自己拒绝 query 的两案及手工 query builder；保冻结 GitHub payload→真实 snapshot 的 parent/blockedBy、分页等结果，fixture 自测承接者 null。第八轮整卷复扫：未命中。第十二轮账：a/M 3。无未证 null。 |
| `test/integration/ticket-trajectory-binding.test.ts` | D | 改：删重复 legacy/计数，保真实 ledger index/render 消费 typed ticket、legacy、unbound 与 ambiguous run 路径。第八轮整卷复扫（D）：「flat run without ticketNumber」案 length===0 后紧跟同义 some===false，删后者第十二轮账：a/D 5、仍在 1。无未证 null。 |
| `test/integration/worker-submission-gates.test.ts` | S | 本票误判为重复，第二轮改正：unfinished reason 不是重复结论，有承接 `test/contract/judge-role.test.ts:629`。独有空白输入仍走 runtime 收卷；删旧目录哨兵（S），保真实 Git 的 commit 提醒、unborn/失败、开放前缀及现役 hook 清理。第八轮整卷复扫：未命中。第十二轮账：a/S 1、b 9。无未证 null。 |
| `test/adjudication/activation-bare-seam.test.ts` | B | 留：extension 激活入口的 git/durable principal 故障、原 cause、零加载及退出/abort 策略。第八轮整卷复扫：未命中。 |
| `test/package/npm-identity-metadata.test.ts` | M/D/S | 改（第二十轮 R21-A 更正原整删）：一次真实 npm pack/解包，:139 既有 bin 案检查生产声明的材料路径与 esbuild 解析的真实模块依赖；I22-A 续修再并入 :165–167 的真实模块加载，删除平行 fresh-build 前置；bin --help、空自动注册、许可证/peer 保留。源码中有实际读者的 doctor/merger/navigator 依赖不能一概判删；无读者 canonical-json、fixer-repair.md 及退役名字哨兵不恢复。逐项重判唯一真源为删除账 #666–#683；本文件累计 a/D 3、a/M 3、a/S 4、b 1、改好 11。变异与反例见第二十轮。 |
| `test/package/published-dist-import-closure.test.ts` | D | 删并（I22-A）：npm-identity-metadata.test.ts:139 已沿真实 npm pack → prepack/build → 解包检查同一批 dist 依赖，独有原生模块加载移到 :165–167。删除独立 checkout/build、listJsFiles/walk、assertRelativeImportClosure 与旧案；构建缺边、无 dist、加载求值失败、npm 缺件四个变异分别报红，见账 #1141–#1143 与下文。 |
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

## 第十七轮复审修理（R17-A）

起点 `9bd67a849ef6004524d9d0412dc5b260cd3bf4da`。依据大理寺 `01a16776-ad9c-7cd8-89ec-4449a93eb38f@judge/receipts/2.json`，符宝郎 `01a16782-cd82-77f5-8a51-72d631eb9f2d@notary/receipts/2.json`、审刑院 `01a16784-f637-7e7e-ae7b-4b6517d372a0@auditor/receipts/2.json` 已署。只处理同值复查，R15-A 与 R16-D 不重开。

### 扫类、复扫与取舍

错误形状：同次调用、同一对象（包括别名和 helper 参数）的一个值，已由精确值或更强谓词检查，随后又换断言函数、合取/条件表达式或 helper 调用重查。根因是只按断言函数和实参字面配对，没有贯通谓词、参数替换及别名。

全 `test/` 共 153 个 TS/JS 源文件，使用现有账本 `assert_calls` 取候选，不新增仓内扫描机制。实际命令：

- `rg -n 'assert\.(ok|equal|strictEqual|deepEqual|deepStrictEqual)|function assert|const assert[A-Z]' test`
- `rg -n '(function|const) assert[A-Z]' test` 与 `rg -n '\bassert[A-Z]\w*\(' test`：24 个声明，加成员回调 `assertDecisiveFacts`、转发回调 `assertIn`；打开函数与调用点比较实际参数，不把不同输入相并。
- `python3 /tmp/r18-predicate-scan.py`：复用账本提取器，把 equal/ok/布尔合取归一为候选谓词，初扫 204 对、复扫 196 对；每对再看调用、作用域与状态。保留的候选均属不同输入、不同对象或状态/时点变化，不把候选数量冒充待修数量。
- 对三元断言补查条件判别值及局部别名：初扫 16 对（其中一处被两个强断言覆盖），复扫 0 对；另手工展开 `parentPayloads` 别名。非目标分支的 `undefined`/空数组不能等于所断言的非空精确值，才删除独立判别值检查。
- `git diff --name-status 9bd67a84` 与 `git diff -U0 7997ffb2 -- test`：修改前后逐文件、逐基线断言核；29 个删去的调用都在基线，账新增 #1038–#1066，无新增或改弱断言。本轮差异 18 文件；累计基线差异为 125 文件（相较此前增加 public-cli-doctor），历史修改不冒记本轮。

选条原则：`gleaner-left` 留 :81 的 equal（实际值/期望值报错比 ok 的布尔失败清楚），删 :82 的 ok；其余留覆盖更多字段的精确断言或已复用的 helper。host helper 还服务 claude 输入，不能为了保留另两处的重复检查而删掉 helper 的共同检查；这两处原有 exitCode 断言仍携带各自 stdout/stderr。所有删除后的状态一并经过 tsc 与原入口案。

### 逐文件删并表

删除坐标全部是 `7997ffb2` 基线；保留坐标是本轮修后文件。每条的完整蕴含说明见账 #1038–#1066。

| 文件 | 删除基线行 | 保留断言／复扫结论 |
| --- | --- | --- |
| `test/contract/gatekeeper-pass-envelope.test.ts` | 115 | :104 receivedStatus 精确 other 蕴含 needs_reask。 |
| `test/integration/analyst-c3-model-groups.test.ts` | 149、156、166、213、214 | :119–127、143–145、185、189 的逐组精确值；同步删无消费者 denSum。原始组的空组排除与两项求和已由完整组数＋手算逐组值蕴含。aliased 是另一次调用，只承接其 grok/sol 两个未改 legCount 的展开值，不借原始组结果。 |
| `test/integration/audited-run-identity-1166.test.ts` | 702 | :589–592，parentPayloads 条件别名的末项精确 second 对象。 |
| `test/integration/public-cli-countersign-run.test.ts` | 330、375、528 | :291、335、487；分别是各自调用的 cause/status 强检查，不跨 resume 相并。 |
| `test/integration/public-cli-doctor.test.ts` | 462 | :462 refused 状态数组。 |
| `test/integration/public-cli-escalation-resume.test.ts` | 497 | :243、493 的 helper 已守同一 runId 的 string＋非空；后续 resume 是另一次调用，未删。 |
| `test/integration/public-cli-fixer.test.ts` | 554 | :429 refused 状态数组。 |
| `test/integration/public-cli-gleaner-left-run.test.ts` | 85、216、259 | :81、202、244；equal 取代 ok 同值复查，两个调用分别保留 cause/status 强检查。 |
| `test/integration/public-cli-host-axis.test.ts` | 835、919 | :801 共同 hostFailure 检查，经 :842、924 的实际参数作用于各自 result；第三个 claude 调用 :965 保留。 |
| `test/integration/public-cli-instruction-seat.test.ts` | 148 | :121 非空状态数组；assertDecisiveFacts 对首对象 status 的观察不等于过滤后的状态序列，保留。 |
| `test/integration/public-cli-navigator-attendance.test.ts` | 244 | :237 条件分支内诊断精确值。 |
| `test/integration/public-cli-report-ticket.test.ts` | 548 | :83–84、548 的 helper 先等同路径再检查存在；mid-turn 与 settle 两阶段、内存 admitted 与磁盘 current 观察仍各自保留。 |
| `test/integration/public-cli-resume-416.test.ts` | 135、224 | :133、222，分别为 accepted 分支 note 精确值与 failure 合取。 |
| `test/integration/public-cli-resume.test.ts` | 1543、1812 | :1549、1813，kind 与 diagnostic 的合取；artifact 对照 :1825 保留。 |
| `test/integration/public-cli-reviewer.test.ts` | 669 | :618 父结果 failure 分支精确 payloads 值；不同子腿的 outcome 不动。 |
| `test/integration/public-cli-same-ticket-resume.test.ts` | 277、459、485 | :276、457、482，各调用自己的非空状态序列，未跨时间点借用。 |
| `docs/research/issue-1237-deletion-ledger.md` | 无测试断言 | 已修：按基线补 29 行，每行指向保留检查；R16 历史坐标仍锚定 5ee5b065。 |
| `docs/research/issue-1237-test-quality-sweep.md` | 无测试断言 | 已修：本节是本轮逐文件表与复扫结算，不复写旧轮事实。 |

### helper 全树复核表

以下为本轮保留位置；每个声明均核过实际调用，不用函数名命中代替参数审查。

| 声明 | 复扫结论 |
| --- | --- |
| `test/package/published-dist-import-closure.test.ts:53` assertRelativeImportClosure | 无：调用后不重查 files，build 是实际动作。 |
| `test/unit/activation-envelope-module.test.ts:25` assertRetryingJsonlWriter | 无：调用者不重查 chunks/calls/schema。 |
| `test/helpers/run-dossier-fixture.ts:203` assertRunDirectoryHoldsOnlyDossier | 无：允许目录集合与调用处字段/交付内容不同。 |
| `test/helpers/test-agent-dir-guard.ts:46` assertWritableTestAgentDir | 无：安全前置，不是重复结果断言；各非法输入不同。 |
| `test/helpers/failure-settlement-kit.ts:78` assertPublicFailureSettlement | 无：沿上一节 17 调用点重新对照；原 R16-D 四条未恢复，其他字段/输入独立。 |
| `test/contract/durable-session-write-failure.test.ts:88` assertDurableFlushFailure | 无：两个 closeRound 调用不同，调用处不重查返回对象。 |
| `test/contract/analyst-b2-frame-buckets-actions.test.ts:132` assertRunMetrics | 无：prd/overlap 为不同 run，后段写入新源卷后重跑，不能借前次值。 |
| `test/contract/analyst-gate-cycles.test.ts:568` assertAuditorRolesUnreadable | 无：每次更换失败源卷再 runAnalyst，不同输入保留。 |
| `test/integration/analyst-c3-model-groups.test.ts:118` assertGroupEqual | 已修：上表五条；原始组与 alias 调用不混同。 |
| `test/integration/public-cli-report-ticket.test.ts:75` assertCurrentLocationPaths | 已修：调用处重复存在性；不同阶段和不同 current section 的字段值保留。 |
| `test/integration/public-cli-report-ticket.test.ts:355` assertProvenanceRow | 无：调用处未重查同一 provenance row。 |
| `test/integration/public-cli-report-ticket.test.ts:1543` assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory | 无：各调用是不同 reask 输入；函数内互斥分支不相并。 |
| `test/integration/public-cli-resume.test.ts:230` assertCleanupDiagnosticNoted | 无：各失败/恢复阶段不同，调用处不重查同一 diagnostic。 |
| `test/integration/public-cli-resume.test.ts:1806` assertThisCallDispatchedFailure | 已修：kind 独立检查由同一 outcome 的合取承接；各次调用的 diagnostic 具体值仍独立。 |
| `test/integration/public-cli-resume.test.ts:1831` assertPreHostResumeDiagnostic | 无：prehost 与 dispatched 不是同一结果；调用处 hostFailure/旧终局/源卷保全为独立字段。 |
| `test/integration/public-cli-seat-self-ticket.test.ts:145` assertDurableTicket | 无：磁盘 admitted/invocation 与内存 result.admitted 是不同观察对象。 |
| `test/integration/public-cli-seat-self-ticket.test.ts:155` assertDurableUnbound | 无：同上，各输入的 unbound 状态不混并。 |
| `test/integration/public-cli-escalation-resume.test.ts:228` assertEscalationPresented | 已修：oldAuditorRunId 别名类型复查；恢复后终局不是 first。 |
| `test/integration/public-cli-engine-axis.test.ts:64` assertNoEngineFlagsInArgv | 无：七处调用后查 invocation/env，是不同输出面。 |
| `test/integration/public-cli-host-axis.test.ts:441` assertSetModelBeforePrompt | 无：三处不同 frames；调用处 assert.ok(promptFrame) 保留类型缩窄，不把 resume/拒绝分支相并。 |
| `test/integration/public-cli-host-axis.test.ts:794` assertPlannedReceipt | 已修：两个调用处 hostFailure 复查；claude 调用需要共同检查。 |
| `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts:75` assertNoUnboundPrefix | 无：初次/恢复/inspector 各自不同捕获对象。 |
| `test/integration/analyst-public-cli.test.ts:66` assertSnapshotsEqual | 无：三个入口失败各自取前后快照，调用处不重查同一快照字段。 |
| `test/integration/headless-codex-host.test.ts:34` assertStrictObjectNodes | 无：helper 检查 required 覆盖实际 properties，调用处检查明确字段集合，不是相同命题；初始/resume 也为不同调用。 |

边界复核：oauth tick/stop-start、factory-board 切排序/筛选、trajectory 推时钟、engine-resume-detour 的两次 config 调用、reviewer 不同坏输入、worker gate 改 git 状态、host-session pointer/warning/copy 三阶段都保留。failure-provider-stop 的 timeout/nonzero 与 engine-detour 的各输入分支互斥，不互相承接。辅助正则不能证明对象身份，未按候选批量删行。

### 自验与自审

- 修前按发现面分三组跑原入口案：89/89（6827.486375 ms）、60/60（4085.229542 ms）、3/3（1741.27425 ms）。没有把修前绿灯冒作修后结果。
- 修后：`node --import tsx --import ./scripts/test-process-env-preload.mjs --test $(git diff --name-only -- test)`，16 文件，152/152，11230.446125 ms。该动态命令指提交前工作树；提交后复现须从本轮起点取文件列表。
- 修后 `npx tsc --noEmit` exit 0，`git diff --check` 无输出；工作树账核算 COUNT/MATCH 1065 = 18 文件 + 115 案 + 932 断言，a/D 525，其他桶不变。提交后用未改的 `python3 -I docs/research/issue-1237-deletion-ledger.py` 再核 HEAD。
- 没有新增函数/测试，diffItems=[]。所有测试仍走原入口、保留原强 oracle 与状态变化；本轮是删重而非生产行为修复，不新增证明性测试、不改生产逻辑作验收机制。测试 diff 只有删除（29 断言及专属变量/注释），未删整案或输入。
- 没跑全量；没改生产、helper 接口、runner、Soul、配置或治理文件。官方 Node assert 文档用于核对 equal 与 ok 的诊断区别，没有引入依赖。

## 第十八轮（R18-A）

起点 `a835809e43b4c97eca4f214b2942d464c333d10a`，工作树开工时干净。依据大理寺 `01a16776-ad9c-7cd8-89ec-4449a93eb38f@judge/receipts/3.json`；符宝郎 `01a16782-cd82-77f5-8a51-72d631eb9f2d@notary/receipts/3.json`、审刑院 `01a16784-f637-7e7e-ae7b-4b6517d372a0@auditor/receipts/3.json` 均署。这里只记施工，未代任何审席作复审结论。

错误形状与根因：判别谓词已经决定中间变量的真假分支，后续断言又拒收假分支；此前扫描只在一条 assert 内追踪条件与期望，漏掉中间绑定，也漏掉 `assert.equal(predicate, true)` 对谓词的布尔编码。原 R17-A「条件候选零」不是完整数据流零命中，本轮纠正此扫描边界；不重开已经结清的其他类。

### 全树扫描与复扫

扫描全部 153 个 TS/JS 源文件，复用现有账本 `assert_calls`，内联 Python 只产候选，不入仓、不自动删行。先向前查断言后的同谓词（不设 40 行窗口，遇下一案或 await 截止），再反向枚举条件绑定并看来源与消费者；包含换行、optional/non-null 写法、布尔谓词及 helper 内部，不只查 kind/status 名称。`curl -fsSL https://nodejs.org/api/assert.html` 核对 ok 的 truthiness 契约，未引入依赖。

- 第一遍直接字段扫描产 58 条引用候选；逐项看上下文，除 merger-run 外是 if/提前返回/throw 缩窄、注释或不同对象，不把 if 内检查会跳过的情形当作蕴含。
- 反向条件绑定提取产 275 条宽候选（含类型可选字段、正则和夹具），读谓词来源与后续消费者，补到 durable-session 的 `"failure" in closed`。它与点名样本是同一链路，不是另起类别。
- 将布尔编码归一后，同谓词紧接 `?` / `&&` 的正向候选为下表 4 条；删两条后按同一内联命令复扫剩 2 条，均为已列的静默跳过 if。**实质命中 2 条，已删 2 条，未修 0 条**；不把判词预估的一处当作白名单。

| 起点命中 | 取值／消费者与结果 |
| --- | --- |
| `test/contract/durable-session-write-failure.test.ts:95` | 已修。:96 条件取 failure，:97 的 ok 拒收 undefined；修后承接 :95–96。辅助函数两次 closeRound 的输入仍各自验证，未跨调用相并。 |
| `test/integration/public-cli-merger-run.test.ts:243` | 已修。:245–248 条件取 recorded，:249 的 ok 拒收 undefined；修后承接 :244–248。原 payload 数量与两个原始对象精确检查全部保留。 |
| `test/integration/dossier-resolution.test.ts:46` | 不同类，保留。:48 的 if 要求 a、b 同时为 ok；否则内部路径检查静默跳过，不会拒收兜底。 |
| `test/integration/dossier-resolution.test.ts:71` | 不同类，保留。:73 同上，且是另一次入口调用；不借前案结果。 |

### 本轮逐文件表

`git diff --name-status a835809e` 的四文件逐项核；基线核算仍用 `7997ffb2`。本轮两条删除均先打开基线断言及相邻条件绑定核过，再按累计 diff 复核为下面两个位置；没有把 merger-run 基线 :602 的另一调用混进来。

| 文件 | 删除基线位置／处置 |
| --- | --- |
| `test/contract/durable-session-write-failure.test.ts` | :95，账 #1067；只删判别谓词的前置断言，条件取值和拒收断言保留。 |
| `test/integration/public-cli-merger-run.test.ts` | :517，账 #1068；只删 accepted 判别断言，条件取值和拒收断言保留。 |
| `docs/research/issue-1237-deletion-ledger.md` | 新增两条及修后拒收断言坐标；R17-A 承接坐标明确锚定 a835809e。 |
| `docs/research/issue-1237-test-quality-sweep.md` | 本节记录真实两处命中、两处排除及复扫；历史结论不冒作本轮结论。 |

### 自验与自审

- 修前两文件原入口案：5/5，1756.113542 ms；修后同命令：`node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/contract/durable-session-write-failure.test.ts test/integration/public-cli-merger-run.test.ts`，5/5、0 fail，1543.806334 ms。输出的 EISDIR 是既有 shutdown 故障注入案的预期诊断，不是测试失败。
- 修后 `npx tsc --noEmit` exit 0。原入口、输入、拒收断言及具体结构化值检查不变；这次纯删重，不改生产作变异，也不新增证明性测试。
- 工作树账 COUNT/MATCH 1067 = 文件 18 + 案 115 + 断言 934；a/D 527，其余桶不变。提交后再用原命令 `python3 -I docs/research/issue-1237-deletion-ledger.py` 核 HEAD。
- `git diff HEAD` 自审：测试仅删两行，新增生产函数/测试函数/helper 均无，diffItems=[]；无死变量，两个前置断言已退役。没改生产、runner、Soul、配置或治理文件；没跑全量、没派角色、没 amend/rewrite/push。

## R18-B 复审修理

起点 `959d69a2c5e2b0d544c454660af01b53d111f9ff`；依据调用方本轮原样递交的 R18-B 判词。开工实查 HEAD 与工作树：符合起点且干净。R18-A 两条删除不恢复；其拒收能力由更强的精确字段检查继续承接，不把中间 ok 当作豁免。

错误形状：同次、同对象的存在性断言，被后面可选链字段的非 undefined 精确期望蕴含，中间无 await 或状态变化。根因是前轮检查止于中间存在性 guard，没有继续追问这个 guard 是否也已被更强 oracle 覆盖。

### 扫类与复扫

全 `test/` 153 个 TS/JS 源文件，用现成账本 `assert_calls` 加内联 Python 提取 ok/非空/notEqual 的存在性候选，向后比对同对象的 optional-chain equal/deepEqual；遇下一案或 await 截止，人工核对期望值、对象身份及类型用途。初扫 **7 对蕴含关系、4 条 guard**，修后同命令 `OPTIONAL ORACLE CANDIDATES 0`；另补多层 optional/non-null 链前缀归一，`NORMALIZED CHAIN CANDIDATES 0`。扫描不入仓、不自动改行。

| 起点 guard | 起点强 oracle（逐对） | 处置与修后坐标 |
| --- | --- | --- |
| `test/contract/durable-session-write-failure.test.ts:96` | :97 code 精确值 | 已修；保留 :96。 |
| `test/contract/durable-session-write-failure.test.ts:96` | :98 cause=output | 已修；保留 :97。 |
| `test/contract/submission-ledger.test.ts:381` | :382 accepted deepEqual 本次非空 params | 已修；保留 :381。 |
| `test/integration/public-cli-diarist-run.test.ts:1829` | :1831 speaker=owner | 已修；保留 :1830。:1830 原 sessionParent=undefined 不是承接。 |
| `test/integration/public-cli-failure-artifacts.test.ts:799` | :800 sequence=1 | 已修；保留 :799。 |
| `test/integration/public-cli-failure-artifacts.test.ts:799` | :801 role=judge | 已修；保留 :800。 |
| `test/integration/public-cli-failure-artifacts.test.ts:799` | :802 runId=该次 runId | 已修；保留 :801。 |

边界：`public-cli-coder.test.ts:95–96` 的 summaryProperty 用于直接属性访问，缩窄保留；不把可能抛 TypeError 当成精确 oracle。另搜 `assert.equal/strictEqual(... !== undefined/null, ...)` 的布尔写法：scopeRootIdentity 存在性后无精确字段检查，其余为不可混同的复合缺席检查。`analyst-c3-model-groups.test.ts:165–169` 的 aliasedPage 总和保留，该次调用没逐项锁定 mixed/luna 的 legCount；不能借 raw 调用承接。所有条件绑定、独立精确值、输入与阶段不变。

### 本轮逐文件表与基线核对

`git diff --name-status 959d69a2` 共六文件。删前逐条打开 `7997ffb2` 原始 assert，删后累计 diff 再核；新增 #1069–#1072，不重排旧号。

| 文件 | 处置 |
| --- | --- |
| `test/contract/durable-session-write-failure.test.ts` | 基线 :97，删一行；条件绑定保留，code/cause 继续拒收 undefined。 |
| `test/contract/submission-ledger.test.ts` | 基线 :383，删一行；非空 params 精确对象检查保留。 |
| `test/integration/public-cli-diarist-run.test.ts` | 基线 :1844，删一行；speaker 精确值和独立 sessionParent 检查保留。 |
| `test/integration/public-cli-failure-artifacts.test.ts` | 基线 :824，删一行；attempt-history 三个精确字段全部保留。 |
| `docs/research/issue-1237-deletion-ledger.md` | 补四条及修后承接；R18-A 的历史 ok 坐标锚定 959d69a2，并注明后继强 oracle。 |
| `docs/research/issue-1237-test-quality-sweep.md` | 本节记七对关系、四条删除、边界与实测，不改写旧轮结果。 |

自验：修前四文件 39/39，2234.9205 ms；修后 `npx tsc --noEmit` exit 0；`node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/contract/durable-session-write-failure.test.ts test/contract/submission-ledger.test.ts test/integration/public-cli-diarist-run.test.ts test/integration/public-cli-failure-artifacts.test.ts` 为 39/39、0 fail，2119.318666 ms。日志含既有故障注入 EISDIR、临时夹具未提交 HEAD 与 malformed progress 的诊断；均非本次断言失败，修前亦有。

工作树计数 COUNT/MATCH 1071 = 18 文件 + 115 案 + 938 断言，a/D 531，其余桶不变；提交后用原 `python3 -I docs/research/issue-1237-deletion-ledger.py` 核 HEAD。自审测试 diff 仅四行删除，diffItems=[]；没有新增测试、helper、生产或扫描机制，没有死变量；原入口与强结果检查不变。未跑全量、未派角色、未 amend/rewrite/push。

## R19-A 复审修理（P3）

起点 `4c03245ff0688ddc22d255b6b0200cbfa6d4bf55`。核对本票第五卷 judge/notary/auditor 回执，目录为 `~/.ak-roles/books/ak-pi-workflow-roles/1237/runs/` 下 `01a16776-ad9c-7cd8-89ec-4449a93eb38f@judge/receipts/5.json`、`01a16782-cd82-77f5-8a51-72d631eb9f2d@notary/receipts/5.json`、`01a16784-f637-7e7e-ae7b-4b6517d372a0@auditor/receipts/5.json`。31 处是实证下限，不是白名单或穷尽证明。

错误形状：同案弱检查 A 已被后续强检查 B 必然蕴含，A→B 之间无 await、分支边界或状态变化，A 也不承担必要类型缩窄。根因是此前只查相邻同谓词或某种 optional-chain 写法，漏看直接访问、别名读卷、捕获数组、长度与更强索引关系。修法只删 A；不改 B、输入、生产代码或边界。

### 扫类、单删核验与复扫边界

复用仓内 `docs/research/issue-1237-deletion-ledger.py` 的 `assert_calls`，不新增仓内扫描器。全 `test/` 153 个 TS/JS 源文件盘点 4734 个断言调用，再作宽候选配对、弱断言上下文及 helper／捕获来源复核。临时命令：`python3 /tmp/r19-inventory.py`、`python3 /tmp/r19-candidates.py`、`python3 /tmp/r19-probe.py`；材料在本席工具卷与 `/tmp/r19-{all-asserts,weak-context,helper-context,capture-origins,final-b}.txt`。临时文件只作本次调查，不成为仓库运行前提。

- 主轮单删探测 370 候选：240 次 tsc 0、130 次报错；补查 15 候选为 14 次通过／1 次报错（与主轮有重复），末三条全部通过，analyst-entry 的长度检查另作单删通过。**最终选定 63 条均有单删 tsc 0**。探测在临时 HEAD 副本逐条删、逐条恢复，未覆盖工作树；最初副本缺 scripts 链接的基线失败不计为 guard 证据，补全后重跑基线与探测。
- tsc 通过不等于可删。逐条核过 A 的拒收集合、同一对象／别名来源、B 的实际消费者与中间边界，再打开 `7997ffb2` 原始断言对照；不增加 `!`、`as`、可选链或补断言以求通过。
- 31 条判词样本全部删除；向外扩展 32 条，共 63 条、30 个测试侧文件。额外含 14 条捕获数组检查、别名路径读卷、some/find、长度与顺序关系；具体承接 B 逐条记于删除账 #1073–#1136。
- 修后以同一盘点／候选逻辑重扫：153 文件、4671 断言，差额恰为 63；弱检查上下文 856 条、配对候选 324 条。重看已修改文件、剩余候选的反例与 helper 来源，未再选出满足本轮定义的 A。**候选数量与本次未再选出不构成语义穷尽证明**；配对器不能判定任意别名、路径、跨函数值域或隐含边界，不能拿它的零增量代替人工蕴含判断。

### 保留检查的独立作用（坐标为起点）

| 保留位置 | 不能按本类删除的原因 |
| --- | --- |
| `test/helpers/failure-settlement-kit.ts:92` | terminal 必要缩窄；单删 TS18048。只删 :114 的 errorRef 检查，不删此 guard。 |
| `test/integration/analyst-entry.test.ts:786` | roundTimeline 缩窄，单删 TS18048；后续循环不是替代类型证明。 |
| `test/integration/pipeline-lifecycle-formalization.test.ts:111` | artifact 缩窄，单删 TS18048；与 :102 的 judgeRun! 路径消费不同。 |
| `test/integration/engine-detour-usage-ledger.test.ts:1012` | typeof string 不能由后续 length>0 蕴含，非空数组可通过长度；即使单删 tsc 0 仍保留。 |
| `test/integration/public-cli-diarist-run.test.ts:1204` | 非空字符串检查不被 includes 蕴含：空串也被任意字符串 includes。 |
| `test/integration/public-cli-diarist-run.test.ts:1988` | diagnostic 的 as string 来值可能实际为数组，后续 length>0 不拒收非空数组；不能照搬捕获 argv 的受限来源。 |
| `test/integration/public-cli-reviewer.test.ts:1043` | Array.isArray 后续经过状态改写／await，再用 resumeArgs；不得跨边界相并。 |
| `test/integration/factory-board.test.ts:753` | Map 中 A 的存在不能从 B/C 的父编号字段推出，父引用不证明目标节点存在。 |
| `test/integration/activation-envelope-contract.test.ts:124` | instanceof 身份不被 code 或 cause.status 蕴含；外层 throws 与身份检查全部保留。 |

捕获数组的删除只适用于赋值为 `[...args]`、初值 undefined 的来源；`assertNoEngineFlagsInArgv` 在 `public-cli-engine-axis.test.ts:65` 直接调用 argv.some，未捕获会失败。`capturedEnv && capturedArgs` 合取由同一同步段内 :690 的 env 读取和 :696 的 argv 消费共同承接。路径别名的承接先经过 join、basename 或 .path 直接读取；不把单独的 TS 非空断言当运行时验证。

### 本轮逐文件表

`git diff --name-status 4c03245ff0688ddc22d255b6b0200cbfa6d4bf55` 的 32 文件逐项核。下列数字为**起点 A→修后 B**，每对均属于该行文件；完整 B 的 path:line 和 `7997ffb2` 删除坐标在逐条账中。全部测试文件处置为「已修」：只删相应弱检查，B 与原入口仍在；两文档记录本轮，不复制测试或机制。

| 文件 | 删除数；A→B／处置 |
| --- | --- |
| `test/contract/gatekeeper-pass-envelope.test.ts` | 2；184→184，225→224 |
| `test/contract/ticket-trajectory.test.ts` | 3；186→186，189→188，190→188 |
| `test/helpers/failure-settlement-kit.ts` | 1；114→120 |
| `test/integration/activation-envelope-contract.test.ts` | 1；126→127；外层 :121 未删 |
| `test/integration/analyst-entry.test.ts` | 1；887→887 |
| `test/integration/engine-detour-usage-ledger.test.ts` | 1；995→995 |
| `test/integration/factory-board.test.ts` | 2；754→754，755→755 |
| `test/integration/gate-officer-resume-accounting.test.ts` | 2；287→287，353→352 |
| `test/integration/pipeline-lifecycle-formalization.test.ts` | 2；94→94，102→103 |
| `test/integration/public-cli-1132-delivery-request.test.ts` | 2；241→242，952→955 |
| `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts` | 1；258→265 |
| `test/integration/public-cli-coder.test.ts` | 5；276→276，412→412，689→687，754→751，919→916 |
| `test/integration/public-cli-countersign-run.test.ts` | 1；329→329 |
| `test/integration/public-cli-doctor.test.ts` | 2；373→373，461→460 |
| `test/integration/public-cli-engine-axis.test.ts` | 8；141→141，274→270，432→423，605→591，655→636，714→696，894→864，961→926 |
| `test/integration/public-cli-failure-artifacts.test.ts` | 2；409→409，418→424 |
| `test/integration/public-cli-failure-real-entry.test.ts` | 1；656→656 |
| `test/integration/public-cli-failure-settlement.test.ts` | 2；153→153，302→301 |
| `test/integration/public-cli-fixer.test.ts` | 3；176→176，428→427，561→559 |
| `test/integration/public-cli-gleaner-left-run.test.ts` | 1；240→240 |
| `test/integration/public-cli-host-axis.test.ts` | 1；454→454 |
| `test/integration/public-cli-instruction-seat.test.ts` | 1；105→105 |
| `test/integration/public-cli-judge.test.ts` | 1；281→281 |
| `test/integration/public-cli-merger.test.ts` | 2；289→290，293→295 |
| `test/integration/public-cli-report-ticket.test.ts` | 1；1216→1216 |
| `test/integration/public-cli-resume-callable-seats.test.ts` | 1；262→262 |
| `test/integration/public-cli-resume.test.ts` | 4；272→272，328→327，496→494，676→673 |
| `test/integration/public-cli-reviewer.test.ts` | 4；774→774，795→796，1041→1039，1151→1148 |
| `test/integration/public-cli-same-ticket-resume.test.ts` | 3；1065→1068，1082→1084，1451→1450 |
| `test/integration/ticket-snapshot-family-edges.test.ts` | 2；211→211，218→217 |
| `docs/research/issue-1237-deletion-ledger.md` | 已修；新增 64 行记录，其中 63 条 a/D、1 条外层「仍在」；保留旧轮编号与历史事实。 |
| `docs/research/issue-1237-test-quality-sweep.md` | 已修；本节列扫描边界、保留反例、逐文件表与实测，不再以 31 或候选命中数宣称穷尽。 |

### 自验、自审与账表差额

- 分批修改前原测试入口通过：首批 140/140（13111.066208 ms）、扩展批 90/90（10215.74425 ms）、新增覆盖批 28/28（10202.077 ms，含 diarist-run 保留检查）、relocate-resume 1/1（1393.441833 ms）。批次有重叠，不累加冒报案数。
- 最终测试侧变更后 `npx tsc --noEmit` exit 0；`git diff --check` exit 0。聚焦命令 `node --import tsx --import ./scripts/test-process-env-preload.mjs --test $(git diff --name-only -- test | grep '\.test\.ts$') test/integration/public-cli-failure-provider-stop.test.ts`：250/250、0 fail、21518.69825 ms（`/tmp/r19-after-tests.log`）。failure-settlement helper 的 17 个调用点覆盖在 failure-provider-stop、failure-real-entry、failure-settlement、failure-artifacts 四文件中。
- 测试变更净删 95 行、63 个断言，不新增测试或 helper，不改任何生产函数。`git diff HEAD` 逐函数自审：新增生产函数／测试函数均无，diffItems=[]；原入口、输入、后续强断言与失败路径不变，无死变量与替代分支残留。纯删重并非生产行为修复，恢复旧 A 仍应绿，不虚报红绿变异证据。
- 原脚本按「断言跨度内有删除行」计数，因此 activation-envelope 外层 :121 的 assert.throws 随内层 :126 删除一并进入机械清单，但调用本身没删。新增 64 条 = 63 条 a/D + 1 条「仍在」，非实际删 64 条。工作树变体仅将 diff 的 BASE..HEAD 改为 BASE..工作树，输出 `COUNT 1135 / MATCH 1135`，分项 18 文件 + 115 案 + 1002 断言；a/D 594、仍在 23，其余桶不变。提交后由未改动的原脚本核 HEAD。
- 本席仍为复审修理轮，非判官 converged／PR 已开的最终待合并 HEAD；按测试分级只跑触及面，不跑全量。旧卷 643/643 不冒作本轮结果。未派角色、未改席位或宿主配置、未改 Soul／宪法、未 amend/rewrite/push。

### R19-A 续修 I19-A（起点 fa4bff02）

依据调用方原样交来的 `status=continue`、finding `I19-A`，起点 `fa4bff02515512d9500cc24a0c4b5c1a1b81b2c0`，开工实查工作树干净。首交 63 条删除认可，但「未再选出」不能当作类已修净：四处承接关系漏判，现补删。此前对 rawIndex 只看单条邻居检查、没有接受两条联合蕴含，是错误判断；B 可以是联合检查或实际属性消费，不限定为单条同形断言。此续修仅删判词四条，不添加任何替代检查。

沿同类再次定位，命令原样为 `rg -n 'assert\.(ok|equal|notEqual).*([.]length|[.]some|[.]find)' test --glob '*.ts' --glob '*.js'`，修前 366 行、修后同命令 362 行。浏览定位结果后重点打开 some/find、邻居索引、末项属性消费及固定索引的上下文与来源；四处均在结果中。该命令不覆盖所有多行或别名表达式，数字不是语义穷尽证明，也不把只浏览定位行冒作逐项证明。复用了既有临时单删探测脚本，四候选分别在 HEAD 副本单删再恢复，结果 `DONE 4 PASS 4`；基线 tsc 也通过，没有新建扫描机制或仓内脚本。

来源与边界复核：

- factory-board 的 some 与 find 是同一个 runs、同一个 runId 谓词；找不到时两项字段精确值必失败。中间 judge station 断言属独立事实，保留。
- diarist 的 lines 追到 `test/helpers/ticket-provenance-fixture.ts:50–60` 的 readTicketProvenanceRecords → readSitianRecords → `src/sitian-reader.ts:34` JSON.parse。原数组的 findIndex 返回 -1/0 时前邻居 text 检查失败，末项时后邻居检查失败；两条联合承接完整范围。不是从 as 类型推定运行时来源。
- report-ticket 的 progress 是本地 filter 结果；空数组时末项的 .session 真实读取必失败，后续 .receipt 与路径检查也保留。landing 只作同步计算，不跨 await；`!` 仅类型标记，不是拒收者。
- engine-resume 的 captured 初始化为 []，在同一 host 回调 push request.engine；索引 0、1 均须等于非空 ENGINE，完整承接至少二项，后续 every 仍保留。

额外打开的保留反例（坐标均为 fa4bff02）：`public-cli-engine-resume-detour.test.ts:333` 的 autoResumePrompts 非空不能被 every 蕴含；`public-cli-reviewer.test.ts:1112` 的至少两 provider 不能被后续 for 循环蕴含；`ticket-trajectory.test.ts:125` 的至少四 station 不能被逐现有元素循环蕴含；`engine-detour-usage-ledger.test.ts:736` 的至少两 scope 不能由 every 或另一 usage 对象推出；`public-cli-report-ticket.test.ts:1050` 的至少两 prompt 不能由两个可能同为 undefined 的字段相等推出；`factory-board.test.ts:1446` 检查真实 sort control 存在，不能由自建 select 的脚本执行替代。这些不按本类删除。

本次 `git diff --name-status fa4bff02515512d9500cc24a0c4b5c1a1b81b2c0` 六文件逐项表；不是把整票改动冒称为四行纯删。此前 R19-A 首交的 B 坐标固定在 fa4bff02，不随本次删行漂移。

| 文件 | 起点命中与修后承接／结果 |
| --- | --- |
| `test/integration/factory-board.test.ts` | 已修；A :268 删除，B :270–271；基线7997ffb2 :269，账 #1137。 |
| `test/integration/public-cli-diarist-run.test.ts` | 已修；A :1190 删除，B :1190–1191；基线 :1195，账 #1138。 |
| `test/integration/public-cli-engine-resume-detour.test.ts` | 已修；A :324 删除，B :324–325；基线 :324，账 #1139。 |
| `test/integration/public-cli-report-ticket.test.ts` | 已修；A :569 删除，B :573–578；基线 :571，账 #1140。 |
| `docs/research/issue-1237-deletion-ledger.md` | 已修；新增四条 a/D、逐条 B 坐标；1139 行，18 文件＋115 案＋1006 断言，a/D 598、仍在23。 |
| `docs/research/issue-1237-test-quality-sweep.md` | 已修；本节承认首交漏判，补联合蕴含、来源、逐文件表及本次验证；历史实测不重写。 |

验证与自审：

- 修前 `npx tsc --noEmit` 通过；四项单删各自 tsc 0。聚焦命令 `node --import tsx --import ./scripts/test-process-env-preload.mjs --test test/integration/factory-board.test.ts test/integration/public-cli-diarist-run.test.ts test/integration/public-cli-report-ticket.test.ts test/integration/public-cli-engine-resume-detour.test.ts`，修前 82/82、0 fail、6238.228625 ms；修后同命令 82/82、0 fail、6306.83575 ms（`/tmp/r19-cont-before.log`、`/tmp/r19-cont-after.log`）。修后 tsc 通过；不虚报生产变异或全量。
- 累计 R19-A 实删 67 条；机械账比首交多四条，工作树口径 COUNT/MATCH 1139。提交后用未改动的 `python3 -I docs/research/issue-1237-deletion-ledger.py` 核 HEAD。
- `git diff HEAD` 自审：测试侧只有四行删除，新增生产函数、测试函数、helper 均无，diffItems=[]；输入、承接者、judge station 独立检查与失败路径全部保留。未增加扫描机制、证明测试、新断言或配置改动；不 amend/rewrite/push、不派角色，交卷由调用方续送复审。

## 第二十轮：R21-A / R21-B（起点 c2c9175d）

依据：本票 `runs/01a16776-ad9c-7cd8-89ec-4449a93eb38f@judge/receipts/10.json`。只改该判词圈定的一个测试、核账脚本及两张账表；不改生产、Soul、治理、席位或宿主配置。原有未跟踪 `node-test-report.txt` 未动。

### R21-A：真实打包行为不能因期望表坏而整删

根因：此前把真实 npm pack 的输出检查误称为「不调用在役分支」，把手抄期望值的缺陷误当成被守行为不存在。修法并入现有 bin 案，没有增加测试案、夹具、打包次数或复制清单。材料期望直接取 PUBLIC_ROLE_RECORDS.sessionMaterials 与 AUDITOR_SESSION_MATERIALS；实际解包的模块依赖复用 esbuild（仓内 fresh-build closure 已用的解析器），包含生产声明的内部入口与包内 dist 模块。后者检查的是 npm 裁剪后的树，不是 fresh-build 案的构建输出，故能抓它抓不到的 files 排除。断言只落在 pack JSON 的路径字段与模块/进程成功结果，不检查材料文案。

扫类与复扫命令（均真跑）：

- `rg -n 'extracted\.paths|release inventory|packageJson\.bin' docs/research/issue-1237-deletion-ledger.md`：命中 #662、#666–#683，逐条结论直接落在该账行，不在此维护第二份。#662 退役 patches 哨兵不属本类；#666–#683 全部重判，无漏行。
- `git grep -n -E 'canonical-json|fixer-repair' -- src extensions scripts`：零引用。`git grep -n -E 'method-skill|fixer-prerequisites.json|fixer-repair.json' -- src extensions scripts`：仅有三个 machine-method-skills 引用，不是退役 package-resources 装载器。
- 进一步打开 extensions/role-runtime.ts、src/role-runtime.ts、src/role-runtime-dependencies.ts、src/packaged-role-registry.ts、src/auditor-soul.ts、src/session-opening-materials.ts、scripts/build-package.mjs，以及 `7997ffb2:test/package/npm-identity-metadata.test.ts` 的完整旧清单。确认 src/doctor-contracts、doctor-evidence、navigator-attendance、merger-contracts、merger-git-state、merger-role 有在役值导入；不是「src 都不读」。canonical-json 无读者，未恢复其存在性要求。

变异命令：每次只在 `package.json.files` 追加一个 `!<path>`，执行 `npx vitest run test/package/npm-identity-metadata.test.ts`，最后恢复原始字节。临时驱动 `/tmp/1237-r20-mutations.py` 和 `/tmp/1237-r20-evidence/` 仅作诊断记录，不纳入仓库测试。以下各路径分别运行，不是一次排除一组：

- souls/judge.md、souls/doctor-auditor.md、resources/collector-bot-handbook.md、resources/diarist-collect.md：各 1 failed / 2 passed，exit 1，材料路径缺失断言红。
- extensions/role-runtime.ts、src/doctor-contracts.ts、src/doctor-evidence.ts、src/navigator-attendance.ts、dist/navigator-attendance.js、dist/activation-ledger-topology.js、src/merger-contracts.ts、src/merger-git-state.ts、src/merger-role.ts：各 1 failed / 2 passed，exit 1，真实入口/导入解析失败。navigator dist 两个报错来自包内 role-runtime.js、role-runtime-dependencies.js 的真实导入边。
- CLAUDE.md：只追加负项时 3 passed，npm 仍保留 files 的显式正项，不能算缺件变异。去掉显式正项并追加负项后 1 failed / 2 passed，断言 `false !== true`，exit 1；日志 `CLAUDE-removed-positive.log`。
- src/canonical-json.ts、packets/fixer-repair.md：各 3 passed，exit 0，符合无运行时读者的删除边界；不为这两个名字造新守卫。
- bin.ak-role 指向不存在的 dist/nonexistent-bin.js：1 failed / 2 passed，MODULE_NOT_FOUND，exit 1。已有真实 bin 执行承接 #671；#682 固定拼写仍删。
- 旧逻辑对照：换回 c2c9175d 的旧测试并排除 souls/judge.md，3 passed；恢复新测试，同一排除 1 failed。复原 package.json 后 3 passed，2.82s。未把旧测试漏检说成红，也未用别的失败冒充变异证据。

### R21-B：排除 main 合入，不借他票删除凑账

修前两次执行 `python3 -I docs/research/issue-1237-deletion-ledger.py` 均为 COUNT 1427 / files 23 / MISMATCH ledger 1139。根因是两处 git diff 直接比较基线到混入 main 的 HEAD。两处统一使用 Git 原生 merge-tree 返回的本票树，边界、命令及后续 main 合入的处理要求见删除账账头（唯一统计口径）；未自造补丁回放、行号映射或五文件排除表。Git 冲突/失败仍由 check_output 原样报错。

官方资料先查：npm pack 的 JSON/file list（https://docs.npmjs.com/cli/v11/commands/npm-pack）、esbuild packages/external 与真实导入解析（https://esbuild.github.io/api/#packages）、Git merge-tree 的显式 merge-base（https://git-scm.com/docs/git-merge-tree）。生态已有件足够；本轮无新通用件。

核账复扫：`rg -n 'BASE|HEAD|git\("diff"' docs/research/issue-1237-deletion-ledger.py`。两处统计 diff 均用 ticket_tree；BASE 仍只负责冻结的删除坐标与原文读取，不是漏改的终点。提交前 HEAD=c2c9175d 时核账 COUNT/MATCH 1139，18 文件＋115 案＋1006 断言，未新增他票行。首提交 0a93f2a9 后重核暴露真实三方冲突：main 的 vitest/helper imports 迁移与本轮新增 imports 相邻，merge-tree exit 1。没有使用偏向合并、吞错或冻结旧终点来造 MATCH；仅把新增 imports 移到文件头，使两笔独立改动不重叠。修正暂存树实测 `git merge-tree --write-tree --merge-base=c2c9175d c2c9175d^1 "$(git write-tree)"` exit 0，树为 6bf15b6a25586105d1c654ae3bdc664f7dc9cc17。另建修正提交，最终 HEAD 再执行原核账命令；此前结果不冒作最终 HEAD 证据。

### 交卷自审

`git diff HEAD` 的四文件逐一打开。测试改名扩充而非另建平行案；diffItems 中 `packed runtime resolves its materials, modules and CLI bin` 对应起点文件 :134 的既有 bin 案，已并入。对照现有 `published-dist-import-closure.test.ts:69`：它不经 npm pack，不能检测 files 排除；复用 esbuild 而不复制 listJsFiles/assertRelativeImportClosure helper。无新增生产函数、测试 helper 或计数脚本函数。旧手抄表/无读者文件要求未复活。真实入口为 npm pack，断言面是产物路径字段与解析/执行结果；没有放松既有失败路径。本轮只作聚焦验证，不索取/运行全量：`npx vitest run test/package` 为 2 files / 4 tests passed，3.26s；`npx tsc --noEmit` exit 0；`git diff --check` 无输出。提交后仍须由调用方续送复审，不表示已合并收官。

## I22-A 续修：闭包检查与昂贵前置归并（起点 889a200a）

依据：调用者原样转来的 I22-A 判词。本轮续审处方明确纳入 published-dist-import-closure.test.ts；不将上轮遵守单文件范围本身记作违规。根因是只看「旧案抓不到新缺件」，漏看「新案已承接旧构建缺边」，未完成反向删并判断。

修法：旧案原生动态 import 原样迁到现有解包夹具，目标改为包内 dist/navigator-attendance.js；保留所有材料、内部入口、dist 依赖与 bin 检查。删除旧文件91行及其 listJsFiles/walk、assertRelativeImportClosure、独立 checkout/build。没有新测试、新 helper、第二次 pack、缓存或共享状态协议。真实 npm pack 的 prepack 已执行 npm run build（生产 package.json 与 packIsolatedPackage 的既有链路；官方说明 https://docs.npmjs.com/cli/v11/using-npm/scripts）。

核账连带修正：暂存该删除后，原核账算法因 main 曾迁移旧文件 imports，在重建本票树时触发 modify/delete。实测旧命令 exit 1；这是本次合法删除暴露的账工具缺口，不能删掉测试却让最终核账失败。账脚本复用 Git 私有索引，将合入后本票明确删除的路径也从 preintegration 树删除，再做原三方计算；不改真索引、不吞其余冲突、不建长期缓存，不手抄文件名单。统计边界与命令仍以账头为唯一真源；官方 git-update-index/GIT_INDEX_FILE 文档已查，仓内 rg 未找到可复用私有索引封装，直接用 Git 命令与 Python TemporaryDirectory，不另造通用件。

扫类命令：`rg -n 'packIsolatedPackage|npm.*run.*build|assertRelativeImportClosure|listJsFiles|navigator-attendance\.js' test/package test/helpers/environment-fixtures.ts`。打开两份 package 测试、既有 materializePackageTree/packIsolatedPackage、package.json 的 build/prepack 与基线旧案；扫描后确认只有这两条链重叠。本轮为删并类，下表按 `git diff --name-status 889a200a` 逐文件记录；修后同命令重列、同搜索复扫，无第二套 package build/闭包链。

| 文件 | 命中与处置 |
| --- | --- |
| test/package/npm-identity-metadata.test.ts | 已修；:150 的真实包闭包保留，:165 接入旧独有原生加载；不新增案。 |
| test/package/published-dist-import-closure.test.ts | 已修；起点 :20 的枚举 helper、:51 的闭包 helper、:69 的独立构建案全部删除；原 :86–88 加载已迁移。 |
| docs/research/issue-1237-deletion-ledger.py | 无重复测试；比对 git、两处 diff 与 merge-tree：仅为本次整文件删除修正账工具，私有索引代码无仓内现成封装，不复制构建/测试机制。 |
| docs/research/issue-1237-deletion-ledger.md | 已修；账头说明删除的统计行为，新增 #1141–#1143，1142行=19文件+116案+1007断言，a/D599、改好48。 |
| docs/research/issue-1237-test-quality-sweep.md | 已修；原「留」行改「删并」，总数相应变为改67/删18/留52；独有加载与旧闭包重叠不再混作两套前置的理由。 |

变异均在真实 `npx vitest run test/package` 上各自运行，结果各为 1 failed / 2 passed、exit 1，最后逐字恢复 package.json/scripts/build-package.mjs（git diff 两文件为空）：

- 构建结束后向 dist/activation-ledger-topology.js 加缺失相对导入：esbuild 对 missing-1237-i22.js 报 unresolved import（2.91s）。
- 构建结束后向 dist/navigator-attendance.js 加求值 throw：闭包解析通过，新增的真实动态 import 报 1237-i22-native-load（2.77s），证明没有用静态解析冒充原生加载。
- 构建结束后删除整个 dist：真实动态 import 报模块缺失（2.75s），承接旧 files.length>0 的必要失败输入，不恢复弱计数。
- npm files 排除 souls/judge.md：材料路径断言报红（2.46s），未反向撤掉 R21-A 缺件守护。

临时诊断脚本 `/tmp/1237-i22-mutations.py`、日志 `/tmp/1237-i22-evidence/` 不入仓库。首次合并聚焦 3/3 绿3.18s，前三项变异复原后 3/3 绿3.01s；最终聚焦、tsc、提交后原核账命令结果随本轮回执，不索全量。diffItems=[]：无新增测试/生产函数；修改的 git 函数复用原封装，只让既有调用可指定私有索引环境与 stdin。原材料与模块/进程断言不放松，旧整套前置已删除。原有 node-test-report.txt 不改不删；不 amend/rewrite/push，不派角色。

## 第二十一轮：R22-A 文档引用同步（起点 93629c0e）

裁决真源：本票 `runs/01a16876-ad7d-7a18-8be1-8e4ac923c070@judge/receipts/1.json`；R21-A、R21-B、I22-A 的结清与合入 main 复审结论均以该卷为准。本轮只处置其 R22-A remedy，不重写此前历史记录或删除账。

错误形状：测试文件删除或并入后，现行文档的运行命令仍指向旧路径。修前按本票基线到 HEAD 的全部 24 个已删测试/helper 路径扫描现行引用（含 main 合入带来的删除，不缩窄到点名文件）：

```bash
git diff --diff-filter=D --name-only 7997ffb2 HEAD -- test | while IFS= read -r path; do git grep -n -F -- "$path" . ':!docs/research/**' ':!docs/adr/**'; result=$?; if [ "$result" -gt 1 ]; then exit "$result"; fi; done
```

唯一命中 `README.md:148`，已将 package focused run 示例改到现存 `test/package/npm-identity-metadata.test.ts`。同命令复扫零命中；`git grep -n published-dist-import-closure -- . ':!docs/research/**' ':!docs/adr/**'` 亦无输出、exit 1。历史研究/ADR 中的路径引用原样保留。

验证：旧示例 `pnpm exec vitest run --project package test/package/published-dist-import-closure.test.ts` 实跑 exit 1（No test files found）；新示例 `pnpm exec vitest run --project package test/package/npm-identity-metadata.test.ts` 实跑 1 file / 3 tests passed，3.00s，exit 0。Vitest 官方 filtering 文档（https://vitest.dev/guide/filtering.html）确认位置参数按路径过滤；无需新增检查机制或测试。

自审：本轮仅 README 一行替换与本节追加，diffItems=[]；无新增生产/测试函数、无断言变动，失效示例已替换。未跑全量，未改配置、生产、Soul 或治理文件；原有未跟踪 `node-test-report.txt` 保留。R22-A 已修，待大理寺亲验；不表示整票已合并收官。

## I23-A/B 续修（起点 876d710a）

依据：本票 `runs/01a16889-5390-73b3-9596-8787119e2c55@inspector/receipts/1.json`，由调用者原样递送。R22-A 的正确 README 示例保留；本轮不改生产、Soul、治理或真席位配置，不另造测试或统计器。

### I23-A：先限定取数范围，不为冲突文件增例外

修前原命令 `python3 -I docs/research/issue-1237-deletion-ledger.py` 在 merge-tree exit 1、尚无 COUNT。展开同一 Git 调用，唯一冲突 README.md；把 HEAD 换为父提交 93629c0e 则成功，`git diff 93629c0e HEAD -- test` 为空，最小故障差异就是无关文档。

根因是只消费 test 的统计却先合并全树。修后沿用原 Git 私有索引、删除处理和 merge-tree，仅把三方输入限定为 test 子树；mktree 恢复账本需要的 test/ 前缀。算法的唯一现行说明在删除账账头。没有 README 例外名单、冲突偏向、吞错或新增函数。官方 git-merge-tree 文档明确显式 merge-base 可直接接受 tree；git-diff 的 --relative 与 git-mktree 的标准树输入直接复用，不自造路径映射或合并器。

同形状全仓检索：`git grep -n -E 'merge-tree|read-tree|write-tree|mktree' 876d710a -- '*.py' '*.mjs' '*.ts'`；修后去掉冻结 ref 重跑。全部命中均在既有核账脚本：:30 read-tree 已限子树，:34 write-tree 输出私有索引子树，:36 merge-tree 三方都限子树；修后新增命中 :40 是 Git 原生 mktree 恢复前缀，不是第二统计实现。

差分验证：`git merge-tree --write-tree --merge-base=c2c9175d:test 4895dc17622e1ad3fc17ba2d23da1217c847926e:test HEAD:test` 与父提交旧算法成功树的 test 子树均为 `33596910db5dd6454004d51ede4151da18627453`。在当前仓通过 `git show 876d710a:docs/research/issue-1237-deletion-ledger.py` 读取旧脚本并原样 exec，仍 exit 1；新原入口 COUNT/MATCH 1142，files19/cases116/asserts1007。这项提交前结果针对起点 HEAD；提交后须再次用原入口核对新 HEAD，不将它冒称提交后证据。

### I23-B：删除已有承接者的第二套 auditor 前置

修前逐项比对 engine 文件 :105–130 与公开入口 :368–458、inspectLiveRequest :118–139，以及生产 loadRegisteredRoleSoul :31–35；均为 subject=judge 的同一装载与字节递送。删独立 auditor run、环境修改、envelope 及唯一断言26行，并去掉首案不用的 home 绑定，不动 engine 与 Judge 观察。账 #628 转为公开入口承接 b，b62→63、改好48→47；基线 where 与总数不变，不为已计过的迁入断言另造账行。

横扫 `rg -n 'AK_ROLE_AUDITOR_SUBJECT|judge-auditor\.md|loadRegisteredRoleSoul' test`，修前命中三文件；修后 engine 文件零命中。逐项打开其余两文件：audited-run-identity-1166 的 :100/:107/:163/:164 是共享真实公开请求的前后环境，保留；public-cli-resume 的 :1704/:1705/:2030/:2032/:2044/:2045 是恢复派发的 subject 环境边界，没有再装一个 envelope 验 Soul，非本类。

本轮 `git diff --name-status 876d710a` 的删并逐文件表（修前打开相关文件、修后重列比对）：

| 文件 | 命中与结果 |
| --- | --- |
| test/integration/role-envelope-engine-axis.test.ts | 已修；起点 :105–130 的重复前置删除；:67 无用 home 绑定删除。与公开入口承接者比对，保留其余独有观察。 |
| docs/research/issue-1237-deletion-ledger.md | 已修；:976 账 #628 的承接改指既有公开入口，不保第二套装配；账头仅同步 I23-A。 |
| docs/research/issue-1237-deletion-ledger.py | 无；对照既有 git 封装和两处 diff 消费，仅收窄取树范围；没有 envelope 或平行统计入口。 |
| docs/research/issue-1237-test-quality-sweep.md | 已修；:151 逐文件行及本节记载删并，历史变异事实保留，不再声称应保留独立 auditor 前置。 |

聚焦命令：`pnpm exec vitest run --project integration test/integration/role-envelope-engine-axis.test.ts test/integration/audited-run-identity-1166.test.ts -t 'shared envelope registers engine detour|#1166 direct notary/auditor public entry'`，修前2过/6跳，1.14s；修后2过/6跳，1.03s。另在自建隔离工作树直接调用已安装 Vitest CLI，只把 loadRegisteredRoleSoul 的 auditor 分支临时改为错误 Soul：旧前置在时2败（1.12s）；应用本轮删除后1过1败，公开入口仍在 :446 因 :137 的 Soul 检查报红（760ms）；恢复生产字节后2过（764ms）。印证并保留台院原卷红绿事实，没有新增证明案。

失败诚实：扩到两个整文件的首次运行7过1败（1.55s），未改动的 #1092 案清理 `.ak-roles` 时 ENOTEMPTY。隔离起点单跑该案1过，两个整文件连续三次8过；本树随后重跑两个整文件8过（1.28s）。未能稳定复现该清理失败，未定其根因，也不把重跑绿当成已修复；原失败在此保留。没有为压绿改该案、加等待/重试或放松断言。

自审：diffItems=[]，无新增测试/生产函数，原 helper 无新增孤儿；断言只删已被公开入口承接的一项，其他输入与失败观察未放松。`pnpm exec tsc --noEmit` exit 0。隔离生产变异逐字恢复、本席临时测试补丁反向应用后工作树干净，移除 node_modules 软链再正常移除该工作树；无生产变异残留。不跑全量、不改原有 node-test-report.txt、不 amend/rewrite/push、不派角色；交卷后由调用者续送复审。

## 第二十二轮：R23-A 临时 home 清理与非阻塞 navigator 写入（起点 d7ba2411）

裁决真源：本票 `runs/01a16876-ad7d-7a18-8be1-8e4ac923c070@judge/receipts/3.json`。错误形状：测试装入会在后台写 ledger 的 navigator，误把 envelope.dispose 返回当作所有写入结束，随后删除 home。本轮只修测试装配、专项案清理及本账；不改 #959 生产契约、Soul、质量法、治理或宿主配置。

### 搜索边界与逐命中复扫

先查 Node 官方 `https://nodejs.org/api/fs.html` 关于异步文件操作不保证并发同步的说明，再读 `src/role-runtime.ts:1005–1039,1328–1333,1579–1629`、`src/navigator-attendance.ts`、`src/navigator-lookup.ts` 和 ADR 0082 的 lookup 管线修订。选择不启动无关写入，而非 fs.rm 重试或等待补丁。

实际扫描命令（修后重跑；临时原始输出 `/tmp/1237-r22-{scan,scan-after,entry-scan,entry-scan-after,imports,consumers,production-roots}.txt`）：

```sh
rg -n 'createRoleRuntimeDependencies|createNavigatorAttendance|\.dispose\(|\brm\(|rmSync\(' test --glob '*.ts'
rg -n 'createRoleRuntimeDependencies|createNavigatorAttendance|prepareRoleEnvelope|createRoleRuntime\(|createProductionRoleTurnHost' --glob '*.ts' --glob '!src/**' --glob '!dist/**' --glob '!node_modules/**'
rg -n 'role-runtime-dependencies|navigator-attendance|navigator-lookup|role-envelope|extensions/role-runtime|createHeadlessRoleTurnHost|createAcpRoleTurnHost' test scripts --glob '*.ts' --glob '*.mjs'
rg -n 'capturePreparedEnvelope|roleTurnHostFromStructuredOutputRounds' test --glob '*.ts'
rg -n 'createRoleRuntimeDependencies|createNavigatorAttendance|prepareRoleEnvelope|roleRuntimeDependenciesWithoutNavigator' src extensions --glob '*.ts'
```

本轮初次扫描覆盖直接 attendance 构造和 envelope/helper 入口，但漏了默认 host 延迟装配。复审撤销原「headless/ACP 其余测试均在 prepare 注入返回值，没有生产 envelope」判断：public-cli-host-axis 与 public-cli-session-missing-fresh-summons 会间接进入生产 envelope，补修见文末。辅助扫描里的普通 rm 不等于 navigator 写口；Pi legacy runner 接缝不加载真实 extension。extensions 与生产 composition roots 没有被改写。

第二十三轮更正：下表 navigator 专项三行的「已修」只说明当时的清理观察，不再作为合法装配结论；R24-A 已证明它旁路生产。lifecycle 三行当时按清理竞态判不同类，不豁免其本轮发现的装配旁路。最终处置见第二十三轮。

下表仅是直接依赖装配层的逐命中账，不证明默认 host 调用链已扫净；坐标冻结在该次提交3497bab8。冻结起点命令 `git grep -n -E 'createRoleRuntimeDependencies\(|createNavigatorAttendance[:(]' d7ba2411 -- test` 为 36 行；复扫命令 `rg -n '(createRoleRuntimeDependencies|roleRuntimeDependenciesWithoutNavigator)\(|createNavigatorAttendance[:(]' test --glob '*.ts'` 为 38 行（多两行是共享装配声明及其生产调用）。坐标为起点→修后，未移动以同号记；一处命中一行。所有「已修」保留原请求输入、断言和失败路径。

| 命中（起点 path:line） | 修后行 | 结果 |
| --- | --- | --- |
| test/contract/durable-session-write-failure.test.ts:37 | 37 | 不同类：staged attendance 自己先 await onEvent，不启动 lookup。 |
| test/contract/durable-session-write-failure.test.ts:127 | 127 | 不同类：请求 stationChild=true。 |
| test/contract/durable-session-write-failure.test.ts:165 | 165 | 不同类：请求 stationChild=true。 |
| test/contract/durable-session-write-failure.test.ts:222 | 222 | 不同类：withStagedShutdownAttendance 替换生产 attendance。 |
| test/contract/navigator-attendance-lifecycle.test.ts:52 | 52 | 不同类：受控回调，无 lookup 写 home。 |
| test/contract/navigator-attendance-lifecycle.test.ts:168 | 168 | 不同类：只观察 created，无 lookup。 |
| test/contract/navigator-attendance-lifecycle.test.ts:395 | 395 | 不同类：注入受控 summon，abort 后只拒绝 promise，不落 navigator 卷。 |
| test/contract/navigator-attendance-lifecycle.test.ts:396 | 396 | 不同类：同一受控 summon，不含生产写口。 |
| test/contract/navigator-attendance.test.ts:20 | 20 | 不同类：传入内存 lookup；无临时 home/真实 summons。 |
| test/contract/role-envelope-tool-error.test.ts:62 | 62 | 不同类：stationChild=true。 |
| test/contract/role-envelope-tool-error.test.ts:91 | 91 | 不同类：stationChild=true。 |
| test/contract/role-envelope-tool-error.test.ts:153 | 153 | 不同类：stationChild=true。 |
| test/contract/role-envelope-tool-error.test.ts:302 | 302 | 不同类：stationChild=true。 |
| test/helpers/role-turn-host-fixture.ts:47 | 54 | 已修：capturePreparedEnvelope 不接生产 attendance。 |
| test/helpers/role-turn-host-fixture.ts:98 | 105 | 已修：structured-output rounds 不接生产 attendance，含提前抛错分支。 |
| test/integration/audited-run-identity-1166.test.ts:116 | 116 | 已修：保生产 Soul/reference loaders，不接 attendance。 |
| test/integration/public-cli-1132-delivery-request.test.ts:400 | 400 | 已修：催交/无卷 closeRound 不接 attendance。 |
| test/integration/public-cli-cli.test.ts:308 | 308 | 已修：schema 启动观察不接 attendance。 |
| test/integration/public-cli-engine-resume-detour.test.ts:223 | 223 | 已修：engine 材料启动观察不接 attendance。 |
| test/integration/public-cli-escalation-resume.test.ts:113 | 113 | 已修：判卷提交/恢复不接 attendance。 |
| test/integration/public-cli-navigator-attendance.test.ts:126 | 127 | 已修：依赖表的生产 attendance 被下方真实受观察 lookup 替换。 |
| test/integration/public-cli-navigator-attendance.test.ts:129 | 130 | 已修：按每次 attendance 持有 public summon 完成观察；plan 无 lookup 不等。 |
| test/integration/public-cli-navigator-attendance.test.ts:132 | 137 | 已修：成功和文件系统失败共用同一真实 lookup；dispose 后、删除 home 前等 public summon 返回或抛错，父宿主失败也走 finally。 |
| test/integration/public-cli-report-ticket.test.ts:138 | 138 | 已修：认票/仅 report 分支不接 attendance。 |
| test/integration/public-cli-report-ticket.test.ts:1002 | 1002 | 已修：同 envelope 催交不接 attendance。 |
| test/integration/public-cli-same-ticket-resume.test.ts:1098 | 1098 | 已修：工人退回恢复不接 attendance。 |
| test/integration/public-cli-secretariat-run.test.ts:368 | 368 | 已修：真实工具提交装配不接 attendance。 |
| test/integration/public-cli-secretariat-run.test.ts:974 | 974 | 已修：adapter 失败/重交装配不接 attendance。 |
| test/integration/report-ticket-adapter-exit-copy.test.ts:221 | 221 | 已修：ACP 认票不接 attendance。 |
| test/integration/report-ticket-adapter-exit-copy.test.ts:323 | 323 | 已修：headless 认票不接 attendance。 |
| test/integration/report-ticket-adapter-exit-copy.test.ts:483 | 483 | 已修：ACP 恢复不接 attendance。 |
| test/integration/report-ticket-adapter-exit-copy.test.ts:590 | 590 | 已修：Codex exit-copy 不接 attendance。 |
| test/integration/role-envelope-engine-axis.test.ts:74 | 74 | 不同类：原 withEnvelopeHome 的 stationChild=true 已隔离；现随文件导入统一省略 attendance。 |
| test/integration/role-envelope-engine-axis.test.ts:119 | 119 | 不同类：原同一 stationChild 请求；现随文件导入统一省略 attendance。 |
| test/integration/role-envelope-engine-axis.test.ts:176 | 176 | 不同类：原 mkRequest 的 stationChild=true；现随文件导入统一省略 attendance。 |
| test/integration/role-envelope-engine-axis.test.ts:268 | 268 | 已修：判词 #1092 样本，不接 attendance；不改请求成 stationChild。 |
| test/helpers/role-turn-host-fixture.ts（本轮新增声明） | 37 | 已修：roleRuntimeDependenciesWithoutNavigator，唯一省略可选依赖的共享装配。 |
| test/helpers/role-turn-host-fixture.ts（本轮新增生产调用） | 38 | 已修：调用原生产构造器，只 delete 可选 attendance，不复制 loader 表。 |

共享接缝的调用者也查完：`capturePreparedEnvelope` 的 `public-cli-1169-relocate-resume-no-unbound-paths.test.ts:169,181` 与 `public-cli-engine-startup-material.test.ts:96,112,125,144,205`；structured-output 的 `public-cli-main-flow-p0.test.ts:99`、`public-cli-coder.test.ts:55`、`public-cli-collector.test.ts:59`、`public-cli-diarist-run.test.ts:958`、`public-cli-gleaner-left-run.test.ts:104`。各案均非 navigator 专项，统一由 helper 修净，不逐案复制开关或另造证明测试。

### 验证与失败留痕

- 修前 Python subprocess 连续 8 次执行 `pnpm exec vitest run test/integration/role-envelope-engine-axis.test.ts test/integration/audited-run-identity-1166.test.ts`：8 次 exit0，ENOTEMPTY 0，但 8 次各产生一个新的泄漏 home（不是 8 个 navigator run），合计 13.00s；每轮按系统 tmpdir 的新 `ak-1092-envelope-no-dossier-*` 下 `*@navigator` 检出。原始行与路径 `/tmp/1237-r22-evidence/before.json`、`before-{1..8}.log`。不是用重跑绿洗白。
- navigator 专项修前 10/10，2.02s；仍按形状修父宿主失败的非阻塞清理，不以这次绿排除竞态。
- 首实现聚焦 18/18；tsc 报 exactOptionalPropertyTypes 不收显式 undefined、当前 lib 无 Promise.withResolvers。改用 delete 可选依赖和原生 Promise；未改生产类型、tsconfig 或引入库，`tsc-final.log` exit0。
- 修后同一双文件并跑再带 `public-cli-navigator-attendance.test.ts`，Python subprocess 连续 20 次，每次 18/18；20 次 exit0，ENOTEMPTY 0、新增 navigator 残留 0，墙钟 54.53s。观测范围是系统 tmpdir、/tmp、工作树下本轮新增 ak-* / .test-tmp-* home；旧席残留不计、不动。逐轮 `/tmp/1237-r22-evidence/after.json`、`after-{1..20}.log`。
- 聚焦覆盖所有改动测试、共享 helper 七个消费者文件、两个判词候选排除文件及两个 attendance 契约文件：`focused.json` 保存完整 `pnpm exec vitest run` 的 22 文件参数。160/160，runner 10.75s（subprocess 墙钟11.39s），ENOTEMPTY 0、新增 navigator 残留 0；不跑全量。
- 最终 import 接缝整理后，再跑同一20轮负载与22文件聚焦：20轮均18/18、ENOTEMPTY 0、新增 navigator 残留0，58.44s（`final-after.json`、`final-after-{1..20}.log`）；聚焦160/160，runner10.62s、墙钟11.03s（`final-focused.json/.log`）；tsc exit0。本席修前及变异生成的9个泄漏 home 经记录路径逐个清理，修前8个共16个 navigator run、变异1个含2个 run；只删本席产物，不碰他席旧残留。
- 变异：临时删去共享装配里的 `delete dependencies.createNavigatorAttendance`，原双文件入口 1.95s exit1，ENOTEMPTY 1、泄漏 home 1；外部目录观察也报红。恢复该行，同命令 1.89s exit0、ENOTEMPTY 0、零新增泄漏。`mutation.json/.log` 与 `restored.json/.log`。未新增竞态证明测试，未改生产源码。

### 自审与核账

从 `git diff HEAD` 逐项自审：新增测试函数0、生产函数0；另如实列出唯一新增测试 helper `roleRuntimeDependenciesWithoutNavigator`（test/helpers/role-turn-host-fixture.ts:37）。`rg -n 'deferred|withResolvers|createNavigatorAttendance.*undefined|delete .*createNavigatorAttendance|WithoutNavigator|withoutNavigator' test src` 未找到已有省略生产 attendance 的通用测试装配；原生产构造器 src/role-runtime-dependencies.ts:39 仍被直接复用，不复制其规则。新增 helper 必要性是把20处调用（含 engine 文件原本已 stationChild 隔离的3处）的省略策略放在一个地方，而非复制20份 delete/解构。它不是新生产钩子、重试或等待机制。

入口仍是原有公开 CLI/envelope；断言未增删、未放松，所有失败分支保留。navigator 专项复用原 summon 注入接缝；原两套 success/failure attendance 装配已合并，真正的文件系统故障仍在。不新增 sleep、fs.rm maxRetries、墙钟上限或持久数据。删除账无新删断言/整案/整文件项，不改其统计法和 MAIN_MERGE 边界。暂存树核账首轮 merge-tree 因 main 曾整块重缩进产生5文件冲突（`accounting-conflict.txt`），不是代码运行失败；改为在10个非专项文件的原 import 行显式导入 `roleRuntimeDependenciesWithoutNavigator as createRoleRuntimeDependencies`，保留调用体，避免为仅依赖装配变更改写历史重缩进块。实际调用仍是同一个省略 helper，没有放回生产 attendance。暂存树5169b311预核 COUNT/MATCH1142（files19/cases116/asserts1007）；不改脚本、不偏向合并、不吞冲突。提交后执行原 `python3 -I docs/research/issue-1237-deletion-ledger.py` 核最终 HEAD，结果随回执。原有 `node-test-report.txt` 已打开核对、未改未删；不 amend/rewrite/push、不派角色。本轮修理交卷待复审，不声称整票已合并。

## 第二十二轮复审补修：R23-A 默认 host 间接装配（起点 3497bab8）

复审明确的四处遗漏成立；R22-A、I23-A、I23-B 不重开。错误形状仍是「父调用结束后删 home，但非阻塞 lookup 可以继续写」，不是生产 dispose 契约错误。漏扫原因是只统计测试里的构造器拼写，没有把默认 composition root 反向追到公开入口。

### 修法与边界

链路逐层核对：`runAkRole` → `openRoleSeatRuntime` → `composeRoleTurnHostAdapters`（src/public-cli/role-turn-host-resolution.ts:54–81）→ `createLazyProductionExternalHost` → 两个 `loadProduction*HostFactory` → ACP :68 / headless :40 的生产依赖 → runtime :1579–1629 的 attendance。延迟加载器优先 dist，缺失才用 src；因此只 mock 源码构造器会漏掉本机已有 bundle。

查官方 `https://vitest.dev/guide/mocking/modules` 后，使用 Vitest 现成模块替换：新增共享测试装配 `test/helpers/production-host-without-navigator.ts`，两个测试文件各导入一次。默认 host 表、host 选择、延迟加载器、真实生产 factory、真实 adapter/二进制协议、envelope 和原断言都保留；只将本地 dist 的两个 factory 模块指向同一份真实 src factory，让共享可选依赖省略策略作用于唯一源码模块。不是 fake host，也不在生产加测试钩子；打包产物本身仍由原 package 测试负责，不以这两个源码行为案代替发布验收。

`roleRuntimeDependenciesWithoutNavigator` 复用原生产构造器，并接受模块替换取到的原 factory，避免递归调用已替换导出。唯一的 delete 仍在原 helper :42；没有复制 loader 表或两份省略策略。测试模块替换只在显式导入的两文件生效，navigator 专项不导入；同一聚焦批次实际复跑专项通过。不能把模块替换放进通用 role-turn-host-fixture：navigator 专项及 lifecycle 契约也导入它（:33/:28），会误隔离被测的真实 attendance；因此单独显式导入。新增测试函数0、生产源码改动0；不加 sleep、rm 重试、超时、后台等待管理器或新生产接口。

### 反向扫类、逐命中账与复扫

实际命令（输出 `/tmp/1237-r23-{roots-baseline,roots-after,composition,entry-details,entry-rescan,process-roots,production-after,direct-after,low-level}.txt`）：

```sh
git grep -n -E 'public-cli/(cli\.ts|role-seat-runtime|role-turn-host-resolution|load-production)|public-role-summons|acp-host/production-host|headless-host/production-host|productionBase\(|callEnv\(' 3497bab8 -- test
rg -n 'public-cli/(cli\.ts|role-seat-runtime|role-turn-host-resolution|load-production)|public-role-summons|acp-host/production-host|headless-host/production-host|productionBase\(|callEnv\(' test --glob '*.{ts,mjs}' | sort
rg -n 'createRoleRuntimeDependencies|createProduction(Acp|Headless)RoleTurnHost|createLazyProductionExternalHost|composeRoleTurnHostAdapters' src test
rg -n 'role-envelope|role-runtime-dependencies|load-production|public-cli/cli\.ts|public-role-summons' test scripts --glob '*.{ts,mjs,cjs}'
rg -n 'spawn|execFile|fork|dist/public-cli|bin/ak-role' test --glob '*.{ts,mjs}'
rg -n 'createRoleRuntimeDependencies|createNavigatorAttendance|prepareRoleEnvelope|roleRuntimeDependenciesWithoutNavigator' src extensions --glob '*.ts'
rg -n '(createRoleRuntimeDependencies|roleRuntimeDependenciesWithoutNavigator)\(|createNavigatorAttendance[:(]' test --glob '*.ts'
rg -n 'prepare:' test/integration test/unit -g 'host-session*.test.ts' -g 'host-retry-verdict-relay.test.ts' -g 'resume-missing-host-session-id.test.ts' -g 'headless-codex-host.test.ts'
```

主命中表起点94行、修后96行（新夹具两个 source factory 指向），下表逐行记结果，坐标为修后；两被修文件原坐标减1即起点。导入行的判断沿该文件所有调用者继续追入 env/helper，不用导入文字本身证明没有写口。直接装配层仍复用上一节逐项账：原 helper 生产调用改名为 `createDependencies(root)`（:41），原两个 envelope 调用移到 :57/:108，新增模块回调 :15 也委托同一个 helper；其余直接入口未变化。

| 命中 path:line | 复扫结果 |
| --- | --- |
| test/contract/analyst-412-library-index-book-scope.test.ts:24 | 不同类：:165/:220 为 analyst cohort，同步分析入口，不入 role host。 |
| test/contract/durable-session-write-failure.test.ts:26 | 不同类：:244 显式 host 表，staged attendance 无 lookup；直接装配见上节。 |
| test/contract/navigator-attendance-lifecycle.test.ts:112 | 不同类：config set；其余 runtime 的受控 lookup 无生产写口。 |
| test/helpers/passing-review-host.ts:4 | 不同类：:40/:47 只 config set/set-engine；review host 为脚本 runner。 |
| test/helpers/production-host-without-navigator.ts:7 | 已修：dist ACP 指向真实 source factory，不替换默认表或 adapter。 |
| test/helpers/production-host-without-navigator.ts:8 | 已修：dist headless 指向真实 source factory，共用依赖省略接缝。 |
| test/integration/analyst-399-book-scope.test.ts:21 | 不同类：analyst 书域分析，不入 role host。 |
| test/integration/analyst-compute-if-missing.test.ts:29 | 不同类：:191/:357 cohort 本地计算/写失败，不入 role host。 |
| test/integration/analyst-public-cli-sweep.test.ts:19 | 不同类：:66 sweep 与负向输入均走 analyst，不入 role host。 |
| test/integration/analyst-public-cli.test.ts:20 | 不同类：analyst 分析/查询，不入 role host。 |
| test/integration/audited-run-identity-1166.test.ts:30 | 不同类：前轮已在 parentGateHost 省略 attendance，其余为 minimal host。 |
| test/integration/engine-detour-usage-ledger.test.ts:31 | 不同类：:265/:577/:680 等显式 reviewReadyHost/adapter；无默认外部 host。 |
| test/integration/fixtures/process-cancel-driver.mjs:26 | 不同类：:118 注入 hangingHost，受控子进程无 envelope。 |
| test/integration/package-home-cli-seam.test.ts:12 | 不同类：:24 仅 roles。 |
| test/integration/package-home-cli-seam.test.ts:15 | 不同类：子进程仅 help/roles，不执行角色。 |
| test/integration/pipeline-lifecycle-formalization.test.ts:10 | 不同类：:83 注入 withPassingReviewHost(fauxHost)。 |
| test/integration/public-cli-1132-delivery-request.test.ts:35 | 不同类：显式 hostAdapters；真实 envelope 前轮已省略 attendance。 |
| test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts:20 | 不同类：显式 host，capturePreparedEnvelope 已省略 attendance。 |
| test/integration/public-cli-attach-path-passthrough.test.ts:15 | 不同类：:77/:175 脚本 Pi runner。 |
| test/integration/public-cli-auto-resume-limit-422.test.ts:17 | 不同类：角色调用显式脚本 runner；其余 config。 |
| test/integration/public-cli-bin-startup.test.ts:9 | 不同类：源码 config；子进程 config/help/roles，无角色回合。 |
| test/integration/public-cli-cli.test.ts:23 | 不同类：minimal/脚本 host；:308 envelope 前轮已隔离。 |
| test/integration/public-cli-coder.test.ts:31 | 不同类：structured-output helper 已隔离，其余 minimal/脚本 host。 |
| test/integration/public-cli-collector.test.ts:13 | 不同类：:59 structured-output helper 已隔离。 |
| test/integration/public-cli-config.test.ts:10 | 不同类：:47 显式 host，其余配置处理。 |
| test/integration/public-cli-countersign-run.test.ts:23 | 不同类：脚本 host/显式 adapter；无默认生产 envelope。 |
| test/integration/public-cli-diarist-run.test.ts:29 | 不同类：structured-output helper 已隔离；其余脚本 host/dialogue。 |
| test/integration/public-cli-doctor.test.ts:32 | 不同类：minimal/脚本/withPassingReviewHost；无默认外部 host。 |
| test/integration/public-cli-engine-axis.test.ts:26 | 不同类：有效角色请求显式 runner；未注入的 :450 等在配置/语法受理阶段退出。 |
| test/integration/public-cli-engine-resume-detour.test.ts:40 | 不同类：显式 host；材料 envelope 前轮已隔离。 |
| test/integration/public-cli-engine-startup-material.test.ts:17 | 不同类：显式 host/adapter，capturePreparedEnvelope 已隔离。 |
| test/integration/public-cli-escalation-resume.test.ts:14 | 不同类：显式 routed adapter，真实 envelope 前轮已隔离。 |
| test/integration/public-cli-failure-artifacts.test.ts:21 | 不同类：角色调用全用脚本 runner。 |
| test/integration/public-cli-failure-provider-stop.test.ts:11 | 不同类：角色调用全用脚本 runner。 |
| test/integration/public-cli-failure-real-entry.test.ts:24 | 不同类：显式拒绝 host/脚本 runner，无默认外部 host。 |
| test/integration/public-cli-failure-settlement.test.ts:22 | 不同类：脚本 runner，不加载 extension。 |
| test/integration/public-cli-fixer.test.ts:21 | 不同类：脚本 runner；其余配置。 |
| test/integration/public-cli-gleaner-left-run.test.ts:14 | 不同类：structured-output helper 已隔离，其余脚本 runner。 |
| test/integration/public-cli-host-axis.test.ts:20 | 已修：默认 host 调用沿下列逐项装配；其他分支保显式 adapter。 |
| test/integration/public-cli-host-axis.test.ts:467 | 不同类：config set。 |
| test/integration/public-cli-host-axis.test.ts:470 | 不同类：默认 Pi 是显式 countingPi。 |
| test/integration/public-cli-host-axis.test.ts:476 | 不同类：显式 Pi 是 countingPi。 |
| test/integration/public-cli-host-axis.test.ts:481 | 不同类：未知 host 在执行前拒绝。 |
| test/integration/public-cli-host-axis.test.ts:651 | 已修：判词 public grok 失败回合，默认 ACP 依赖省略 attendance。 |
| test/integration/public-cli-host-axis.test.ts:792 | 不同类：config set-auto-resume-limit。 |
| test/integration/public-cli-host-axis.test.ts:826 | 不同类：config set。 |
| test/integration/public-cli-host-axis.test.ts:827 | 不同类：config set-host。 |
| test/integration/public-cli-host-axis.test.ts:830 | 已修：默认 Grok 初始回合统一省略无关 attendance。 |
| test/integration/public-cli-host-axis.test.ts:848 | 已修：同 host resume 统一省略无关 attendance。 |
| test/integration/public-cli-host-axis.test.ts:872 | 已修：判词 #822 rejected set_model 的独立 lookup 不再启动。 |
| test/integration/public-cli-host-axis.test.ts:908 | 不同类：config set。 |
| test/integration/public-cli-host-axis.test.ts:909 | 不同类：config set-host。 |
| test/integration/public-cli-host-axis.test.ts:912 | 已修：默认 Hermes 回合统一省略无关 attendance。 |
| test/integration/public-cli-host-axis.test.ts:952 | 不同类：config set。 |
| test/integration/public-cli-host-axis.test.ts:953 | 不同类：config set-host。 |
| test/integration/public-cli-host-axis.test.ts:955 | 已修：默认 Claude 回合统一省略无关 attendance。 |
| test/integration/public-cli-instruction-seat.test.ts:23 | 不同类：:82 脚本 runner。 |
| test/integration/public-cli-judge.test.ts:26 | 不同类：角色调用均为脚本 runner。 |
| test/integration/public-cli-known-ticket-placement.test.ts:19 | 不同类：:56 显式 host。 |
| test/integration/public-cli-main-flow-p0.test.ts:18 | 不同类：显式 host，structured-output helper 前轮已隔离。 |
| test/integration/public-cli-merger-run.test.ts:19 | 不同类：显式 typed host/withPassingReviewHost。 |
| test/integration/public-cli-merger.test.ts:22 | 不同类：脚本 runner，不加载 extension。 |
| test/integration/public-cli-navigator-attendance.test.ts:109 | 不同类：config；该专项真实 lookup 的结束观察前轮已补。 |
| test/integration/public-cli-navigator-attendance.test.ts:142 | 不同类：真实 summon 在 dispose 后、rm 前被观察结束；本轮不 mock 专项。 |
| test/integration/public-cli-navigator-lookup.test.ts:15 | 不同类：navigator 自身的 lookup host，无递归 attendance。 |
| test/integration/public-cli-notary.test.ts:28 | 不同类：有效请求 minimal/脚本 host；未注入项为非法参数/locator、受理前退出。 |
| test/integration/public-cli-resume-416.test.ts:26 | 不同类：嵌套 summon 显式 roleTurnHost，脚本/minimal host。 |
| test/integration/public-cli-resume-416.test.ts:33 | 不同类：角色回合显式 runner/adapter。 |
| test/integration/public-cli-resume-416.test.ts:56 | 不同类：config set-auto-resume-limit。 |
| test/integration/public-cli-resume-callable-seats.test.ts:24 | 不同类：:250 显式 host。 |
| test/integration/public-cli-resume.test.ts:28 | 不同类：显式 runner/hostAdapters，parentChain 同表；未注入项为配置。 |
| test/integration/public-cli-reviewer.test.ts:28 | 不同类：显式 reviewerHost 脚本 runner，批次子腿不入生产 envelope。 |
| test/integration/public-cli-same-ticket-resume.test.ts:123 | 不同类：配置种子；角色回合显式 host。 |
| test/integration/public-cli-same-ticket-resume.test.ts:46 | 不同类：显式 host，worker 退回 envelope 前轮已隔离。 |
| test/integration/public-cli-same-ticket-resume.test.ts:485 | 不同类：配置种子；角色回合显式 host。 |
| test/integration/public-cli-seat-pipeline.test.ts:17 | 不同类：:95/:151 显式 adapter。 |
| test/integration/public-cli-secretariat-run.test.ts:29 | 不同类：显式父/子 adapter，真实 envelope 前轮已隔离。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:168 | 已修：callEnv 仍不注入 host，依赖省略在生产 factory 的模块接缝。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:22 | 已修：默认 host 的所有有效回合统一不接无关 attendance。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:261 | 已修：首次 Claude 回合。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:275 | 已修：跨 host 后 mint。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:297 | 已修：显式 new。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:316 | 已修：显式 resume 的初始卷。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:328 | 已修：显式 resume 跨 host。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:350 | 已修：封卷前的初始调用。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:367 | 不同类：封卷复用不派发；如派发仍受共同依赖装配隔离。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:394 | 已修：封卷后的显式 new。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:411 | 已修：same-host 案初始回合。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:420 | 已修：same-host 成功恢复。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:436 | 已修：判词 nonzero host exit，失败回合不启动后台 lookup。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:452 | 已修：lease/court 案初始回合。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:466 | 不同类：lease/court 阻挡，不进入 host；共同装配仍覆盖后续派发。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:487 | 已修：unbound 初始回合。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:505 | 不同类：unbound lease/court 阻挡，不入 host。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:531 | 已修：new-run 缺 session 案初始回合。 |
| test/integration/public-cli-session-missing-fresh-summons.test.ts:546 | 已修：判词新 run 缺 session 的 ACP 失败回合不启动后台 lookup。 |

补充边界核对：lower ACP/headless adapter 自身必须传 prepare，不自己构造 dependencies。`host-session-acp-grok-usage-compact:69`、`host-session-acp-write-fail:80`、`host-session-live-records:113,210`、`headless-codex-host:169,435,519,606,688`、`resume-missing-host-session-id:67,118,164`、unit/integration `host-retry-verdict-relay:67/:85` 都返回受控 PreparedRoleTurn；真实 envelope 的 durable-session/secretariat/report-ticket 已在直接账逐项处置，不能再笼统称「ACP/headless 其余都注入」。源码 extension 消费者搜索无测试加载真实 extension；脚本 runner 在 `role-turn-host-fixture.ts:438–469` 接管 spawn。子进程补扫中 public-cli-bin-startup 只 config/help/roles，package 的 npm-identity 只启动 --help；analyst-public-bundle-families:81 是同步分析（cli.ts:1290 分流），process-cancel-driver:118 为显式 hangingHost。其他 spawn 命中是 Git/打包/假 host 二进制或脚本边界，不是默认 production envelope。

### 四案修前、修后与变异取证

仅在 `/tmp/1237-r23-probe` 的 detached 隔离工作树临时插桩；原测试 body、真实 summon/lookup host/ledger 写入均未替换。临时 AsyncLocalStorage 把父 lookup 与其真实 host 联系，在 host 封卷前门闩暂停；清理器确认已到该写口后执行原 rm，再释放并 await 实际 summon，观察 home 是否重建并清掉本席产物。该观察只在临时探针，不落仓为证明测试。是受控调度反例，不是自然复现频率，亦不声称自然复现 ENOTEMPTY。

命令前缀 `node node_modules/vitest/vitest.mjs run`；每次仅运行原文件原案，`-t` 依次为下表名称。选定调度使用 `R23_PARENT=run-822-coder-grok-reject` 或 `R23_SKIP=2/1`；其他回合照常继续。证据 `/tmp/1237-r23-evidence/{before,after}-{grok,822,same,new}.{jsonl,log}`。

| 原案入口与前序经历 | 修前 | 修后（本地 dist 存在） |
| --- | --- | --- |
| public-cli-host-axis / public grok-build turn inherits operator HOME；默认 ACP 失败并返回 | 原 body 断言通过，清理后重建；pending=3/entered=3，探针 exit1，2.24s | pending=0，未重建，原案通过，1.29s |
| public-cli-host-axis / #822 coder apply；仅 rejected set_model 回合暂停，其他成功回合继续 | 原 body 断言通过，清理后重建；pending=1/entered=1，exit1，2.60s | pending=0，未重建，原案通过，3.04s |
| public-cli-session-missing-fresh-summons / #1253 same-host resume；保前两次成功 lookup，只延后 nonzero exit 回合 | 原 body 断言通过，清理后重建；pending=1/entered=1，exit1，1.03s | pending=0，未重建，原案通过，1.43s |
| public-cli-session-missing-fresh-summons / #1253 a new run's own session-id-missing；保首次成功 lookup，延后后续 ACP 失败回合 | 原 body 断言通过，清理后重建；pending=4/entered=4，exit1，1.46s | pending=0，未重建，原案通过，1.90s |

修前与变异释放后，已删 cwd 导致 git rev-parse 的诊断如实保留在 log，真实 summon 均 fulfilled，但 home 重建；没有吞成成功证据。变异只在隔离副本撤去原 helper 的 delete：同 grok 真实入口 1.91s exit1，pending=3/entered=3、重建；恢复后1.23s exit0、pending=0、未重建（mutation/restored.jsonl/.log）。这也证明两个 dist 模块指向 source 后的真实依赖接缝已被触达，而非仅断言灯绿。

移除本席复制到隔离工作树的两个 dist 后，同样的 source fallback 首案1.59s通过；两文件全部19案再跑9.78s，19次清理 pending=0、未重建（after-source-all.jsonl/.log）。受审工作树不改 dist；正常聚焦 `pnpm exec vitest run` 的24文件完整参数见 focused.json：179/179、19.24s runner/20.07s墙钟；包含前轮22文件、两新增消费者，navigator 专项仍走真实 lookup 并通过。`pnpm exec tsc --noEmit` exit0。未跑全量。

### 自审、退役与核账

新增测试函数0、生产函数0；新增共享夹具含四个模块装配回调：ACP 模块 factory、headless 模块 factory、依赖模块 partial factory、其返回的 createRoleRuntimeDependencies。`rg -n 'vi\.mock|importOriginal|roleRuntimeDependenciesWithoutNavigator|delete .*createNavigatorAttendance' test --glob '*.ts'` 未找到已有同用途模块接缝；四者仅用 Vitest 原生机制转接原件，不重写 factory/adapter/loader。省略业务规则仍只在原 helper，第二个参数传原构造器，不产生第二份规则。各回调 existing=null，保留；原 helper 是修改而非新增。

入口未换；默认表未注入假 host；所有测试 body、请求和断言逐字未变。没有旧生产分支被替代，故无生产退役项；错误的扫净说明已在上节原位置撤回并补账。无新增删除断言/整案/整文件项目，断言计数算法不改；提交后的取树冲突及追加修复见下节。提交前逐文件核对 diff（含新夹具），提交后再以原 `python3 -I docs/research/issue-1237-deletion-ledger.py` 核实际 HEAD，结果入回执。不 amend/rewrite/push，不派角色；本次仅施工重交，由调用者直回大理寺复审。临时插桩已保存为 evidence 下 throwaway-probe.patch/.ts；隔离工作树及其 node_modules 软链已移除，受审工作树无插桩或变异残留。

### 提交后核账冲突：main 新增文件的后续修复

实际首提交 `cda91d17` 后原核账入口 exit1，不是1142通过：`public-cli-session-missing-fresh-summons.test.ts` 在 MAIN_MERGE 集成才进入本分支；原取树把它排除，HEAD 的一行测试装配修改与此形成 modify/delete。`/tmp/1237-r23-evidence/accounting-conflict.txt` 保留 Git 原冲突，不能改测试接缝来躲核账，也不能吞掉冲突或伪称已验。

修共同取树原因：在既有私有 index 中，对「集成时新增、集成后又有票内修改」的路径保留 MAIN_MERGE 原始 blob 作为上下文，然后仍由原 merge-tree 重放 HEAD 变化；后续真正删除仍由原 force-remove 生效。新增文件不在 BASE，所以不新增 BASE 的断言/整案计数；不是把所有 main 改动计入本票，不使用 ours/theirs 冲突偏好。当前交集仅该文件，已逐项核对；不硬编码文件名。复用 Git 原生 `ls-tree -rz` → `update-index -z --index-info`（官方 https://git-scm.com/docs/git-update-index 明示支持 ls-tree 格式），未自造合并器或新函数。

代码形状扫类及复扫命令：`rg -n '"read-tree"|"merge-tree"|"update-index"' docs scripts --glob '*.{py,ts,mjs}'`；输出仅下列四处（accounting-scan.txt），每处已复核：

| 命中 path:line | 结果 |
| --- | --- |
| docs/research/issue-1237-deletion-ledger.py:30 | 已修：read-tree 后为 main 新增且后续改过的路径补集成点上下文。 |
| docs/research/issue-1237-deletion-ledger.py:40 | 已修：只向原私有 index 补原始 blob，不预吞 HEAD 变化。 |
| docs/research/issue-1237-deletion-ledger.py:44 | 不同类：原后续删除优先规则保留，删除项仍真实计数。 |
| docs/research/issue-1237-deletion-ledger.py:49 | 不同类：原生 merge-tree 及冲突非零退出保留，无偏好合并。 |

同一个工作树/HEAD，`git show cda91d17:docs/research/issue-1237-deletion-ledger.py` 原版落到 evidence/accounting-old.py，从原 cwd 用 `python3 -I` 重跑 exit1；恢复取树逻辑的原入口 exit0，COUNT/MATCH1142，files19/cases116/asserts1007（accounting-mutation.log、accounting-restored.log）。该附带脚本修复另建提交，不 amend 第一提交。新增函数/测试均0；仅原核账入口聚焦复核，测试源码与先前179/179的内容未再变化；最终提交后再核真实 HEAD，结果见回执。

## 第二十三轮：R24-A navigator 专项旁路生产装配（起点 5a988e93）

裁决：本票 `runs/01a16876-ad7d-7a18-8be1-8e4ac923c070@judge/receipts/4.json`；符宝郎 `01a16883-0bdc-7419-8706-f9e285f074b8@notary/receipts/4.json` 署。审刑院 `01a16884-9a43-7f9b-b87b-8a06d7d0d4ca@auditor/receipts/4.json` 维持 R24-A，另以 A24-A 要求判词更正统计。此处不冒改判词：依审刑院原始核对，旧压力运行实际16遍、15过1次未定位失败；其 `-maxdepth 6` 不覆盖深度7的 navigator，不能主张两处全程零残留。本轮仅主张下述自己实测的范围。

错误形状：跨 runtime/envelope 的 navigator 专项，测试自行拼 attendance 与 lookup，绕过生产依赖构造器传递 role/phase 等输入；生产装错时测试仍绿。按代码形状扫，不按文件名豁免。纯单模块 attendance/lookup 输入测试、以假 attendance 驱动消费者的闭包/持久化测试，不声称覆盖装配，不混为此类。

先查 Vitest 官方 `https://vitest.dev/api/vi.html` 的 spyOn/mockImplementation/mockRestore；仓内无已有 summons spy（搜索 `rg -n 'vi\.spyOn|summonPublicRole' test --glob '*.ts'`），不自造拦截器。生产 `src/navigator-lookup.ts:65–66` 动态 import 正是既有观察边界。保留一个生产装配真源；没有新 helper、新生产钩子或通用件。

### 扫类与复扫逐项表

全仓 TS 候选及 JS/mjs 补扫：

```sh
rg -n 'createNavigatorAttendance|createNavigatorLookup|navigator-attendance\.ts|navigator-lookup\.ts' --glob '*.ts' --glob '!src/**' --glob '!dist/**' --glob '!node_modules/**' --glob '!docs/**'
rg -n 'createNavigatorAttendance|NavigatorLookup|navigator-attendance|navigator-lookup' --glob '*.{js,mjs,cts,mts}' --glob '!node_modules/**' --glob '!dist/**' --glob '!docs/**'
```

覆盖测试、夹具、间接装配与构建脚本的最终记账命令（起点28行、修后21行；模块引用同时捕获别名导入）：

```sh
git grep -n -E 'createNavigatorAttendance|createNavigatorLookup|navigator-attendance|navigator-lookup' 5a988e93 -- test scripts extensions
rg -n 'createNavigatorAttendance|createNavigatorLookup|navigator-attendance|navigator-lookup' test scripts extensions
```

原始输出 `/tmp/1237-r24-evidence/class-before.txt`、最终复扫 `import-class-after.txt`（首提交前为 class-after.txt）。下表一命中一行，坐标为起点→修后；删除的行注明承接，不伪称还存在。修后命中均包含在对应行，没有新增未结命中。

| 起点 path:line | 修后 | 结果 |
| --- | --- | --- |
| scripts/build-package.mjs:12 | 12 | 不同类：发布构建入口，不是测试装配。 |
| scripts/build-package.mjs:13 | 13 | 不同类：构建依赖注释。 |
| scripts/build-package.mjs:15 | 15 | 不同类：发布构建入口。 |
| test/contract/durable-session-write-failure.test.ts:37 | 37 | 不同类：向真实持久化消费者注入受控事件，守 flush failure，不测 lookup 装配。 |
| test/contract/navigator-attendance-lifecycle.test.ts:8 | 8 | 已修：移除 attendance 构造器导入，只留事件常量。 |
| test/contract/navigator-attendance-lifecycle.test.ts:9 | 删除 | 已修：移除 lookup 构造器导入，改用生产依赖表。 |
| test/contract/navigator-attendance-lifecycle.test.ts:52 | 54 | 不同类：受控回调守 closure 绑定与旧激活迟到消息隔离，不装配真实 attendance/lookup。 |
| test/contract/navigator-attendance-lifecycle.test.ts:168 | 170 | 不同类：工厂调用标记守 stationChild 是否创建依赖，不测构造器内部。 |
| test/contract/navigator-attendance-lifecycle.test.ts:395 | 390 | 已修：runtime 直接用 createRoleRuntimeDependencies。 |
| test/contract/navigator-attendance-lifecycle.test.ts:396 | 删除 | 已修：测试内 attendance 装配删除，由 :390 生产依赖表承接。 |
| test/contract/navigator-attendance-lifecycle.test.ts:402 | 删除 | 已修：测试内 lookup 装配删除；:344 原生 spy 在 summons 边界保持原挂起/abort 输入。 |
| test/contract/navigator-attendance.test.ts:8 | 8 | 不同类：单模块输入测试的被测入口导入，不替换生产依赖表。 |
| test/contract/navigator-attendance.test.ts:9 | 9 | 不同类：lookup 单模块入口与类型导入。 |
| test/contract/navigator-attendance.test.ts:20 | 20 | 不同类：attendance 单模块案的内存 lookup 输入，不宣称穿过 runtime 装配。 |
| test/contract/navigator-attendance.test.ts:76 | 76 | 不同类：上游 failure terminal 到 lookup unavailable 的独立转换契约。 |
| test/contract/navigator-attendance.test.ts:84 | 84 | 不同类：无 terminal 的上游输入边界。 |
| test/fixtures/471-resume-chain/01a03c71-4710-7000-8000-escalate-resume01@judge/session/session.jsonl:7 | 7 | 不同类：冻结 session 数据，无执行装配。 |
| test/fixtures/471-resume-chain/01a03c71-4710-7000-8000-escalate-resume01@judge/session/session.jsonl:15 | 15 | 不同类：冻结 session 数据，无执行装配。 |
| test/helpers/role-turn-host-fixture.ts:42 | 42 | 不同类：非 navigator 测试省略无关 attendance；R23-A 已裁合法，未撤回。 |
| test/integration/public-cli-judge.test.ts:227 | 227 | 不同类：故意矛盾的迟到消息输入，守 bound closure 优先，不构造 lookup。 |
| test/integration/public-cli-navigator-attendance.test.ts:14 | 删除 | 已修：删除测试 lookup 导入，观察迁到 public-role-summons。 |
| test/integration/public-cli-navigator-attendance.test.ts:18 | 18 | 不同类：仅类型，新增句柄类型用于读取生产 isPreparing。 |
| test/integration/public-cli-navigator-attendance.test.ts:24 | 删除 | 已修：删除测试 attendance 构造器导入。 |
| test/integration/public-cli-navigator-attendance.test.ts:130 | 153 | 已修：包装只收集 onEvent，委托生产工厂。 |
| test/integration/public-cli-navigator-attendance.test.ts:131 | 154 | 不同类：原生产函数的参数类型，未自行定义装配契约。 |
| test/integration/public-cli-navigator-attendance.test.ts:137 | 156 | 已修：成功与 failingLookup 都调用 baseDeps.createNavigatorAttendance。 |
| test/integration/public-cli-navigator-attendance.test.ts:139 | 删除 | 已修：移除手工 lookup；:129 原生 spy 委托真实 summon，仅失败案注入原文件系统故障。 |
| test/package/npm-identity-metadata.test.ts:166 | 166 | 不同类：发布物原生动态加载，不自行构造 attendance。 |

直接 navigator 公开入口 `test/integration/public-cli-navigator-lookup.test.ts` 全文另核：runAkRole → 真实 lookup 管线，无 attendance 替身。上述被排除的单模块案也纳入聚焦验证。

### 修法、退役与进口账

- integration：真实入口仍是 runPublicInstructionSeat → prepareRoleEnvelope → 生产依赖表 → attendance/lookup → public summon → ledger/Terminal。只把旧 summon 委托回调移到 Vitest spy；成功路径输入原样，failingLookup 仍令 state.jsonl 成为目录，不替换真实失败结果。清理前读生产句柄 isPreparing：尚在准备才等待真实 summon 的 finally；plan 不启动时不等，不从测试自己的 phase 推算生产状态。父宿主失败也保留 finally。Spy 由 onTestFinished(mockRestore) 恢复。
- lifecycle：原同构手工装配整块删除，runtime 直接取生产依赖表；仅原挂起的 summons 输入移到 spy，取消 signal/宽限期/不阻塞 shutdown 的原断言全部保留。未加 sleep、重试、轮询或墙钟上限；原先既有等待函数未扩增。
- 进口：integration 旁路在本票 `3497bab8` 引入；本票台院 `runs/01a168bd-392a-73a8-a954-815f499c29ef@inspector/receipts/2.json` 放行时仍记「navigator 专项未受模块替换污染」，未拦住手工装配；御史台 correctness 与本轮大理寺才指出。lifecycle 旁路由 `git blame -L 390,405 5a988e93 -- test/contract/navigator-attendance-lifecycle.test.ts` 定位 `77d37bc7`（#1192）；`~/.ak-roles/books/ak-pi-workflow-roles/1192/runs/01a14ed5-38de-75c1-8db1-f2344e1418d8@inspector/receipts/3.json` 在后继 HEAD 382ec72f 纳入 lifecycle 并放行，未指出此装配旁路。不推断其他未打开席位的判断。

### 验证与自审

证据统一放 `/tmp/1237-r24-evidence/`，保留完整 stdout/stderr，不只保留计数：

- 修前生产 `src/role-runtime-dependencies.ts:54` 临时改 `phase: "plan"`，`npx vitest run --project integration test/integration/public-cli-navigator-attendance.test.ts --reporter=verbose` → 10 passed、exit0、2.04s（before-phase.log），复现漏报。
- 修后同一生产变异，`npx vitest run test/integration/public-cli-navigator-attendance.test.ts test/contract/navigator-attendance-lifecycle.test.ts --reporter=verbose --reporter=json --outputFile.json=/tmp/1237-r24-evidence/final-phase.json` → 9 failed / 5 passed、exit1、3.21s。专项是8败2过（含 failingLookup 的 unavailable 断言报红）；lifecycle 是1败3过。这里不照抄判词旧测试的7败3过。
- 复原生产源码，`npx vitest run test/contract/navigator-attendance-lifecycle.test.ts test/contract/navigator-attendance.test.ts test/integration/public-cli-navigator-attendance.test.ts test/integration/public-cli-navigator-lookup.test.ts --reporter=verbose` → 26/26、exit0、1.94s（final-focused.log）。`npx tsc --noEmit` exit0（final-tsc.log）。`git diff --exit-code -- src` exit0。
- 首提交前最后一次测试代码变动后，`npx vitest run --project integration test/integration/public-cli-navigator-attendance.test.ts test/integration/role-envelope-engine-axis.test.ts test/integration/audited-run-identity-1166.test.ts --reporter=verbose --reporter=json --outputFile.json=/tmp/1237-r24-evidence/final-load-N.json` 连续10遍，每遍三文件并跑、18/18、exit0；墙钟依次3.22/2.72/3.15/2.97/3.17/2.94/3.45/2.72/3.37/2.96s。每遍 ENOTEMPTY=0、新 home=0、新 @navigator=0。范围严格是系统 TMPDIR、解析后的 /tmp、工作树三根下顶层 ak-* / .test-tmp-* home；所有后代不限深度递归，与运行前快照比对，每轮结束检查。非这些 home 的既存目录不在结论中；完整根、基线、逐轮结果见 final-load-summary.json。此前还有一组10遍均18/18（load-summary.json），两组不混算；追加导入整理后的最终证据见下段。
- 自审：`git diff HEAD` 中新增测试函数0、生产函数0、helper 0，diffItems=[]；summon/createRunId/onEvent/Promise 回调只是搬移或修改，恢复直接用 Vitest 的 mockRestore，不新增包装函数。原输入、断言、失败路径未删弱；只删测试复制的生产装配与假 Soul loader。首提交两处测试改动净减17行，追加导入整理后净减15行，未引入新机制。`git diff --check` 通过；原有未跟踪 node-test-report.txt 已打开，未改、未删、未提交。
- 无新增删除断言、整案、整文件，删除账计数算法与 MAIN_MERGE 不改。独立新提交后运行 `python3 -I docs/research/issue-1237-deletion-ledger.py` 核真实 HEAD，实际结果入终局回执。不跑全量，不动真实席位/宿主配置，不 push、不派角色；本轮交修理回执待复审，不声称整票合并。

### 首提交后核账冲突与追加导入整理

`beb32297` 提交后原核账入口实际 exit1（final-ledger.log），不是 COUNT/MATCH 通过。打开原 `git merge-tree --write-tree --merge-base=c2c9175dacecc8121be7005eb55501e213f62787:test dc7c18023bde59b62d1d8dfb4eb6d04dc4eb56fd HEAD:test` 的冲突树，两个冲突都仅是 runner 导入：排除 main 的 Vitest 迁移时，旧树为 `import test from "node:test"`，本轮在同一行加入 vi/onTestFinished，Git 无法自动合并（ledger-conflict.txt、lifecycle-conflict.ts、integration-conflict.ts）。

仅将原 runner import 保持原行，新增的 Vitest 能力放在另一条 import；这是导入布局整理，不退回 node:test、不改行为、不改核账脚本、不保留冲突偏好或兼容机制。上表修后坐标已随之同步。自审新增函数仍0；`git diff HEAD` 只有两处 import 整理与本账，没有新断言/旧断言删除。

整理后重复同一 phase 变异与四文件聚焦，分别9败5过（专项8败2过、lifecycle 1败3过，3.71s）与26/26（2.26s），import-phase.json/.log、import-focused.log；生产已恢复，tsc exit0（import-tsc.log）。最终再跑相同三文件并行命令10遍，逐轮18/18、exit0，ENOTEMPTY/新增 home/新增 @navigator 均0；每轮墙钟4.37/3.30/4.23/3.34/3.28/3.71/3.32/3.49/3.01/3.07s。扫描范围与不限深度判据同上，完整基线与逐轮数据 import-load-summary.json，原始日志 import-load-{1..10}.log/.json。此前两组10遍为过程证据，不混为这次最终10遍。不 amend，追加独立提交后原入口再核最终 HEAD，实际结果记终局回执。

追加提交 `5b006ef4` 后取树冲突消失，核账实际为 COUNT1143 / ledger1142、exit1（import-final-ledger.log）：增加的 case 是 integration 的既有 `test(scenario.name, async () => ...)` 声明行改为取 context，统计器按被修改的 case 起始行登记，并非删了一个案。采用更简单且与 lifecycle 一致的 API：从 Vitest 直接导入 onTestFinished，不从测试 context 解构，原 test 声明保留。没有改断言或统计规则，没有新增测试/函数；两种取法都是 Vitest 原件。再建独立提交，不 amend；该最终提交上的 phase 变异、四文件聚焦、三文件10轮并行、tsc、核账的命令与实测结果统一记终局回执及 `/tmp/1237-r24-evidence/receipt-*`。上文各组记录仍保留为对应提交的过程证据，不冒充最终提交结果。
