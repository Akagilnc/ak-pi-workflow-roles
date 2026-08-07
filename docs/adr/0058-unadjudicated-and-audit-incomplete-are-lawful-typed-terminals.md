# 未判与审计未完成属合法 typed 终局，退 0

Status: proposed

两种情形均属 [ADR 0052](0052-public-cli-is-the-only-supported-external-role-interface.md) 意义上的合法 typed 终局结果，**退出码 0**：① 记账位缺失、拼错或取值域外（角色已交付输出，只是未判）；② 审计不可用而角色输出完好。

两者均不得静默：「未判」与「审计未完成」必须在终局结果中显式可见。退出码不表达业务成功——调用者不得只看退出码，须读终局结果（[ADR 0010](0010-callers-own-role-composition-and-repetition.md) 的编排权本就在调用者）。角色**根本未交出任何输出**时，仍按 0052 退非零。

词表承接见 CONTEXT.md「未判 / 审计未完成」，以及「三态判词」「编排器」两条同批修订——「未判」不是第四种判词，是本次运行未产生判词。
