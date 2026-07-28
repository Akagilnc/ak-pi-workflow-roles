# 0002 — Package-first 三步路线

Status: accepted
Date: 2026-07-27

第一步:本包做到 standalone 完成——任意 session 不依赖编排器即可直接调用角色。第二步:现有 ak-workflow-orchestrator 把现役 Action 一次性接入包角色调用,自身的 soul 装载与交卷机器随之退役、大幅简化。真正的 `@ak/workflow-orchestrator` package 后置:线路稳定之后,一条线路一条线路加上去。
