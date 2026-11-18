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

### failed-only公共重试与独立审批

`maintenance::retry` 不再让 pending/running/cancelled/succeeded/等待审批等状态借用原Grant新增Assignment或生成no-op成功校验日志；public retry仅接受已完成 `failed` 且没有停止意图的Ticket，沿原Grant/digest、Node/worker/binding生成独立下一Attempt（epoch递增，原历史不改）。已与reconciling、revoke Grant等拒绝场景逐状态比较原Assignment/Report/Artifact/Effect及审计不变。`retry_after_approval` 仅服务现有waiting_approval入口，继续先做source/human审批校验再调用共同签发逻辑，保留合法首Attempt 0→1。它不是任意公开 retry 的审批绕过。Node自身的 `validateAssignment`/admission仍需逐项核对当前作用域，这不是让UI拥有更强的执行权。

正向源码编程样例进一步通过真实Vue点击failed retry后由真实DSH完成下一Attempt，旧失败的diff/test在前后下载保持bytes/hash不变；reconciling在普通Edge的按钮已不可提交，force-click零retry POST，直接后端仍拒绝。整体证据见[真实代码 worker](../../../tmp/loom-failed-retry-evidence-Z3FLpO/result.json)与[普通浏览器证明](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-z9Mzwf/result.json)，而不是把mock状态/禁止按钮当作后端权限保证。

## 用户 UI 撤权 + 两次未领取空poll的补充证据

在普通生产浏览器驱动 `tests/browser/run.mjs --keep-evidence` 内，用户通过权限页精确Grant的确认按钮撤回授权，做的是现有Concierge的真实 `POST /grants/{id}/revoke`，而不是 Node 直接访问管理路由。此 Ticket 已签发 Assignment，却从未被 Node acknowledged；撤权后不调用executor，连续两次原LocalNodeRunner的正常poll通过同一注册身份拿到真实 `assignment:null`。对待原响应只做只读记录、保留认证上下文和返回形状，不把缺轮询或短路包装为空poll当作通过。

同时验证原Assignment/lease_epoch/digest与旧Lease窗口不续、`cancel_requested=false`、reconciling而非自动cancelled、原节点Assignments/completions与outbox不变；全局 `grant.revoked` audit与`action`属于该Grant，不能误制造本Ticket的cancel/report；SQL/HTTP现有 `/audit/verify`链检查成立。临时fail-on-call executor证明任何意外执行不能变成静默通过，随后恢复原来的executor。复用旧Grant的**合法**Ticket请求到达服务器后确实以403 `grant_scope`拒绝，没有增加任务或目标文件。该新增Proof不是代替以下已受理旧source edit停止测试，也不宣称重复revoke幂等、多Grant/multi-host等。原协议、runner与命令分列仍在下面，不应拿这些正常运行结果的围栏混同真正已经在执行的native Agent撤权停止。

[当前十阶段完整真实Edge数据](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-Q86Qf1/result.json)。

## 实际中心的撤权停止帧、旧证据围栏与审计

```sh
node tests/runner/grant-revocation-fence.mjs
```

此入口在真正的 Rust Concierge 上建立注册的 Node、ProjectBinding、Grant与 current Assignment。它先完成实际领取确认（`acknowledged_at`），随后撤销该 Grant，并另外创建24个未领取 Ticket 以超过24条审计记录。严格选择器只向那笔已经 ACK 且尚未 Report 的旧 `edit_file` 提供 `purpose=reconcile` 的停止帧：原始 `grant_version=1`、当前 Grant version=2/revoked_at、精确身份/root/digest及字段完整，不把 `grant_status=false` 当作用户取消。未领取、其他工作类型或不同 immutable work 不得借此开始执行。

- 撤权帧只指导旧的原作业停止/对账，不延长已过期 Lease，不把新 Ticket 视为已执行。中心将 running Ticket 转为 reconciling，`cancel_requested=false` 始终独立持久存在；没有新Grant、Permission、分布新Session或私自Session event。
- 使用真实 HTTP 客户端对原 epoch 的普通 Artifact 与 succeeded Report **实际发出**上传，二者都得到 **409 `outcome_unknown`** 并被隔离。SQL/Artifact/Report/Effect新增数为0；第二笔未领取任务未发生本地或Agent执行。这里的围栏不是检查某个`accepted:true`布尔值。
- 实际 `grant.revoked` 持久审计在 SQL 和 `/api/v1/audit` 都存在，其外层 `evidence` JSON字符串解码后的 `evidence.grant_id` 与该Grant一致，并使用 `old_leases_expired` 表示旧Lease失效。`ticket_id=NULL` 的全局撤权记录不得被误当 ticket.cancel_requested 或 accepted Report。共同的内置Node HTTP读路径还检查33行实际数据与原始 socket响应完全相同，含最 新撤权行，不以假定的24条截断计为完整世界。
- 复核真实grant/revoke**之后**发生的上传拒收，**没有** `report.accepted` 或 `artifact.indexed` 新审计中的另一种历史；旧有权产生的 evidence 不受回溯性销毁。审计链 `valid:true` 与SQLite `integrity_check:ok`也被实测。

