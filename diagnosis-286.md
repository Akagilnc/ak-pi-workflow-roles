# diagnosis-286：runId → 实际加载入口/包根/版本/入口形态（机械联结）

诊断时刻：2026-08-12。现象 run：`019ff385-ef38-7bf8-af25-2cfffaf15264@judge`（books/Ming_LLM）。

## 1. 联结结论（机械，非目录猜测）

| 字段 | 现场观测值 |
| --- | --- |
| runId | `019ff385-ef38-7bf8-af25-2cfffaf15264@judge` |
| 入口形态 entryMode | **public-cli**（`ak-role` bin → `dist/public-cli/main.js`，再显式 `-e extensions/role-runtime.ts`） |
| canonical selected role entry | `/private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/extensions/role-runtime.ts` |
| package root | `/private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles` |
| package version | `0.1.0`（tarball `akagilnc-pi-workflow-roles-0.1.0.tgz`，打包时刻 2026-08-11 15:02:59，**早于** #264 合入 `bf3582ce` 2026-08-11 21:10:29 +0900） |
| 父进程/编排 | ChatGPT Codex `app-server` 以绝对路径调用该 runtime 的 `ak-role`（非机器主安装 `/Users/akagilnc/.pi/agent/npm/node_modules/.bin/ak-role`） |

**分流判定**：lane 走的是公开 CLI 入口，但加载的是**冻结的 pre-#264 包副本**，不是 origin/main 当前包。  
⇒ Class 1 owner **不在** `runComplianceAudit→executeAuditorChild` 当前源码接缝（该接缝在 main 已无条件挂载 dossier 工具）；owner 是外部编排器钉死的旧 tarball 安装面。按 ADR 0052：**不得在本包造兼容旁路**；须把 Ming/Codex runtime 收束到含 #264 的公开 `ak-role` 包并上呈跨仓处置。  
⇒ Class 2：本包须在 `invocation.json` 单一身份页写入上述现场观测字段，使同类案件可从卷面收口。

## 2. 命令与输出原文

### 2.1 现场仍在伺服 Ming 的 runtime 布局

```text
$ cat /private/tmp/ak-role-ming-runtime-GzPk8q/package.json
{
  "dependencies": {
    "@akagilnc/pi-workflow-roles": "file:akagilnc-pi-workflow-roles-0.1.0.tgz",
    "@earendil-works/pi-coding-agent": "^0.84.1"
  }
}

$ realpath /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/.bin/ak-role
/private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/dist/public-cli/main.js

$ ls -la /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/.bin/ak-role
lrwxr-xr-x@ 1 akagilnc  wheel  54 Aug 11 15:03 /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/.bin/ak-role -> ../@akagilnc/pi-workflow-roles/dist/public-cli/main.js

$ python3 -c 'import json; print(json.load(open("/private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/package.json"))["version"])'
0.1.0

$ realpath /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/extensions/role-runtime.ts
/private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/extensions/role-runtime.ts

$ shasum -a 256 /private/tmp/ak-role-ming-runtime-GzPk8q/akagilnc-pi-workflow-roles-0.1.0.tgz
2d2b3952ff864dd73e3499ab1a740c1da1eb5e19791bf9471a88c023f05013b5  /private/tmp/ak-role-ming-runtime-GzPk8q/akagilnc-pi-workflow-roles-0.1.0.tgz

$ stat -f '%Sm %N' /private/tmp/ak-role-ming-runtime-GzPk8q/akagilnc-pi-workflow-roles-0.1.0.tgz
Aug 11 15:02:59 2026 /private/tmp/ak-role-ming-runtime-GzPk8q/akagilnc-pi-workflow-roles-0.1.0.tgz

$ git log -1 --format='%h %ci %s' bf3582ce
bf3582ce 2026-08-11 21:10:29 +0900 Merge pull request #273 from Akagilnc/feat/issue-264-sitian-dossier-tool
```

### 2.2 该 runtime 的 auditor 接缝（无 dossier 工具）

```text
$ ls /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/dist/auditor-dossier-tool.js
ls: /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/dist/auditor-dossier-tool.js: No such file or directory

$ sed -n '79,88p' /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/dist/compliance-transport.js
    const receipt = await executeAuditorChild({
        tool: options.tool,
        systemPrompt: options.systemPrompt,
        prompt,
        roleLabel: options.roleLabel,
        context: options.context,
        retainResponse: (response) => retainComplianceResponse(options.context, response),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

$ sed -n '405,406p' /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/@akagilnc/pi-workflow-roles/dist/evidence-child-executor.js
            customTools: [tool],
```

对照当前 worktree `dist/compliance-transport.js`（含 #264）：

```text
$ rg -n "createAuditorDossierTool|dossierTool" dist/compliance-transport.js
3:import { createAuditorDossierTool } from "./auditor-dossier-tool.js";
67:        dossierTool: createAuditorDossierTool(options.runDirectory),
```

