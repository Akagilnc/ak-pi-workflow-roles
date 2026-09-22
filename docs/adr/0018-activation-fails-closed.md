# 失败不吞、不丢

Status: accepted

失败必须如实落痕：不吞异常，不丢弃错误信息。失败本身不决定整次调用是否终止；附属腿失败时主流程照常续跑，不被拖死。生命周期由注册席共享信封独家拥有，角色永不自带生命周期代码。

> owner 逐字：「这句话愿意是不要吞异常。不要丢弃错误信息。谁说不能续跑？游奕使失败了主流程就应该续跑而不是被拖死」（源卷 `~/.claude/projects/-Users-akagilnc-WorkSpace-ak-pi-workflow-roles/e4b50c8e-15c7-4c92-9263-959efadb24eb.jsonl`，owner uuid `2f9d4e03-2a51-48d5-b376-f757a4fe8f8e`）
