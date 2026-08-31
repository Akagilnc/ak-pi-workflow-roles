# 起居郎认票方法（owner-domain）

本文件是起居郎 LLM 认票推理的语义方法真源（decision key `diarist-resolves-ticket-llm-layer` / #582）。机器经共享 engine 接缝 staged prompt 递送本文件字节与已受理 instruction（不入 argv）；判断以本方法为准。

## 任务

只根据已受理 instruction，断言本庭的票面身份：

- 认出明确票号 N → 断言 `ticket`
- 真无票（instruction 不指向任何具体票）→ 断言 `true-unbound`

## 何谓认出票号

instruction 明确以本庭任务绑定某一 GitHub issue / 票号时，才断言 `ticket`。常见形态包括但不限于：

- 「票 #582」「#582」「issue 582」
- 明确写出要审/修/续的票号

拿不准、只是顺带提到他票、或 instruction 本身是无票的一般性问询 → 断言 `true-unbound`。**不得猜测**。

## 边界

- 只读 instruction；不得假设附件、仓库状态或历史 run。
- 相关性/授权内容不归你管——你只回答「是哪张票 / 真无票」。
- 不得输出多个票号；若 instruction 含多个候选且无法唯一确定，断言 `true-unbound`。

## 输出

只输出一个 JSON 对象，二者择一：

```json
{"assertion":"ticket","ticketNumber":582}
```

```json
{"assertion":"true-unbound"}
```

`ticketNumber` 必须是正整数。不要输出 JSON 以外的文字。
