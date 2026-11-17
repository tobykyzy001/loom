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

## 有界 HTTP 响应流与停止唤醒

```sh
node tests/runner/http-stream.mjs
node tests/runner/http-socket-stream.mjs
```

公共与 vendored `LoomHttpClient` 使用标准的 `response.body.getReader()` 做分块读取，在合并还原 JSON 之前按**实际收到的字节**限制响应体积（默认 1 MiB，允许显式非负安全整数）。超限所在 chunk 不被 append，reader 随即被 cancel：`Content-Length` 不参与安全判定，低报 headers 不能豁免。也涵盖恰好达到上限的消息、逐字节拆开的 UTF-8、非法 chunk，以及没有 stream 的旧 `arrayBuffer` fixture 的兼容路径。后带兜底路径仍需先取得整段再拒绝超限，不是所有响应类型都可由该 helper 提前分配限额。

- **唤醒而非仅发取消信号**：每个挂起的 `reader.read()` 都与既有 AbortController 竞争，分别处理 caller stop 和总 timeout，不把 body read 的恒 pending Promise 变成永活请求。外部取消原因统一优先；普通网络/JSON/status error不被错转成取消或未知副作用。没有每个 chunk 重置 deadline。
- `reader.cancel()` 失败或永不完成时，不能覆盖主要错误或再次永久挂住 cleanup。内部 Abort 亦向底层 fetch 传播，但没有将已经产生的网络请求/副作用说成取消完成或回滚。每个失败尝试只发起一次 reader cancel，绝不宣称全局 exactly-once delivery。
- 连续零字节 chunk 不计入 JSON payload，但步骤会让出事件循环，避免总 timeout 的微任务饥饿。前置中止不会把整段文档再读出来；多字节字符只在受限合并后统一 UTF-8 decode。
- **实例范围的 socket 证明**：`http-socket-stream` 在 owned 的 `127.0.0.1` 随机端口上，实际接收 Node fetch 的 HTTP response。起点缺失的 JSON 与多次分叉的partial payload不会被接收；正常 JSON、cap 拒绝、caller cancel 和超时均分别等待真正 server close，而不仅观察一个返回 error。该 fixture 独占各自 server 并在换用下一个 probe 前清理旧 listener；`server.listening` 必须为 false，自有 sockets 必须清空，CLI 应自然退出。

这些测试不证明远端有序取消得到保证，也不证明对所有上游都有绝对最大分配或停机保证、物理远程、TLS、多 Host 或 Live LLM。真实 Agent 调用、取消和恢复、receipt replay 与固定 SDK 模型测试仍分别实测，不由本地 synthetic socket 证明替代。

## 节点启动中止与凭据恢复

```sh
node tests/runner/startup-cancellation.mjs
```

- 两层 `LocalNodeRunner.start/create` 将可选 `AbortSignal` 延续至既有 enroll 和首次 heartbeat。主包的 `create` 还补齐 `fetch` 传递；vendored 的创建路径同样保留自身 profile/timeout 注入，不能因 mock 未透传而不慎回落到全局 fetch。
- `NodeIdentity.readEnrollment` 在读取已持久 token 前，共用于原 `open` 的 public hash/PKCS#8 验证；损坏的身份不再简化为“缺少enrollment code”。如果本就不存在身份或已预先取消，启动不会擅自生成新私钥/身份文件。中途观察到取消后，阻止后续 state、注册、heartbeat 和 Coordinator；已经开始的原子文件写入不能被假装回滚。
- 真正的注册token若已被中心接受并保存，取消只中止尚未进行的后续启动，不删除或冒称撤销该事实。原生 test 在实际 `setToken` 保存之后取消；在两个 owned Rust Concierge 上都查到其真实注册，重新启动使用相同的 Node/Installation 与凭据并成为在线 Node，不新增注册或工作。
- vendored `createClient` 和 `runLocalDshPlugin` 的**可选 lifecycle 参数**仅用于显式 caller 的启动中止。pending model catalog 不必须支持底层取消；等待可结束但不得继续启动轮询，且真正五个第二超时仍是对应的 observation-expiry，不对任意错误统一贴取消标签。非正在启动的现成 Coordinator 仍通过 `loop.dispose()`。
- 该可选 signal **没有**塞入配置 schema，也不伪造 DSH `ctx.effect` 的全局取消契约。完整 DS Host 的常规 install、worker task/cancel/resume仍由 [real-lifecycle 入口](../harness/real-lifecycle.mjs)独立验证。无新 Grant、Artifact、Report或主管端“注册撤销”被发明。

此专项还覆盖预检/identity/state 的真实中点等待，以及 timeout和后续caller stop的区分。多次计时误导（漏传signal/fetch、raw public key缺 SPKI包装、5秒未ref定时器退出）均作为量具问题修正，不以撤销断言或删除负例试出PASS；只由自然退出与每个实际的中央响应/保存形态认证证据。

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
