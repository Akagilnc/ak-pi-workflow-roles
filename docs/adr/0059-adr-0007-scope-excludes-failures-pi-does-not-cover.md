# ADR 0007 的射程限于 Pi 已覆盖的失败类别

Status: accepted

ADR 0007「传输/调用层重试复用 Pi」的射程为 Pi 已覆盖的失败类别。StreamIdleTimeoutError 不在 Pi 错误路径重试覆盖内，故包内保留唯一一层 idle 重交；仅该错误触发、不叠第二层，重试用尽仍须如实落痕。这不是通用重试授权。
