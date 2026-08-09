# 0065 — 司天第二期：记录只有一个入口

Status: accepted（陛下 2026-08-09 grill 拍定）

所有 Pi session 记录只经司天台的唯一入口落盘，该入口**不收落点参数**——落点由候簿拓扑自己算出，调用方只声明自己是谁的什么，「谁调了谁」复用 [ADR 0047](0047-sitian-phase-one-mechanism-not-role.md) 已有的 correlation；激活层不再校验记录落点，等价校验随入口一并搬进司天台。第一期把「session 直落家」的执法点建在**受理入口**（[ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)/[0049](0049-ledger-is-index-only-zero-content-bytes.md)），于是凡不经那道门的写入者一概不受管——`.ak/work/navigator` 在 0048 accepted 当天晚七小时合入 main、带了六天无人叫（PR #87 → PR #208 才移除），reviewer 子腿与审计子会话同病。

## Considered Options

**在类型层封死 `SessionManager` 的构造能力**：驳回（复杂度不匹配收益）。它挡得住不知情的手滑，挡不住存心——真要犯法时会连断言一起改。守法归立法与角色完善；机械断言至多是附带的手滑保险，不是执法本身。
