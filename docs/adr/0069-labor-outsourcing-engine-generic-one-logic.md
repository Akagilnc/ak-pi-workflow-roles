# 0069 — 劳动外包：引擎通用可插拔，治理一套逻辑留在 pi

Status: accepted（陛下 2026-08-15/16 grill 逐项拍定；decision keys 与绑定原话见下；施工 On hold 待 #351 落地）

角色的**劳动段**（最重的推理）可外包给本地 CLI 引擎（cc / codex / cursor / kimi / opencode 等，机上现役 9 台）；**治理面一概不动**——角色 session 仍在 pi 里以 LLM session 运行，外包内容交回同一 session 由它调用既有 typed 交卷工具，票庭 admission、soul、审刑院审计、案卷、navigator 全部原样。不设第二条交卷/校验路径：今后加审刑院、门下省输入检验等，全走同一套逻辑。**形状一句话：在现有流程的「干活」一步造一条岔路，干完回主路，别的什么都不变。**

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `capability` | `engine-generic` | 「这个能力应该是通用的。不存在kimi好了 opus调用不了这个事情。要做成通用的」 |
| `receipt-path` | `in-session-one-logic` | 「肯定是llm 啊。对比现在最小改动。只是把最重的部分外包。别的都和现在完全一样。以后加任何审刑院，或者以后的门下省的输入检验。都是一套逻辑。没有两套逻辑」 |
| `mvp` | `judge-x-kimi` | 「大理寺kimi」「mvp先解决大理寺就行了」「目前先实现最重的大理寺」 |
| `second` | `fixer-x-cursor-grok4.5` | 「coder/fixer 的 cursor grok4.5」「第二步应该是第二重的修内司」 |
| `engine-authority` | `pool-directive-owner-only` | 「对。和模型一个道理。」（引擎=池令新轴，唯一真源=owner 现役令） |
| `hang-discipline` | `defer-until-real-case` | 「外部cli hang的概率只怕非常小哦。我觉得遇到真实案例再说」 |
| `shape` | `detour-rejoins-main-road` | 「说白了就是在现有流程。干活这部分造一条岔路，最终回主路。别给我搞复杂了」 |
| `motivation` | `subscription-arbitrage-and-auth-decoupling` | 「外包模式如果可行。就不用依赖pi自己的登陆了。角色本身依赖但是干活可以给别人。我本机上这么多cli。不用白不用」（provider-auth 缺口实证=#351 的 kimi OAuth 尸检） |

## 排他

- 已议决弃用：MCP 桥交卷（引擎直调 pi 工具）与确定性文件契约——两者都会在治理面外生出第二条提交/校验路径，违 `receipt-path` 一套逻辑。
- 施工顺位：On hold 待 #351（kimi keepalive）落地验证后启动（「这个事情解决再来说352」）；追踪票 #352。
