# 交卷 schema 不把格式当拒收权

Status: accepted

交卷工具 schema 保留字段声明与 description；非审核席维持零 required（含记账位）、顶层开放额外属性的原决定。审核席的判别字段 status 则为三态枚举且必填，没有省略 status 的失败例外。审核席仍能交卷、而完成审核所需的外部依赖发生真实基础设施失败时，status 取上呈值，失败细节写入既有 infrastructureFailure；这不是放行或封驳。执行或宿主已失败、审核席无法交卷时，仍由宿主如实失败终局。

包侧收卷：审核席除判别字段外，其余字段不必填、不限制，允许额外属性；声明不是包侧校验授权，包不因格式拒收或判死；判别字段没填或读不出时只说读不出并附收到的值，不在重交提示里另写一套状态名。key 名字不必逐字相同，合不合格由审刑院按是否读得懂来判。

宿主生成端：使用宿主原生能力；Codex strict 结构化输出要求根节点为 object、对象关闭额外属性，不能以该出口承诺模型可生成未声明字段。此项宿主缺口如实报告，不另造适配层或出口；生成端的限制不变成包侧拒收权。（#1055。三态枚举必填并撤销无 status 例外：源卷 e4b50c8e-15c7-4c92-9263-959efadb24eb.jsonl，owner uuid ddff7ae0-0b1e-44eb-b80c-96d2a3d3d239、0ddc3a4e-9a53-4565-b1cc-7ba3471d11e5、1707c6ec-ac17-4876-97d1-73b57c734259。根节点须为 object：[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)）
