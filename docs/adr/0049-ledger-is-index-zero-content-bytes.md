# 账本只做索引：第一期零内容字节

Status: accepted

session 对誊本内容是正本；派发/激活事实以产生它的那一面为正本；第一期账本只含 correlation 键、非内容派发事实与正本指针，零内容字节。存根哑 append 零校验，append 失败是基础设施失败而非格式拒收。

## Amendment — 无模型 run 不伪造誊本

无模型 run 没有宿主誊本；共享生命周期以 typed 卷宗主体记录其身份。空文件不得冒充 session 正本，也不得作为 principal 可续性的依据。
