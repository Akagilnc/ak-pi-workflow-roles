# 0008 — 角色门禁:大理寺工具集包内收窄;Fixer bash 字面 seatbelt

Status: accepted
Date: 2026-07-27

大理寺角色激活时,包内以工具名单收窄(`setActiveTools`)到取证集——read/grep/find/ls/bash 保留,write/edit 摘除:把已批法「不改码、不 commit」机械化,判定为名单成员资格、零误判。明示边界:工具收窄**不是安全边界**——防角色跑偏,不防恶意;真隔离归调用方的容器/沙箱(Pi 官方姿势)。

**修正案(陛下 2026-07-27 同日拍定,`rm -rf` 失败现场实证拉动;issue #1 authority freeze 收口):**「不建启发式命令分类」维持。Fixer 角色控制器在 `plan`/`apply` 两阶段对 bash 的 `tool_call` 做**字面子串**拦截:只检查字符串 `command`,大小写敏感,命中下列**恰好四条** ASCII 字面量之一即拦——`rm -rf`、`git reset --hard`、`git clean`、`git checkout --`。返回 Pi 普通 blocked-tool 理由(点名命中字面量),不执行该 bash、不中止会话、不合成回执、不加确认 UI;模型可换写法或向调用方提交 `refused`。不做分词、shell 解析、正则族扩展、空白归一、大小写折叠、别名/路径/环境解码或等价推断。字面出现在无害文本中也拦;不含精确字节的变体不在本闸范围。定性 **seatbelt**:防呆不防坏——防意外销毁漂移,不承诺敌意代码、shell 沙箱、文件系统隔离或抗绕过;真隔离仍归调用方容器/沙箱。立法依据=护栏三问全过:当日实证(dogfood 工装 `rm -rf` 销毁失败现场)、后果不可逆、**删除类操作无任何下游兜底**——此点区别于历史改写(有 forward-commit 出口闸)。本闸只挂在已激活 Fixer 的角色生命周期上,不是通用 bash 策略、调用方策略、Soul 条款或跨角色机制。
