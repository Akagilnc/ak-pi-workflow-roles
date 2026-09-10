# Runtime 可以拥有事实，不能再造第二座契约工厂

Status: accepted（authority/provenance: ADR 0019）

> **Supersession / 修订 (#836):** runtime 仍可拥有自己的事实（cost、sitian、pointer、执行账本），但写在角色 payload 旁的独立字段；不再以 projection 替换/缩减角色交卷（代码选 status、通进司与御史台回执代码重拼、注入字段并入 payload 相等校验）删。

保留 Reviewer/Collector 的事实归属边界：模型只给判断，runtime 只补它现场掌握的真实结果，避免模型自报运行事实。但不因此保留两套严格格式契约或 runtime 对自己刚生成对象的二次精确校验。

Reviewer 的薄 projection 可保留，删除精确 receipt 壳与重复 validator。Collector 当前 15 字段 receipt、815 行 builder、570 行 validator 及其专属格式测试不自动存活；按真实 consumer 削至必需事实，删除自设大小 fatal 与自生成格式复核。特别理由只支持事实由 runtime 产生，不支持 runtime 成为第二个易炸车间。
