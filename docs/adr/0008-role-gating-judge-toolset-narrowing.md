# 角色门禁：大理寺工具集废止收窄；Fixer bash 字面 seatbelt

Status: accepted

大理寺角色激活时的包内工具名单收窄已废止，现行取证权见 ADR 0064。Fixer 在 plan/apply 两阶段对 bash 的 command 做字面子串拦截，恰好四条 ASCII 字面量——`rm -rf`、`git reset --hard`、`git clean`、`git checkout --`——命中即拦、不执行、不中止会话；不做分词、解析、正则或等价推断。定性 seatbelt：防呆不防坏，真隔离仍归调用方容器；本闸只挂已激活 Fixer，不是通用 bash 策略。
