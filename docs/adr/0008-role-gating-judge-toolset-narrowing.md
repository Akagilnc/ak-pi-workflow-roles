# 0008 — 角色门禁:判官工具集包内收窄;不建命令启发闸

Status: proposed(owner 2026-07-27 grill 拍定;评审闭环后转 accepted)
Date: 2026-07-27

判官角色激活时,包内以工具名单收窄(`setActiveTools`)到取证集——read/grep/find/ls/bash 保留,write/edit 摘除:把已批法「不改码、不 commit」机械化,判定为名单成员资格、零误判。fixer 不设车间内破坏性命令闸:对 bash 命令串做启发式分类属被废除的 NL 启发层同族;历史改写的确定性保证在出口(forward-commit/严格后代检查,收货侧)。明示边界:工具收窄**不是安全边界**——防角色跑偏,不防恶意;真隔离归调用方的容器/沙箱(Pi 官方姿势)。

**修正案(owner 2026-07-27 同日拍定,`rm -rf` 失败现场实证拉动):**「不建启发式命令分类」维持;新增**已知致命字面模式的窄名单闸**——`tool_call` 对 bash 命令做**字面匹配**拦截(`rm -rf`、`git reset --hard`、`git clean`、`git checkout --` 一类),拦下附理由,正当需求换写法或上抛;名单封顶个位数、只许字面、永不长成语义分类器。定性 **seatbelt**:防呆不防坏。立法依据=护栏三问全过:当日实证(dogfood 工装 `rm -rf` 销毁失败现场)、后果不可逆、**删除类操作无任何下游兜底**——此点区别于历史改写(有 forward-commit 出口闸),故主文对 fixer 命令闸的拒绝理由对删除类不成立。有人在场的 standalone 形态可实现为确认式拦截(Pi 官方 confirm-destructive 样板)。
