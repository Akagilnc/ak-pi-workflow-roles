# 全宿主 session 卷宗统一直写司天台

Status: accepted

修正 ADR 0065：二期 session 卷宗收录范围为全部宿主的 session 记录，不分 CLI/宿主。实现必须是直写进该 run 的司天台目录，不设事后归档、搬运或 parallel tee；重申 ADR 0048 直写律。删除受控隔离 home：CLI 用操作员自己的家与凭据，原始会话数据留在 CLI 自己的位置；工厂卷宗以司天台对该 run 的记录为准。
