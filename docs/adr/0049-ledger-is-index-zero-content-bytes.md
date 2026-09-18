# 账本只做索引：零内容字节

Status: accepted

session 对誊本内容是正本；记录与索引只含指针与索引性字段，零内容字节。#855 删除两面对账后，派发/激活存根与 correlation 对账键不再是第一期账本内容；幽灵报出只列索引性事实（runId、run-state、lease 核查结果），不复制内容。
