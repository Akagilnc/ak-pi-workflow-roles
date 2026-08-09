# 0065 — 司天第二期：session 记录只有一个入口

Status: accepted（陛下 2026-08-09 grill 逐项拍定；decision keys 与绑定原话见下）

**Pi session 记录**只经司天台的唯一入口落盘，该入口不收落点参数——落点由候簿拓扑自己算出，调用方只声明自己是谁的什么，「谁调了谁」复用 [ADR 0047](0047-sitian-phase-one-mechanism-not-role.md) 已有的 correlation；激活层不再校验记录落点，等价校验随入口一并搬进司天台。第一期把「session 直落家」的执法点建在**受理入口**（[ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)/[0049](0049-ledger-is-index-only-zero-content-bytes.md)），于是凡不经那道门的写入者一概不受管——`.ak/work/navigator` 在 0048 accepted 当天晚七小时四十五分合入 main、带了六天无人叫（`ac759b83` → PR #87 → PR #208 才移除），reviewer 子腿与审计子会话同病。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `records-owner` | `sitian` | 「司天台就是记录的」「这就是司天台该有的职责啊。司天台最重要的。记录和生成高阶数据」 |
| `record-entry` | `single-entry-no-destination-parameter` | 「只是现在要统一入口。而不是同一个逻辑。写在不同的地方」「按理说调用同一个函数就不可能有不同的行为啊」 |
| `record-scope-phase-two` | `pi-session-records-only` | 「session 的记录。也就是 pi 提供的账本」「先把记录做好。记录都还没做好。生成什么高阶？」 |
| `caller-identity` | `reuse-adr-0047-correlation` | 「A 嘛」（就「谁调了谁写在哪：复用 ADR 0047 correlation / 新加 caller 字段」二选一作答） |
| `activation-check` | `move-into-record-entry` | 「C 可以」（删掉激活层那道检查，等价校验移进记录入口） |
| `enforcement` | `legislation-not-type-sealing` | 「我觉得 A 就够了。后面就是完善角色的问题了。之前立法做的不好。漏了不少东西」「主要是 B 你搞的很复杂。收益就那样吧」 |
| `visibility-gate` | `unignore-ak-work` | 「把 .ak/work 去掉 .gitignore 不就行了？」 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## Considered Options

**在类型层封死 `SessionManager` 的构造能力**：驳回。陛下原话「主要是 B 你搞的很复杂。收益就那样吧」。它挡得住不知情的手滑，挡不住存心——陛下并指出「真要犯法的时候它会改测试」。守法归立法与角色完善；机械断言至多是附带的手滑保险，不是执法本身。
