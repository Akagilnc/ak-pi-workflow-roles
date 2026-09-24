# 交卷 schema 不把格式当拒收权

Status: accepted

审核交卷 schema 是一个对象，不是根级 anyOf：Codex 结构化输出要求根节点为 object。status 在场时是三态枚举，但不是 schema 必填，因此真实基础设施失败声明可以不带审核 status。这不是审核结论，也不把失败伪作三态。其余字段保留声明与 description、不必填，顶层允许额外属性。声明不是包侧校验授权：包不因格式拒收或判死；判别字段没填或读不出时只说读不出并附收到的值，不在代码里写状态名。key 名字不必逐字相同，合不合格由审刑院按是否读得懂来判。（#1055。三态枚举：源卷 d634a8d9。无 status 失败例外：源卷 e4b50c8e-15c7-4c92-9263-959efadb24eb.jsonl，owner uuid 06da83bf-325e-4755-9373-9a4141de0f12、2ebd8a3c-2482-4a28-a429-1ea0592283ec。根节点须为 object：[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)）
