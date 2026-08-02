# 路径圈界只留在真实读写接缝

Status: accepted（owner 大扫除裁决，2026-08-02）

作为 ADR 0036 的保留例外，路径圈界只在真正执行文件读取或写入的接缝保留：Doctor 病例读取、Reviewer 仓库材料读取、Merger 授权 resolution scope 等不得逃出获授权范围。

特别理由：越界会静默读取或修改票外文件，后果重且无可靠下游兜底。proposal、packet、schema 等上游层的重复路径格式校验全部删除，不维持多层同构护栏。