### 2.3 现象 run 卷面

```text
$ cat /Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff385-ef38-7bf8-af25-2cfffaf15264@judge/invocation.json
{
  "role": "judge",
  "runId": "019ff385-ef38-7bf8-af25-2cfffaf15264",
  "bookKey": "Ming_LLM",
  "projectRoot": "/Users/akagilnc/WorkSpace/Ming_LLM-563",
  "runDirectory": "/Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff385-ef38-7bf8-af25-2cfffaf15264@judge",
  "sessionDirectory": "/Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff385-ef38-7bf8-af25-2cfffaf15264@judge/session",
  "sessionFile": "/Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff385-ef38-7bf8-af25-2cfffaf15264@judge/session/session.jsonl"
}
# 无 piExecutable / 无 role package 身份字段

$ python3 -c 'import json; p="/Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff385-ef38-7bf8-af25-2cfffaf15264@judge/session/auditor-roles/2026-08-12T01-21-48-002Z_019ff38f-afe2-7b48-8dce-62b3718bc647.jsonl"; rows=[json.loads(x) for x in open(p)]; names=[c.get("name") for r in rows for c in r.get("message",{}).get("content",[]) if c.get("type")=="toolCall"]; print("file",p); print("ak_tools",sorted(set(n for n in names if isinstance(n,str) and n.startswith("ak_")))); print("dossier_mentions",sum("ak_get_run_dossier" in x for x in open(p)))'
file /Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff385-ef38-7bf8-af25-2cfffaf15264@judge/session/auditor-roles/2026-08-12T01-21-48-002Z_019ff38f-afe2-7b48-8dce-62b3718bc647.jsonl
ak_tools ['ak_soul_audit_decision']
dossier_mentions 0
```

### 2.4 活进程树（复核时仍见同一 runtime 由 Codex app-server 伺服 Ming）

```text
$ ps -o pid,ppid,command -p 4646,58902
  PID  PPID COMMAND
 4646 58902 node /private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/.bin/ak-role judge --project /Users/akagilnc/WorkSpace/Ming_LLM-561 --model openai-codex/gpt-5.6-sol --thinking medium --attach /Users/akagilnc/.ak-roles/books/Ming_LLM/runs/019ff3e4-a92b-7170-be6d-5f7075200d41@fixer/artifacts/report.json Fresh read-only final adjudication after current main merge, exact HEAD d011fed1c1c07f9d8ba6a0c83617dfb59c6bd87d. Verify #609 typed primary_opponents remains sole authority; legal_reason_code empty slot/exact-key and appointment_tenure docs are aligned; #561 batch judge, qualitative character axes, real gate, and #563 mode behavior coexist; full evidence/additive two-parent history/clean tree. No edits. Final converge/continue.
58902 58567 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled
```

Codex session 记录中同一 bin 被绝对路径调用（节选路径，非猜测）：

```text
"/private/tmp/ak-role-ming-runtime-GzPk8q/node_modules/.bin/ak-role" judge --model openai-codex/gpt-5.6-sol --thinking medium --project "/Users/akagilnc/WorkSpace/Ming_LLM-563" --attach "$HOME/.ak-roles/books/Ming_LLM/runs/019fef86-4ca0-768b-afef-e82839913368@judge/artifacts/report.json"
```

（出处：`~/.codex/sessions/2026/06/07/rollout-2026-06-07T13-26-43-019ea055-4687-7793-a5ec-14af44b6f976.jsonl` 内多次 `exec_command`。）

### 2.5 对照组（公开 CLI 新包路径，有 pi 身份、有 dossier 调用）

```text
$ cat /Users/akagilnc/.ak-roles/books/court-menxia/runs/019ff3c6-77bb-7ced-9e68-5f69e6dbbff7@judge/invocation.json
{
  "role": "judge",
  "piExecutable": "/Users/akagilnc/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  "piVersion": "0.84.1"
}
# 该 run auditor session 中 ak_get_run_dossier 出现次数 = 68
```

## 3. 分流与修理面

1. **Class 1（discoverability）**  
   - 当前包接缝已正确；不得再加平行 locator / prompt 投喂。  
   - 跨仓上呈：Ming/Codex 的 `ak-role-ming-runtime-*` 必须重建为含 #264 及之后的包（或改指向 `pi install`/`~/.pi/agent/npm` 的当前 registry 包），禁止继续钉 2026-08-11 15:02 的 pre-#264 tgz。  
   - 本仓：把 #264 tracer 收到「tarball 冷装 + 公开 CLI 包根」真实形状，并断言 dossier 可调用；同时靠 Class 2 身份页暴露错装。

2. **Class 2（launch provenance）**  
   - 在既有 `invocation.json` 页、既有 launched-identity writer 族，写入现场观测的 `roleEntry` / `rolePackageRoot` / `rolePackageVersion` / `entryMode`。  
   - 不新建第二 ledger，不写固定 `version:1` schema 字段。
