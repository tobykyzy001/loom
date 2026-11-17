# Durable LocalNode admission and replay verification

这些入口分别检验**节点本地的入场围栏、取消、持久完成和外发回执**，不是另一个中心权威，也不是完整 M0、数据库或多机验收。不会读取当前 desktop/DSH Profile、系统 Credential Store、真实用户项目、生产 token 或收费模型。

## 确定性文件与状态场景

```sh
node --test packages/node-client/test/*.test.js
node --test plugins/dsh-loom/test/*.test.js
node tests/runner/durable-fence.mjs
node tests/runner/cancel-active-fence.mjs
node tests/runner/coordinator-admission.mjs
```

- `durable-fence` 对主 TypeScript 与 vendored runner 创建各自的私有 temporary root，实际注册、读取项目并上传 Artifact；随后用真正的 `NodeIdentity.open`、`NodeState.open` 读回文件。重开后的合法重复、旧 epoch、变化的 Grant digest、409 核销隔离和原始有效证据恢复均逐项断言，执行器仍仅调用一次。
- `cancel-active-fence` 覆盖正在运行/已完成的作业，包括伪造 digest、路径、内容、旧 epoch、未知本地 Assignment、取消期间历史分叉和撤销 Grant 后停止已认领的工作。非法停止不会 abort controller、覆盖历史或创建普通 Report；本来已接受的工作仍可停止。实际效果已完成而停止请求才到达时，结果必须保持 unknown/reconcilable，不能冒充从未发生过。
- `coordinator-admission` 使用 **SyntheticCoordinator**（不是 Rust Concierge 或 SDK 证明），验证 LocalFileDispatcher、DshDispatcher 及 CoordinatorLoop 的同一入场边界和重启后不回发的核销记录。它还检查一个 fixed producer 返回的完整 Artifact/unknown-effect 结构已在 `once()` 的完成提交时持久化，再重新打开后不需要第二次 producer 才能上报。该 producer 并不是 DSH Agent/Tool。

这些场景使用临时 owned inputs、真实本地文件读写和受限返回数据。新进程/新 runner 重开同一 Native State 不等于 `kill -9` 发生在 DSH Tool 投入外部效果的精确时刻，也不是一中心三工作者 Compose。

## 边界与持久格式

- Assignment 的 ID、Ticket 关联、kind、path/content 等**工作输入**保持冻结；epoch 不可倒退，Grant digest 必须精确匹配。尚未写入合法 assignment 前，不能借 `duplicate_active` 和进程内空白 map 接受任务。`sameAuthorizedAssignment` 比较所保存的 JSON 形状，显式允许的本地派生 Grant ID/version 不会制造漂移。
- `lease_expires_at` 是**当前授权时间窗**，不是 work content。Controller 可停止旧交付并改变它；普通执行仍要求当前 Lease 未过期，停止已确认工作的取消请求不因此消失。撤销当前 Grant 不允许开始新执行，但可停止先前已接受的任务。不能将取消信号当作新的 Grant。
- 取消需要匹配的已接受 Assignment；未知/foreign assignment 不会被添进历史。不通过一次拒绝 ack，给 Task 写入 failed/succeeded/ignored 的报告。控制权核销是独立的 receipt 事实，不等于批准新 Grant、任务终态或 Effect。
- 私有 NodeState 增加可选的 keyed-object `rejections`，包括 `loom.local-rejection.v1`、按 assignment ID/epoch/grant digest 得出的 fingerprint 与核销结果。它不属于中央 Ticket/Grant/Artifact 权限。2xx 且明确接受的确认与 quarantined HTTP 拒绝、pending retry、未尝试分别记录；永不伪造缺失 Ticket 的 UUID。相同持久指纹不会反复发送已确定终止的核销。
- `once()` 在 callback 之前拒绝缺失/不同的 input digest。本次工作形成的 pending digest 和 assignment id 也合并到正常完成、异常完成及 pre-start cancellation 中；不清楚的外部效果仍为 unknown。旧文件里缺这些证据的记录不会被当作可验证回放或擅自重新执行。
- Report/Artifact 的 `request_id` 由其**排除 request_id 后的完整逻辑内容**决定，等于保存的 logical digest（64-hex receipt ID）。同一 immutable payload 在丢失 HTTP 响应后仍可复用原 receipt；改变 payload、字节、metadata、case 或状态不能冒充同一个 receipt。原 Artifact UUID、bytes、SHA、Effect ID/lineage 都是独立事实，不以 receipt 哈希代替。
- DSH dispatcher 在真实 operation 返回后、完成提交**内部**归一化 Artifact ID/metadata/effects，避免先落到不完整的完成记录再补水。JSON 文件的逐一重开和 Reports 的空壳重建不等同对所有历史版本的具体效果自动恢复，也不等同精确 crashpoint 验收。

## 实际 Rust 中心的丢失响应回放

```sh
node tests/runner/real-receipt-replay.mjs
```

本入口使用 **真正的 Rust Concierge** 与一个实际注册的 Node、项目绑定、Grant 和 Assignment，产生一次真实 controlled file effect。尚未修改 transport 实现；仅 driver 的注入 fetch 在收到真实 HTTP 200 之后隐藏响应。它随后：

1. 独立从中心 API 和 owned SQLite 验证第一次 Artifact/Report commit 与原始 receipt 确实发生；
2. 等真实持久 retry backoff，读回真实 NodeState、identity 和原始 pending outbox；
3. 以相同 request ID、logical digest、body、bytes 和 SHA 重放；中心分别返回 Artifact `duplicate:true` 与带原 receipt 的 Report `duplicate:true`；
4. 确认执行器仍仅调用一次，目标文件 hash、大小、inode 和时间戳保持；
5. 确认中心仍仅有一条 Artifact、Report、Effect、对应 request receipt/验收 audit，且 audit chain 验证通过。

这是本机单节点 **at-least-once + 对账** 的具体证据，不是物理远程、TLS、DSH SDK、Compose 或跨平台 exactly-once。实际 DSH 宿主的 install/register/Agent Tool/cancel/resume 与 scoped credential broker 仍各自通过 [../harness/EVIDENCE.md](../harness/EVIDENCE.md) 中的独立真实验收。
