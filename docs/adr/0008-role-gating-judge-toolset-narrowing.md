# 0008 — 角色门禁:大理寺工具集包内收窄;Fixer bash 字面 seatbelt

Status: accepted
Date: 2026-07-27

大理寺角色激活时的包内工具名单收窄已经废止；大理寺与审刑院均可读、可写、可查并可临时改代码测试，只须最终恢复原样。现行决定与法源见 [ADR 0064](0064-evidence-roles-have-unrestricted-tools.md)。

**修正案(陛下 2026-07-27 同日拍定,`rm -rf` 失败现场实证拉动;issue #1 authority freeze 收口):**「不建启发式命令分类」维持。Fixer 角色控制器在 `plan`/`apply` 两阶段对 bash 的 `tool_call` 做**字面子串**拦截:只检查字符串 `command`,大小写敏感,命中下列**恰好四条** ASCII 字面量之一即拦——`rm -rf`、`git reset --hard`、`git clean`、`git checkout --`。返回 Pi 普通 blocked-tool 理由(点名命中字面量),不执行该 bash、不中止会话、不合成回执、不加确认 UI;模型可换写法或向调用方提交 `refused`。不做分词、shell 解析、正则族扩展、空白归一、大小写折叠、别名/路径/环境解码或等价推断。字面出现在无害文本中也拦;不含精确字节的变体不在本闸范围。定性 **seatbelt**:防呆不防坏——防意外销毁漂移,不承诺敌意代码、shell 沙箱、文件系统隔离或抗绕过;真隔离仍归调用方容器/沙箱。立法依据=护栏三问全过:当日实证(dogfood 工装 `rm -rf` 销毁失败现场)、后果不可逆、**删除类操作无任何下游兜底**——此点区别于历史改写(有 forward-commit 出口闸)。本闸只挂在已激活 Fixer 的角色生命周期上,不是通用 bash 策略、调用方策略、Soul 条款或跨角色机制。
