# 司天第二期：session 记录只有一个入口

Status: accepted

记录归司天台；Pi session 记录只经司天台唯一入口落盘，该入口不收落点参数，落点由候簿拓扑算出，调用方只声明自己是谁的什么，「谁调了谁」复用 ADR 0047 correlation。激活层不再校验记录落点，等价校验随入口搬进司天台；执法靠立法与角色完善，不以类型层封死 SessionManager 构造。二期范围后经 ADR 0075/0077 扩展，历史正文不回改。

## Considered Options

在类型层封死 SessionManager 构造能力——驳回，复杂且挡不住存心。
