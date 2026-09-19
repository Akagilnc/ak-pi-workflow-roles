# CONTEXT — @akagilnc/pi-workflow-roles 词表

> 只放术语,零实现细节。决策的为什么在 `docs/adr/`。

- **角色(Role)**:有明确职掌、受门禁约束、以交卷物为法定出口的**车间内**治理单元（默认 typed；游奕使出口为散文）。角色只管一次调用的内政。按派单权分**寺监级**与**省部级**（法律分类）。实现不限于 LLM。见 ADR 0010、0047、0051。
- **Soul**:LLM 角色的身份与不可约判断原则,经系统提示注入。分**通用层**与**业务 overlay**。确定性角色无 soul。见 ADR 0005。
- **角色方法 Skill(Role method Skill)**:供一个角色执行具体任务方法的包版本化材料；Soul 持判断原则，Skill 持可替换方法步骤。见 ADR 0032、0082。
- **角色门禁(Role gating)**:车间内的机械限制（LLM：工具集收窄与调用拦截；确定性角色：自身能力边界）。区别于 soul 文本约束。见 ADR 0008。
- **交卷工具(Submission tool)**:角色具名的 terminating 工具(`ak_<role>_output`)。**回执(Receipt)** = 其产物,角色劳动成果的法定出口（默认 typed；游奕使为散文）。无回执终局是生命周期 typed 事实,不是回执。见 ADR 0003、0041。
- **审核席(Review seat)**:父席交卷后按受审物传召的审核角色（如台院、符宝郎、审刑院）。见 ADR 0055、0079、0080。
- **格式契约(Format contract)**:在具名输入、输出或持久化边界上,由真实生产路径执行、会改变接受或拒绝结果,且有明确 owner 与 consumer 的格式不变式。见 ADR 0036。
- **最小必需验证(Minimum-required validation)**:输入输出只验证必须有的。见 ADR 0025。
- **形状校验(Shape validation)**:拒收理由**只涉数据排布**（在场/缺席、键拼写、基数、类型、跨字段组合）；一旦需引用外部可观察事实或世界规则,即非形状校验。见 ADR 0055；CLAUDE.md 第 0 条。
- **记账位(Ledger slot)**:每份角色输出唯一精确 key 及取值域(如 `judgeStatus`),供落账与呈现。不是编排控制流。见 ADR 0010、0040、0057。
- **承接者判据(Successor test)**:删与留之争的可核验判据。见 ADR 0084；关联 ADR 0036、`souls/quality-law.md` 三问。
- **同类扫描(Class-wide scan)**:以会拒绝输入输出的同类行为为范围的全仓扫描。见 ADR 0045。
- **语义 JSON 校验(Semantic JSON validation)**:对 JSON 值的生产语义进行校验。见 ADR 0021。
- **发布 Schema(Published schema)**:供包外机器消费者使用的机器可读契约投影。见 ADR 0022。
- **边界 Schema 真源(Boundary schema owner)**:定义单个工具输入或输出形状的唯一 Schema。见 ADR 0023。
- **模型自报(Model self-report)**:角色在回执中声明、但未由拥有该事实的生产接缝现场观察的值。见 ADR 0024、0042。
- **Judge(大理寺)**:只判卷、不改码、不 commit 的裁决角色。canonical 名。专事后判卷。见 README 大理寺；ADR 0074。
- **Fixer(修内司)**:以 `plan`/`apply` 处理调用方修理包的角色。见 README Fixer；ADR 0015、0034、0050。
- **Coder(将作监)**:以 `plan`/`apply` 完成首次实现或据理拒绝派单的角色。apply 绑定包内 canonical TDD 方法 Skill。见 ADR 0032、0034、0050、0082。
- **未完终态(Unfinished)**:worker apply 阶段合法交卷状态，语义为**受阻求援**；可续交棒,不是失败,不豁免验收。见 ADR 0050。
- **Reviewer(御史台)**:围绕固定目标做独立、可追溯代码评审的寺监级角色;不派 worker、不修复、不发布、不作最终裁决。绑定 `ak-cross-m-review`。见 ADR 0010、0031、0032、0082。
- **门下省(Gate province)**:审署诏敕与质量保证的省部级席位。调用者可单独传召；各官仍是独立角色。见 ADR 0067、0074、0079。
_Avoid_:把「门下省」当作通进司的公开角色名。
- **中书省(Secretariat)**:改票的出令省；按《票面法》把草稿修成可送庭文书。
- **给事中(Countersign)**:门下省下的**票庭审读官**；开工前的派单、方案、处置案先过本席。见 ADR 0074、0075。
- **左拾遗(Gleaner-left)**:门下省下合并前无锚定风闻官；只上弹章、不封驳不裁决。见 ADR 0067。
- **台院(Inspector)**:纠举推鞫官；审**复杂度**与**测试质量**。机器键 `inspector`。见 ADR 0074。
- **符宝郎(Document-fidelity auditor)**:门下省下独立文书核验角色。首责：**核实实际授权出处**。见 ADR 0067、0074、0075、0079。
- **起居录(ticket-provenance)**:每票一份的共同案卷，内容**仅限陛下与 runner 的对话**。不同于一次运行的卷宗。见 ADR 0075、0081。
- **起居郎(diarist)**:判断本庭对象是哪张票、本票对话起止于何处的记录者；正文与指针由机械从会话卷原样搬运。见 ADR 0075、0081。
- **通进司(Collector)**:门下省下的收证衙门；不评审、不裁决、不修复、不路由。canonical 键 `collector`。见 ADR 0067。
_Avoid_:门下省（那是省名）。
- **评审腿(Review leg)**:completeness／correctness 普通单轴 Reviewer run 之一。见 ADR 0010、0082。
- **Soul 审刑院(Soul-compliance audit)**:独立实质审计角色,自行取证并判断「该有的有没有」与「有的对不对」。见 ADR 0062。
- **卷宗(Dossier)**:一次 run 在候簿里的全部既落账材料。见 ADR 0048、0085。
- **先立卷后审卷**:跨角色／账本接缝上合法取证次序的名称。见 ADR 0085。
- **绑定(Binding)**:targetHead 一类对象同一性机械校验能力。见 ADR 0004、0027、0037。
- **Navigator(游奕使)**:旁听包角色结算的独立领航席；建议下一包角色/phase，不裁决、不授权、不执行。见 ADR 0061。
- **路书(Route playbook)**:游奕使用于专业判断的非约束参考路线。_Avoid_:默认工作流、路由表、自动编排规则。见 ADR 0061。
- **角色调用(Role invocation)**:一个角色从输入到回执的单次独立劳动。见 ADR 0010。
- **公开角色 CLI(Public role CLI)**:包外调用者使用角色包的唯一受支持产品入口。见 ADR 0052、0082。
_Avoid_:把裸 Pi 角色入口、session 文件或事件流称为公开 CLI。
- **内部角色入口(Internal role entrypoint)**:获授权包开发 session 用来激活和诊断角色的仓内接缝，不是外部产品面。_Avoid_:公开入口、备用 CLI。见 ADR 0082。
- **调用请求(Invocation request)**:一次角色调用的输入（可选 instruction、attachments、角色专属参数）。见 ADR 0052。
- **附件(Attachment)**:调用者明确附给一次角色调用的材料。见 ADR 0052。
- **终局结果(Terminal result)**:公开角色 CLI 对一次已受理调用交付的完整结果。见 ADR 0052。
- **角色运行(Role run)**:一次已受理角色调用的持久执行身份。见 ADR 0052。
- **候簿(Ledger book)**:包所有的机器级记录之家,按主仓分簿。见 ADR 0048、0049。
_Avoid_:家册、账本目录、工作区记录。
- **司天台(Archivist)**:记录的所有者（如实记录与生成高阶数据）。确定性机制,非 LLM 角色。见 ADR 0047、0065、0077。
_Avoid_:Recorder、Docket、遥测。
- **太史(Analyst)**:司天台的分析席；只读记录、生成高阶数据。确定性机制。见 ADR 0068。
_Avoid_:遥测、metrics-service、Telemetry。
- **Artifact reference**:终局结果中声明的本地材料引用。见 ADR 0052。
- **引擎（Engine）**:角色劳动的执行后端（默认 pi 内自跑；可外包本地 CLI）。见 ADR 0069、0071。
- **编排器(Orchestrator)**:包外交通系统；本包不含通用编排器。见 ADR 0010。
- **三态判词**:`converged` / `continue` / `escalate`（给事中票庭：署／封驳／上呈）。见 ADR 0074。
- **裁类循环（Class-repair loop）**：由判词类字段、回执对账键、圈界参数三份合同自然组成的修理循环。见 ADR 0015。
- **Merger（校书郎）**：保全双方已授权意图并完成一次普通双亲 merge commit 的角色。见 README 校书郎；ADR 0027。
- **尚书省（Marshal）**：审→判→修 质量收敛环的省部级驱动角色。canonical 键 `marshal`。见 ADR 0051；README。
- **Doctor(太医署)**:读保留 Pi session 案例、产出单案过程成本诊断并开方的举证角色。见 ADR 0012、0013、0017。
- **工厂(Factory)**:车间整体（角色、闸、法、包模板、流程站点）。太医署的唯一病人。见 ADR 0013。
- **大扫除(Factory cleanup)**:按最小完整责任边界删除无收益机制及其专属格式、适配、测试和文档。见 ADR 0036、0045。
- **落地周期(Issue-to-merge lead time)**:首 run 起点至 now／关票的端到端时长。见 issue #136。
- **方子(Prescription)**:太医署的 finding 加处置建议。见 ADR 0012、0013。
- **真咬人(Real bite)**:闸最近真拦下东西的证据。见 ADR 0012。
- **过程成本报告(Process-cost report)**:由保留 runs 中 Pi session 字节可重算的单案过程成本诊断。见 ADR 0017。
