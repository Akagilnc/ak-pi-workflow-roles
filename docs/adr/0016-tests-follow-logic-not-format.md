# 测试跟逻辑走，不跟格式走

Status: accepted；「每段至多一条真缝 tracer」部分被取代（2026-10-18，owner uuid `d8f0fd9e-e55f-41e8-a261-fe1b48d03382`）：每个对外契约正确、边界、错误三类案，见 `souls/quality-law.md`「测试对行为负责」。

运行时已强制的 shape 校验不写测试；测试只覆盖自写逻辑，每段先过护栏三问，过者至多一条真缝 tracer。
