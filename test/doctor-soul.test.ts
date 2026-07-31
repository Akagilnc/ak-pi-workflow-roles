import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Doctor Soul retains only the factory/evidence/no-bite/simplification judgment kernel", async () => { const soul = await readFile(new URL("../souls/doctor.md", import.meta.url), "utf8"); assert.match(soul, /工厂/); assert.match(soul, /只依据.*证据/); assert.match(soul, /Receipt\/verdict/); assert.match(soul, /无咬人证明/); assert.match(soul, /删除或简化/); });
test("Doctor Soul excludes schema, runtime, scheduling, StatsLine, and host rejection law", async () => { const soul = await readFile(new URL("../souls/doctor.md", import.meta.url), "utf8"); for (const leak of [/ak_doctor_output/, /--ak-role/, /StatsLine/, /一天/, /调度|周期|次数|重试/, /类型错误|测试失败|缺少证据|越权变更/]) assert.doesNotMatch(soul, leak); });
