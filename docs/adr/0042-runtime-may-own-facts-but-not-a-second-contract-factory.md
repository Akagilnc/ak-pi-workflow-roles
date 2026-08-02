# Runtime 可以拥有事实，不能再造第二座契约工厂

Status: accepted（owner 大扫除裁决，2026-08-02）

保留 Reviewer/Collector 的事实归属边界：模型只给判断，runtime 只补它现场掌握的真实结果，避免模型自报运行事实。但不因此保留两套严格格式契约或 runtime 对自己刚生成对象的二次精确校验。

Reviewer 的薄 projection 可保留，删除精确 receipt 壳与重复 validator。Collector 当前 15 字段 receipt、815 行 builder、570 行 validator 及其专属格式测试不自动存活；按真实 consumer 削至必需事实，删除自设大小 fatal 与自生成格式复核。特别理由只支持事实由 runtime 产生，不支持 runtime 成为第二个易炸车间。
