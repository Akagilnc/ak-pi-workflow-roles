# 闸②在交卷处打回重写，包不再往被服务仓库装 git 钩子

Status: accepted

闸②（缺平台前缀）改到与闸①同一交卷接缝做一次软提醒 typed 打回，同 run 再交视为确认；包不再向被服务仓库安装钩子或写任何 git 配置，消费者仓零侵入。对可可靠观察的提交集合读标题判定前缀：baseline 为 tip SHA 时取 baseline 至 HEAD 开区间，baseline 为 null（unborn）时取 HEAD 可达全链；中途换分支、reset、baseline 非祖先等不可靠窗口本闸不追；闸④机器强制删除，纪律归宪法与大理寺看卷。升级后首次经 worker 接缝时，对可发现范围做私有一次性幂等卸载本包钩子痕迹，不回滚 worktreeConfig，不恢复曾被覆盖的用户 hooksPath；具名修订 ADR 0066 中闸②承载与闸④机器实现，不 supersede ADR 0048/0055。