这个proof仅覆盖 current active assignment 的中心撤权围栏，**不证明**任意工具/版本的多路执行、真实 Agent 的Cancellation/Harness introspection、移动真机或1 Concierge+3 Worker组合。真实DSH held-verifier的停止、原字节local outbox隔离及重开的对应driver在[CODE_TASK的撤权章节](../harness/CODE_TASK.md#revoking-a-grant-during-an-admitted-edit-separate-from-cancel)分别验证。

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

## 首次预取消与完成回放

```sh
node tests/runner/cancel-before-admission.mjs
node tests/runner/prestart-replay.mjs
```

- 真实Rust中心的 `cancel-before-admission` 直接验证：对合法、还没来过Node的预取消Assignment，先通过具体Grant /node/worker/project root /kind/stop intent核验，然后形成**原assignment与取消完成一起保存**的事实。现在 `execution_started:false`、取消ack和digest在state中可重开恢复，不把先存running误当成实际执行。
- 目前只覆盖受控的 `read_summary`、`edit_file`、`model_descriptor` 文件类工作，root/realpath及worker身份不豁免。dsh不再调用一个假想的`assertApprovedRoot()`；它实际比配`registration.project_roots`。`model_text`、`credential_ref`等仍有各自的placement、binding和scope要求，不在这笔首次预取消支持声明里，也不冒用'未启动SDK调用'创造更强的取消能力。
- 普通执行的过期lease与撤销Grant仍严格拒绝；stop-only分支仅延缓这项允许性判断到取消时，**不延长lease或给未启动Grant新执行权**。无效 expiry格式仍需拒绝。非过去的授权或另一个node/digest/worker的错误不能从取消通道成为允许事项。
- 如果已经有completion或当前promise 数据，则不能冠以新的 never-started；活跃worker 进入真实executor.cancel与Report。Controller 中 active/diverged snapshot 的匹配只在相同授权视角下进行，Grant撤销是停止原先被受理作业的分开投影，不是对新执行的复活。正常执行效果和unknown effect继续保留实际来源。
- `prestart-replay`另以 owned SyntheticCoordinator + LocalFileDispatcher/CoordinatorLoop（**并非DSH Host**）验证，真实center提交首份cancel report后，**再丢弃客户端的响应**，让持久outbox及确实到期后的交付得以复现。同一个取消完成、稳定request/receipt ID在重开后重新交付，中心确实报告 `duplicate:true`，未重新执行file effect，没有自动生成假Artifact。
- 本地rejections按每个assignment/epoch/grant fingerprint保持源幂等性，并在route内部记录work input/context digest。scope/reason/input不匹配时，不允许旧quarantine遮蔽本次真正非法的node、Grant或expiry。terminal去重必须**reason与input_digest全匹配**；旧缺digest的记录不能被用来证明新的scope完全成立，只保留历史并返回`current_context_unverified`，不重发新ack。不扩大Grant，不写中心Schema或伪造Ticket状态。
- 协调器已有pending与adapter.active均为可追踪的在途语境，但不是一个任意Grant赦免。停止前仍需同durable immutable frame；普通任务允许先有preflight.active，之后再做durable admission，不能误用停止分支的history-loss守卫拦住它。已有model binding cancellation恢复为一个producer/cancel/report，与真SDK寄宿验证同时保留。
- **live vs durable**  Check：先读取active，不因durable缺失而让实际上已运行状态获得never-started完成。`durable缺失 + active存在` 必须保留missing-previous隔离。`cancel-active-fence.mjs`与`coordinator-admission.mjs`都在原blocked work里删除durable/recovery，保证零伪造完成，原controller/effect继续按真实历史，不允许仅凭pending Promise 缺失就把已有work说成没执行。
- 合法的never-started回放始终先过完整 `cancellationFence` 和原始work比较，main与vendored都按 `assignment_id/lease_epoch/grant_version`形成和应用恢复摘要。具有相同ID/epoch但修改Grant、内容或path的取消不能越过这条围栏。
- 这些场景不称未知作业取消成立，也不声称已运行操作总能被撤回、SDK callback一定被取消、异常 effects 为零或全局 exactly-once。真实 DSH、Rust/Credential 等由各自独立harness验证。

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
