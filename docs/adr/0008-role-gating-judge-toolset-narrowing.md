# 0008 — 角色门禁:判官工具集包内收窄;不建命令启发闸

Status: proposed(owner 2026-07-27 grill 拍定;评审闭环后转 accepted)
Date: 2026-07-27

判官角色激活时,包内以工具名单收窄(`setActiveTools`)到取证集——read/grep/find/ls/bash 保留,write/edit 摘除:把已批法「不改码、不 commit」机械化,判定为名单成员资格、零误判。fixer 不设车间内破坏性命令闸:对 bash 命令串做启发式分类属被废除的 NL 启发层同族;历史改写的确定性保证在出口(forward-commit/严格后代检查,收货侧)。明示边界:工具收窄**不是安全边界**——防角色跑偏,不防恶意;真隔离归调用方的容器/沙箱(Pi 官方姿势)。
