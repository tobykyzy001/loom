# Implementation memory

这里记录**后续开发和调试可复用的经验**，不是逐次提交的流水账，也不是当前进度、协议或测试结果的权威来源。原文及当时的提交、测试数量和临时证据路径可由 Git 历史追溯；本文件不复制这些信息。

## 1. 文件边界与使用约定

- 产品目的与平台角色看 [vision.md](vision.md)，长期架构看 [architecture.md](architecture.md)，当前里程碑和优先级看 [roadmap.md](roadmap.md)，当前已验证范围与缺口看 [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。
- 某项能力是否完成，只以对应专项文档、真实测试报告和实际场景验收为依据。历史 PASS、编译成功、单元 mock、HTTP 200 或局部状态名均不能升级成里程碑完成。
- 本文件只保留“问题 → 根因 → 修复原则 → 证据入口”，避免重复复制协议、全部负例、运行日志和临时路径。若专项文档与本文件冲突，先核对代码与专项文档，再修正本索引。
- 新经验按领域追加或替换旧条目，通常每条不超过一段。不要按每次提交另开长章节；不要在文末重复“尚未完成 M0”“没有真机”“没有 exactly-once”等通用限定。
- 当时的开发采用主 Agent 集成、专项子 Agent 实现/审查和增量提交。子 Agent 报告与 reviewer ACCEPT 只是输入，主 Agent 仍需检查最终差异、运行入口并确认进程退出。曾经不完整的 Pipeline 与 Unknown 对账原型被回退，不作为已实现能力。
- 用户最初要求逐步推进完整路线图并保存问题/解决方案记忆，明确暂缓固定的 **1 Concierge + 3 Node Compose**；先验证单节点、确定性流程和真实宿主。未显式报告的本地提交不等于已推送。
- **最近复盘发现的主要流程问题：** 过早横向扩展模型、安装、Skill、多机等局部能力，M0 场景验收却未及时收口；每个小切片持续追加加固和文档，也造成上下文/token 浪费。恢复工作时应先列当前里程碑的剩余场景与阻塞，再选择最小增量，而不是继续按技术名词扩张。

## 2. 不可丢的事实与安全口径

- Agent、Host、Worker、Project、Chat 是不同对象；注册、能力发现、安装、激活都不产生 Grant。移动端默认只是 Client，不因“移动 Agent”的话题额外创造常驻 Harness。
- Ticket、Assignment、Grant、Lease、Report、Effect、Artifact、Source 事件和显示偏好必须分开。ACK 是受理回执，不是任务完成、内容已读、取消确认或外部副作用证明。
- 中心是权威，单写者 SQLite/WAL/事务只保护中心及其数据库事务，不能把 Host 外部效果纳入全局原子事务。外部副作用按 **at-least-once + 对账**，Unknown 不得改写成 Failed、无效果、成功回滚或安全重试。
- Grant 与 Lease 在输入、认领、执行、重放、读取和副作用前分别核实现状。旧 Assignment ID、Ticket 引用、Session UUID、Source ID、Artifact UUID、Capability、Token 或摘要均不能独立成为权限。
- 原始消息/意图、当前权限视图、不可变工作输入和运行期活动状态不可混用。已合法认领的旧工作可能允许停止或对账，但撤权不能复活新执行，撤权也不等同于用户取消。
- 失败测试、确认存在的文件 Effect、工具/传输错误、取消意图和中心回执是独立事实。测试失败但源码已改可以保留 failed Report + confirmed Effect；工具修改后报错必须保留 Unknown/对账。
- Artifact 的内容、uuid、origin、hash、size、parent/lineage、存储位置和公开证据分别核验。公开投影不能泄露 prompt、私有 metadata、env、transcript、tool arguments、Secret 或任意路径。
- 测试只使用自有临时 Profile、项目、凭据、loopback 和确定性 fixture；不得读取/修改当前 `desktop` DSH Profile、真实用户项目、系统 Credential Store、其他机器或全局插件。真实计费模型需明确配置，不能用 Stub 代替 Live LLM 证据。
- 桌面浏览器、390px CSS viewport、浏览器进程关闭重开、Service Worker 静态壳和 `setOffline` 都不是 iOS/Android 真机锁屏、杀进程或切网验证。
- 失败的原型、早期 draft、修复前观测与之后 PASS 必须分开。不要为了“通过”删除旧负例、放宽权限、修改输入或把量具错误包装成产品修复。

## 3. 权威证据入口

当前入口和精确限制以相应文档为准；以下仅作索引。

| 领域 | 阅读与运行入口 |
| --- | --- |
| 基础真实链路与 Bare Host | [BASELINE.md](BASELINE.md)、[BARE_PACKAGE.md](docs/BARE_PACKAGE.md)、`scripts/bare-integration.mjs`、`scripts/bare-package-smoke.mjs` |
| 协议、数据模型和一般测试策略 | [testing.md](testing.md)、`crates/protocol`、`crates/concierge` |
| LocalNode 入场、注册、ACK、事件、撤权、优先级和恢复 | [tests/runner/README.md](tests/runner/README.md) |
| DSH 宿主、真实生命周期与通用证据 | [tests/harness/EVIDENCE.md](tests/harness/EVIDENCE.md)、`tests/harness/real-lifecycle.mjs` |
| 真实受限读取的公开投影和敏感过程验收 | [tests/harness/SENSITIVE_READ.md](tests/harness/SENSITIVE_READ.md)、`node tests/harness/sensitive-read.mjs` |
| 受限源码修改、diff/test、停止、撤权、Unknown 和重试 | [CODE_TASK.md](tests/harness/CODE_TASK.md)、`node tests/harness/real-code-task.mjs` |
| DSH 普通 ACK 丢失、持久出箱和真实 Host 重开 | [ACK_REPLAY.md](tests/harness/ACK_REPLAY.md)、`tests/harness/ack-replay.mjs` |
| Source 接收、显式授权工作、审批和 Source Web | [tests/sources/README.md](tests/sources/README.md)、`events.mjs`、`authorized-ticket.mjs`、`browser.mjs` |
| 普通 Web、Artifact、显示偏好、断连、PWA 静态壳和 Installation UI | [tests/browser/README.md](tests/browser/README.md) |
| MemoryCandidate、显式 Memory 来源/编辑/删除和审阅 | [tests/observations/README.md](tests/observations/README.md) |
| Skill 回放与人工接受 | [tests/skills/README.md](tests/skills/README.md)、`read-replay.mjs` |
| 父子 Agent 委派与受验证的 Session 关系 | [DELEGATION.md](tests/harness/DELEGATION.md)、`real-delegation.mjs` |
| 受限文档 Pipeline | [tests/pipeline/README.md](tests/pipeline/README.md)、`scripts/document-pipeline.mjs` |
| Project/Git 事实 | [tests/projects/README.md](tests/projects/README.md) |
| 硬件与 Project/Fleet observation | [tests/inventory/README.md](tests/inventory/README.md) |
| 模型目录、descriptor、授权 placement 与固定 adapter | [tests/model-inventory/README.md](tests/model-inventory/README.md)、[tests/models/README.md](tests/models/README.md)、[MODEL_TEXT.md](tests/harness/MODEL_TEXT.md)、[MODEL_BINDING.md](tests/harness/MODEL_BINDING.md) |
| 合成 Credential 元数据和 Unknown | [CREDENTIAL_REF.md](tests/harness/CREDENTIAL_REF.md) |
| 同机小 Artifact 直接交接 | [tests/direct/README.md](tests/direct/README.md) |
| 合成安装计划和 Bare 包边界 | [tests/install/README.md](tests/install/README.md)、[BUNDLE_PREFLIGHT.md](tests/harness/BUNDLE_PREFLIGHT.md)、[BUNDLE_LIFECYCLE.md](tests/harness/BUNDLE_LIFECYCLE.md) |

## 4. 编程、验证和测试方法


### 4.1 先界定事实，再修代码

1. 从真实入口复现，保存“实际请求/响应、数据库/文件事实、错误类别与作用域”；再写最小修复，而不是先设想一个通用框架。
2. 正向、负向都要有正确原因：例如撤权负例必须拥有同 Worker、同 Grant 和合法原始 Assignment，不能因为缺 Node、空路径、错误 Worker 或伪请求早退后宣称权限有效。
3. 断言最终事实和不变量：执行器真实调用次数、Agent/Session/Tool 身份、文件 bytes、独立 SHA、Ticket/Assignment/Report/Effect/Artifact 关联、审计链与重开后状态；不能只看 `accepted`、`duplicate` 或 PASS 文本。
4. 后台 job、服务、浏览器、定时器未退出会掩盖 waits、清理和重试缺陷；完成测试时实际关闭 owned child/listener/context，并保留真正的退出码。
5. 子 Agent 修改并发写入时，先审查半成品再集成。发现未完成的 UUID/权限转换、null 占位、多层 adapter 或未验证恢复模型，应小范围回退草稿，不扩大框架掩盖它。

### 4.2 量具本身也会被误导

- 关闭/恢复服务时沿用旧 admin token、旧 URL 或 stale `target/debug/loom`，会让结果无意义。当前 fixture 默认重建二进制，显式 binary override 则由调用者负责来源。
- 检查脚本是否存在、其真实参数、实际运行目录、语法与退出状态。错路径、EISDIR、未 await 的响应、typo、空 negative 数组、空测试集和只打印局部 `passed` 都不能计入 PASS。
- mock 的形状要和真实 SDK/API 对齐：`ctx.agents.create({ setup })` 中 setup 得到实际 scoped Agent context；`ctx.llm.prepareCall` 接受 `{provider, model}` 并返回调用的 metadata/stream。目录查询不等于真实生成，公开 Session/tool 记录不能被另造的 event 代替。
- 对比真实响应，而非假定别名：Artifact index 可用 `id`，下载 envelope 是 `{artifact, content}`；`assignment_id` 常在 `downloaded.artifact` 内。Effect/Report evidence 常是字符串化 JSON；SQLite row 可能是 null-prototype 对象；audit body 的 Grant 身份曾需要读取 `row.evidence.evidence.grant_id`。
- `waitFor`/`waitForFunction` 返回 Promise 和 truthy 句柄，不代表条件为真。Playwright 的 async predicate 会被作为 truthy Promise 提前接受；应在 Node 侧限时读取 `page.evaluate(async …)` 的明确布尔值。`caches.open` 会创建空桶，验证缓存需读回原 bytes/hash，而非只看名字/keys。
- 外部测试 SQLite 连接的 `TEMP TRIGGER` 不影响服务端连接；需要原子回滚证据时，应使用自有的真实数据库中、对服务端实际连接可见的持久 trigger，最后在 `finally` 只移除该 fixture trigger。
- 对比 fingerprint/digest 前，先冻结原始输入。把已人工编辑的 MemoryCandidate 文本当作原始 observation 会生成另一个 observation group；原始 observation 群、候选人的编辑版本和后来 source_refs 必须区分。
- 修测试不等于减弱测试。若计数器 spy 自己把一次执行计为两次，应修计数器；若输入太早被错误路径、无效 installation 或不支持的 HTTP method 拒绝，应修 fixture 使它到达目标分支；不要改成任意 4xx 都算通过。
- 浏览器复制一行的 `innerText` 不能证明折叠 details 已打开；真正 pointer hit-test、modal 可见性与按钮可操作性需实际验证，键盘绕过不等于修复了遮挡。
- 截图、报告和 manifest 要绑定当前源/driver。仅写路径没有实际产物不算证据；临时资源可清理，但不能声称仍保留已删除的图或结果。
- 消息/事件回执不能吞冲突：`/nodes/events` 曾因 `INSERT OR IGNORE` 对已存在的请求仍返回 accepted，变化的事件被悄悄丢弃。现在消息与 `(node, route, request_id)` receipt 同事务，逻辑 digest 使用与客户端相同的 `canonical({logical_fields:body_without_request_id})` 包装；重放比对完整身份、message/request 关联及原始内容，坏 receipt 明确冲突。opaque request ID 不是 digest/Grant，legacy 只能有限匹配，不能回填虚构证据。Node event replay 也不等于 DSH SDK 执行。

## 5. 按领域保留的问题与修复原则

### 5.1 权威、注册、绑定和授权生命周期

- **Bad enroll 曾消耗合法 code：** 初始实现把 enrollment code 消费、签名验证、Node 写入和 audit 拆开，错误签名可让后续合法注册失败。现有原则是用同一 Store 连接/Immediate 事务完成 challenge/code、身份/token 与 audit，合法 rotation、撤销和另一 Installation 都走独立围栏。入口：[registration-atomic.mjs](tests/runner/registration-atomic.mjs)。
- **Installation 混写与错绑：** 同 public Node key 下两条 Installation 曾互相覆盖 heartbeat；绑定又曾取第一条记录，且 Binding 与 audit 可分两次提交。心跳和绑定必须精确到 `(node_id, installation_id)`，多个有效安装时要求明确选择，绑定与审批 audit 原子提交。入口：[runner README](tests/runner/README.md)、[installation-ui.mjs](tests/browser/installation-ui.mjs)。
- **同一 Node 多安装不等于多 Host：** 两条逻辑 Installation、独立签名/token/root/Worker 只证明身份与选择，不是第二物理机、独立 DSH Profile 或逐 Installation 管理撤权能力。SQL 中手动给一行 revoked 只是负例。
- **嵌套 modal 挡住真正确认：** Installation 绑定表单的遮罩层曾覆盖二次确认。保留表单但 inert/aria-hidden，且确认层高于原 modal；真实桌面/390px pointer hit-test 才可证明修复，不要只测 payload 或改用 Enter 绕过。
- **撤权幂等和补偿帧：** 重复 revoke 曾增加到 v3 并让原本允许的 v2 reconcile 帧消失。现在重复读取原时间/版本并 `duplicate:true`，不加 audit/不续租；合法原 Assignment 的补偿资格仍需精确 scope、epoch、live owner，不能放宽成 `version>=2`。状态不自洽 fail closed。
- **已受理源码修改与撤权不同：** 只有同一原 Node/Session/Assignment 的真实活动归属、已持久 stop annotation 等条件成立才能调用原 bound Agent 的 native stop。旧文件 evidence 可留在本地 outbox，中央仍拒收无权限 Artifact/Report；本地已经修改不等于中心已接受 confirmed effect。见 [CODE_TASK.md](tests/harness/CODE_TASK.md) 与 `grant-revocation-fence.mjs`。
- **普通未领取 Assignment：** UI 撤权后空 poll/0 executor/无 Report/Artifact/Effect 只证明未领取分支，不等于正在运行的 Agent 已被取消。`cancel_requested=false` 和 reconciling 不能被改成 cancel ack。
- **普通 failed retry：** 只允许明确 failed、无停止意图、原 Grant 仍有效的 Ticket 沿原 scope 新建 Attempt；reconciling、running、succeeded、等待审批等拒绝，且 retry Assignment 与两类审计同事务。确认框打开后原 Grant 被撤也必须拒绝，不自动换 Grant。Source `waiting_approval` 是另一路径：理由 ≤1000 UTF-8 bytes、Source/Grant/root/Worker 复核和首次 Assignment/审批记录同事务，不能以 retry 绕过。
- **Priority 只是调度元数据：** schema15 的 `tickets.priority` 允许普通 Ticket 选择 [-100,100] 整数，停止/对账先于普通优先级；不进入 Assignment/work digest，不给 Grant、抢占 Agent、跨 Node 公平或物理执行权。

### 5.2 Node 本地持久化、执行、取消和回放

- **持久入场不是权限缓存：** 两 Runner 必须在重开后恢复原始 Assignment/input snapshot，重新校验 Grant/binding/root/Worker/epoch；旧 epoch、不同 Grant digest、修改 path/content 或旧 Assignment ID 不能放行旧 evidence 或新执行。
- **不可变工作输入与可变视图分开：** Assignment 的 kind/path/content/model/ref 和原始权限摘要固定，status、purpose、resource、当前 grants/revoked_at 是当前视图。比较时既不能整包忽略变化，也不能把视图变化错误当成另一份工作。Grant digest、Assignment logical digest、输入文件 SHA 与 Artifact SHA 不混用。
- **完成/未知先持久再回执：** DSH SDK 结果应先在 `once()` 内规范化 Artifact/Effect，再保存完整产出；一次真实执行后即使 HTTP 200 被隐藏，重开仍按原 request/body digest 重放，中心返回原 receipt，不生成第二执行或第二中心 Artifact/Report/Effect。
- **调用方取消是本地控制，不是远程 ack：** pre-aborted 不发 fetch/不创建身份；已进入原子本地写入允许完成，但阻止后续网络；outbox 关闭传播原取消原因，不增加 attempts/backoff。Node token 空白或缺失不得回退 admin/client token，Node transport 只有显式 challenge/register 可匿名。
- **首次预取消：** 对限定的确定性文件工作，当真实 center 首达已有 cancel intent，合法核验后可原子记录 `execution_started:false` 的取消完成；已 active 但丢失 durable 历史时必须 fencing，不能冒充“从未启动”。已经开始 Agent/file work 的完成结果按实际效果归 succeeded/failed/unknown，不自动封成 cancelled 或 rollback。
- **普通 ACK 与停止 ACK：** 普通 ACK 的 timestamp 和恰一条 admission audit 原子保存，相同合法历史只回放原 timestamp。共享 LocalNode 将 ordinary ACK 先持久，再允许同工作 Artifact/Report 等待；不同工作仍可继续。DSH vendored client 有自身 SDK 前 ACK 的顺序，必须独立证明，不能认为主包修改自动覆盖它。
- **Direct stop 不走普通缓存：** `cancelRequested` 或 `cancellation` truthy 时，共享 client 先直接进行当前权限检查，不复用普通 ACK receipt/cache；也不因此声明 SDK effect 已停止、取消恰好一次或全局幂等。raw legacy pending ACK 仍按原来至少一次 outbox 处理。
- **`once` 竞争要同步认领：** 两 `NodeState` 实现都曾在首次 await 前运行两个 callback；现以单实例内存 `onceInFlight` 同步登记 key/digest/Promise，同 digest 等原 operation，异 digest fenced，独立 Assignment 不相互阻塞。该 map 不落盘，不代表跨进程 once/Grant/Admission 已被替代。
- **坏 outbox 时间不能变成立即重发或 delivered：** Bare Rust 对缺失/非字符串 deadline 在 flush 前拒绝并保持原 bytes；非法时间字符串、合法 future、既有永久 hold 分开，非空坏队列不能报 Delivered。修复不包含任意损坏状态的自动修复，也不发明历史格式兼容。
- **Bare 已完成证据要重验完整输入：** 同 ID 的完成历史不能在 decode/binding/root/Grant/Lease/digest 之前释放 outbox。decoder/root 历史关联失败不能把原始有效 Assignment 改写成 rejected completion。
- **HTTP 限流与资源清理：** 按实际 `Uint8Array` 累计限流，不能信 `Content-Length`；timeout/Abort 要唤醒 reader，保留首选错误并关闭 listener/socket。曾复用单一 server 变量导致最早 listener 未关闭，最终应分别拥有并 await close。
- **strict/legacy 状态兼容：** 缺 delivery 字段的已知旧结构可有限兼容，但 malformed receipt、timestamp、digest 或半边 admission/audit 必须明确待对账/冲突，不能自动补写把旧数据洗成新权威。

### 5.3 源码任务与证据展示

- 第一个真实编程样例仅是 owned Git repo 内、新 Agent、固定 file、固定 source replacement 和固定 `node --test`；默认关闭 code tools，不支持任意 Shell、root、provider、repo 或 code-bearing Session reuse。
- 每个 Attempt 独立 diff + verification Artifact，确认变更来源、实际 Git diff/source bytes、固定 test process、Session/tool sequence 和 Report/Effect；重试不删除先前失败历史，verification 不是第二个文件 Effect。
- 编辑后工具失败可能部分写入，必须 Unknown/reconciling，不得叫 `tool_rejection` 或“无效果”；`turn/end(error)` 不能再绕过 evidence 审核。完整失败的 test 可以 failed + confirmed source Effect。
- 源码编辑已完成、验证子进程未启动时的特殊 user abort，只允许在精确 phase/session/sequence/assignment evidence 下保留一个真实 diff + confirmed source Effect，整体仍 unknown。中心只验证受认证 Node 报告的一致性，不宣称直接掌握 SDK 物理时序。
- schema14 仅保存白名单 `loom.code-provenance.v1` 公开关联，先检查 edit→verify 次序、当前 Assignment/Node、bytes/digests、固定命令及 Effect/Report；原始 metadata 不能公开，duplicate 不能回填或篡改旧 projection。
- Effect 不能靠 `INSERT OR IGNORE` 吞并第二 Attempt：scope/digest/status/evidence/Artifact refs 不一致返回冲突，同一 Report 内重复 ID 也拒绝。Unknown effect 不借新证据自动变 confirmed。
- Artifact 文本读取检查 owner、安全存储名、regular file、真实 hash/size 和 strict UTF-8。客户端迟到的 A response 不能写进 B cache，当前 Ticket/detail generation 和 artifact identity/SHA 必须匹配。
- 原始 bytes 下载是同一 owner-scoped 资源的独立 base64 action，≤8MiB、canonical base64/pad bits、完整 SHA 与实际浏览器保存回读均需独立验证。它不是 Range、大流式传输、任意预览或执行；handoff 的文件名要安全、按完整 Unicode code point 计算 UTF-8 上限，不能切断 surrogate pair。
- Source 的历史 Ticket 链接需**先关闭 Source modal 再选择 Ticket**；审批回执不能覆盖用户后续切换到另一 Ticket/page。HTTP 关系正确不等于用户真正看到并可操作目标。
- 显示折叠不改变消息或授权。Ticket/global preference 有独立 scope，`has_override` 区分真实覆盖和默认继承；同 Ticket `sender_filter` prop 更新也要同步本地 select。sender 标签只是显示过滤，不是新 principal/权限。

### 5.4 Source、Memory、Skill 和观察数据

- Source 的消息/Thread/Trigger 是已认证输入历史，不是自动意图识别、任务或 Grant。Source 事件与可选原始 ticket reference、之后用户明确创建的 `task_ticket_id`/frozen `loom.source-work-spec.v1` 分开。
- Source 新建工作要求原消息、完整 objective、read 操作、文件、当前 Grant/Binding/root/物理 Node/Installation/Worker 一致；spec、Ticket、Assignment/activity/audit 同一 SQLite savepoint。重复按同一 frozen spec 返回原 Ticket，不改授权、不可乱绑定或拿旧 reference 跨 Project 执行。
- `SourceWorkSpec` 的 canonical JSON 排序 object keys、保留 array order；原 source payload digest、spec digest、assignment digest 和文件 hash 各自独立。审批再次检查现状，reject 保持 waiting/0 Assignment，不能伪装取消。
- Source intake 的 thread/event/cursor 在限定 owner/source/thread namespace 内幂等且有界；page cursor 不能跨 namespace；迁移新增 source 表/nullable message link，保留旧 Ticket/Grant/Artifact/message。某旧库缺 messages 时必须只创建兼容空表来支持后续 ingest，不能虚构旧消息。
- Source UI 的 Scope guard 只帮助用户选择，不取代中心权限。原 Source 私有消息不能无条件混入 Ticket activity；GET 不分析 POST body；reactive Grant 深拷贝可能 DataCloneError，应显式复制需要的 scope 字段而不是丢约束。
- 显式 Memory 可选 `source_ticket_id`，但若提供必须真实且属于同项目；空 source 仍是独立用户偏好，引用历史 Ticket 不表示 Ticket 成功或赋予执行权。
- 普通 Memory edit/delete 和各自 audit 原子提交，audit 不复制偏好正文。Candidate 关联的 Memory 只走 exact linked withdrawal，不能重复触发普通 delete，不能按现在 scope 猜另一个 Memory。
- MemoryCandidate 的人工文字编辑与 accept 分离：pending/later、完整 source-bound v1、expected version、≤500 UTF-8 bytes；编辑保留原 observation fingerprint/source refs、scope/project/status，不把后续 observation 说成新证据也进入原候选。旧版本返回冲突，同文字 no-op，不制造 Memory/link/Grant。
- Candidate 的 pending/later/accepted/rejected/never 各自有合法动作；读取失败保留 draft/旧快照并提示“已接受但未刷新”，不能冒充未提交或伪造成功。旧关联被删除后 UI 只在权威完整列表确认时移除旧 ID。
- Skill 不能信任客户端 `replay_verified:true`：需真实独立 replay Ticket、当前原 Grant/Binding/root/Node/worker、实际 Worker 输出和中心对 bytes/SHA 的核对。人工接受不产生 standing Grant/activation，历史 `verified_at` 不因 GET 刷新；任何后续受限重放依然重新核验当前权限，而非把“已验证”视作永久执行许可。

### 5.5 DSH、模型、凭据、Pipeline 与分发

- **受限短语只生成已有授权的草案，不生成授权。** 连续两个真实Source事件先明确相对路径，再给完整现有Grant ID；Source/internal/client thread、严格sequence连续性与当前候选必须同时成立。Objective来自读取请求，授权句本身不变成另一个文件任务。后一句不能重绑已经Task化事件，即使一个Grant可用也不能默认倒选。客户端 `authority_snapshot` 可辅助核对Grant version/digest/Binding/installation，绝不POST；已有八字段、中心裁决和原`SourceWorkSpec`保留。真实 pairing 当前 source_ticket_id 的绑定可由乱序/重复相同文本误导，必须核对精确的 Event Ticket关系，而非最近message或全局列表首项。
- **Source查找与线程读没有嵌套同名busy。** `lookup ensure`和`loadThread`分别占 `source-read` lock会让后一个 undefined，旧404还能留在UI。实际用户一次 thread 读取由一个 outer read 完成真实lookup+受保护GET，并返回实际SourceThread，不能再将拼装返回值当SourceInstance交给外围二次loader。Event拿到回执后要再核实同源的持久events，不把本地补造的order当历史，也不因读取完成表示执行完成。`/source-events`回执不等于已渲染某一新事件；driver应按当前 POST的Ticket/Event ID以及正确thread seq内容等待，不把早一发或别的GET当新read完成。共享假定last Event Index/首个Grant也会让已撤旧pair的授权错变成当前数据，不放宽权限只是量具错误。
- **公开的root声明与规范表示分开。** Rust Project root canonical为`/private/var/...`时，Host inventory可能仍记`/var/...`。在保护措施内、只对已声明root查 `canonical_project_roots`，原`project_roots`与Binding root/digest不改，复杂权限不随路径alias扩大。缺新字段只允许完全相同的legacy root字符串，不可随便startsWith代替。展示和candidate共享单函数；两个地方仍用不同路径来源会让明明存在的Grant被筛掉。Node多个 Installation按Grant精确选择不取第一条，canonical root不创造Grant/Binding/Activation。恢复要复用原data_dir/base_url/client token，不能意外打开空数据库证明已恢复。
- DSH验证只在隔离 fixture Profile中使用公开 SDK/Tool/Session API。真实 `desktop` 的生产 Profile、实际凭据与全局插件不能用测试改写；插件单测不代替真实安装和执行，Stub也不替代 Live Provider或移动设备。
- DSH `ctx.agents.followup` 需要正式 UserMessage；曾因多余 forwarded `@deepseek-ai/dsh-llm` 发生 ESM race，应移除旁路桥并沿用真实 public SDK，而非私有 Session event 或 mock 代替 Agent。
- **宿主升级要贯通 manifest、证据与客户端解析，不能只改版本号。** rc.3→rc.5先读实际升级指南和所用接口；strict allowlist `host_api` 的版本必须由选中 Host 的公开 manifest 提供。普通Node读ASAR会ENOTDIR，应由该Electron运行时只读检查。Rust/前端各自hardcode分别会导致中心拒绝或UI退成不完整证据；新增同白名单正向和不详版本负例，再实测真实链，不能靠exact-version豁免绕过。
- **公开读取证据必须同时穿过 Host→中心→回放→视图。** 适配器只投影真正的tool call/result与Session、事件顺序和源bytes SHA，复核实际ProjectBinding文件，不复制Tool args/Tool文本/assistant转录或绝对路径；普通Source/Dsh对话不因同path就被当成这项固定支持能力。schema16用独立reader projection而非把read-provenance写入旧code-provenance；duplicate若替换proof、删proof或换Session不能返回duplicate。Report还需同Session/host/protocol与 `observed_seq>=result_seq`，读取不是confirmed file Effect。详情/下载先验证内部TEXT对象，再公开 `read_evidence`，绝不直接展示JSON存储名；独立查看结果需同TicketAssignment、actual Report和完整DTO匹配。
- **安全测试需要真实反证和对每种证明身份做跨层复核。** 用临时SDK制造真echo再回到敏感source正常状态，证明宣读内容不在公开Ticket/Message/Audit/Artifact；缺Tool结果仅unknown/no successful proof。不要单靠hidden UI、metadata flag或测试自造session来宣称无泄漏；要同时验证ProjectRoot的实际字节与独立hash、failed read unknown、unauthorized sibling、invalid host/call/session/sequence/digest。检查原计划/报告删除或替换prove没有duplicate机会；兼两namespace的证据不能被旧code parser静默绕过。实际UI selector只在所属tab适用，先选择原ticket再点到协作展开/审计/证据；默认最近Ticket会误导测试读错对象。Realtime中心完成和Session持久化flush可能有先后，需等待observable stored bytes eliminate false negative。复查这些真实源:[SENSITIVE_READ](tests/harness/SENSITIVE_READ.md)。
- **新增字段后，schema与使用中的driver同步前行而非只改Rust断言。** 对真实Rust/Node升级保存旧Grant/Ticket/Artifact/audit与bytes，把当前schema升级并清零新增projection旧数据（不 backfill）。以前跑过Source/Skill/Pipeline/Runtime的实际driver版本bind也必须更新；future拒绝另一版本。只跑单元migration会发现不了客户端旧expectations，需把每一种受影响run入口作为独立小验收。否则大量“旧 schema expected 15”会把真实安全增量混入未验证状态。
- 父子委派需 center 验证 source/current Assignment/Lease、真实 parent Session、parent/child Artifact/Session 关系；`source_verified` 布尔或 Session UUID 不能取代这一检查。原 ToolResult 的 source metadata 丢失时不可伪造补齐后端关系。提供 `parent_session_ref` 时也必须与 producer 记录的 Session/Ticket/host/sequence一致，而非允许任择 parent Session；未提供才保持旧的server选取。证明伪造时让判据到达实际字段：source-input的是`parent_session_ref`，普通Node events另用`session_ref`，误用成一个就会让伪拒失效。缺bytes可以临时将**own**真实父Artifact挪走再恢复，实际验证拒绝并原hash未变；不能只使用 caller 标志或 http 200 判权限已经通过。父入口只能是从当前已验证DelegatedFrom关系parent_ticket_id触发的`selectTask`，默认collapsed/展开协作分别验证；新Nav不得成为未知context/message URL或替代当前Node/当前Pipeline的两段授权。
- **诊断对象和日志简化远一点，能反证但不能泄密。** 完整`server`/`admin`对象带clientToken，即使只引用临时合成token也不能写成PASS evidence或调试输出。内部继续复用的服务/客户端实例可以返回，但报告只保留白名单checks、字段和viewport；意外错误按已知secret列表redact，而不是把临时token不当 secret。
- 固定 `loom-stub` 的 SDK text invocation 只证明该目录/adapter/Session/text Artifact 链。`invoke_text`、`place_model`、read/write 是独立 Permission；descriptor 的原始 source bytes、proof SHA、source Assignment logical digest、placement 和新 invocation Assignment/digest 不同。
- `model-inventory` 是从已认证 heartbeat 得到的目录观察，不是中心直接探测、Registry、安装、激活、下载或推理授权。保存 JSON 时已可能是 object，不要再按 string parse；观察时间不因 GET 或重复 heartbeat 偷换为“新实测”。
- Credential fixture 只操作自有合成 record；存在性检查、独立撤权授权、实际 delete 和 restart missing 要分别证明。真实写异常无法判定结果时保持 `reconciling`、unknown Report/Effect 和只读 duplicate，正常 retry 拒绝，不能假装已删或可盲重试。
- 文档 Pipeline 只限当前说明中的文件/转换/血缘。早期半成品 adapter 编译失败被回退，不能把一个 frozen DAG validator 称执行；后来真实两阶段链才以实际 Grant、worker、Report、Artifact、source parent 和中心重开验收。
- Source Artifact 嵌套在 Pipeline 的子 Ticket 创建时机来自真实 source Report，不是 run 创建时全出现。Grant digest 与 binding location digest 都需有效但语义不同；不要持久锁内再次 `state.lock()` 制造自死锁。
- 直接 Artifact handoff 只证明同机两个 logical Node 的小文件/签收与当前/取消围栏，nonce consumed 不等于 downstream stored/acknowledged。曾提出但未验证的 halfway Unknown replayer 已回退，下次必须另建严格错误/恢复协议，不能宣称转账 exactly-once。
- Bare package 是 built-not-installed-not-activated；统一防 path/symlink/hardlink/identification/modality scope，但不以 permissions 检查代替实际 installation。recursive chmod 曾误动已有父目录，修复只针对 owned 新目录。
- Bundle preflight 可在临时副本读 source/阻止越界 path 或 hardlink；不等于安装。真实 `file:` remove/add 在临时 Profile 中替代/启动时，默认 disabled Worker、revoked Grant 不复活，installed/enabled 仍不是 Registered/Granted。
- 合成安装 plan 的 fixture observation、rollback parent、operation ID 和 Unknown 不能变成真实遥测、安装器、SSH 或节点健康。UI 曾被旧的 `observations.length` 阻止合法 rollback，应只检查当前 operation 的 observation，且 plan digest 不等于外部效果成功。
- Git URL 清洗要在持久与 audit 前完成，HTTPS userinfo 不得成为公开凭据泄漏；只读 probe 不能推导 clone/fetch/远端可达。硬件 probe 明确 opt-in、固定 executable/argv、限制输出，不把 GPU/Metal 当作已安装可用模型。

- **Probe的来源不能由Node心跳签合同，物理本机归属也不能只凭Node ID猜。** 固定probe的真实完整DTO应存中心私有 `settings.hardware_probe:<node>:<installation>`，节点与Placement只投影这个精确Installation的中心记录，不能将heartbeat里的 `source:"controller_probed"` 或放大的硬件数据冒充controller实测。原始Node inventory不被CLI偷改；未测内存必须仍未知，审计失败不能落下无主事实。CLI在执行前另要求 `--this-controller-host` 明确操作者选定当前物理机，这只是本地operator声明、不是密码学设备证明，更不允许转成远程/第二Host验证。当前实测、伪造心跳、条件原因、busy、原port/token/dataDir重开的verification见 [model inventory](tests/model-inventory/README.md#current-trusted-local-hardware-condition-report) 与 `/tmp/loom-image-capability-proof.json`。基于这份报告的图像前提评估不是图片执行/质量或全M1完成。
- **无外部副作用的POST并不想当然跳过当前认证代际。** 专用 `requireCurrentCredential` 仅对已标明读取用途的POST检查token/epoch，不能改造旧写入的已接回收据。条件评估走 `run` 的真实401/Required流程，不能用自捕获异常另造旁路。此类评估仍须用户明确选择相同Node/installation/worker/root的现有read Grant，保留canonical root合法映射但不自动倒选。硬件显示按真实 `fact.source`，长标识由实际390px换行验收，所有“存在模型/支持图片/运行时已实测”的额外结论都必须明确禁止。
- **别把原始`status:'online'`与当前存在性算成同一事实。** `/nodes`已经在读取时，综合撤销状态计算 `online/freshness`，前端若有这个字段，就让`nodeOnline`尊重它，不能额外只贴waiting badge却把卡片和团队总数归类为current online。只有字段缺失才走旧90秒启发式；`revoked_at`独立标明身份失效，绝不因 heartbeat恢复Grant。`online`是当次服务端快照，不是重启浏览器后对网络或硬件的新测量。勿以Node 的旧lastHeartbeat冒充客户端当前连接。真实Rust握手/老化自有timestamp、同DB/token/地址重启、Edge stale卡片0在线、390px同Profile重开、管理员撤除后Node自身token收到401，见`tests/model-inventory/offline-heartbeat.mjs`与 `/tmp/loom-node-staleness-proof.json`。这证明单机reported/stale presentation差别，不证明实际断网、物理第二Host或真手机回线。管理员与Node重试身份要分开，不能把共享NodeHTTPClient对其node route的拒绝误当管理操作在将其误当作所需管理认证本身的失效。

- **Project Git事实是上次受控观察，不是目录授权或实时证明。** ProjectInventory需以白名单展示HEAD基线、真实form/dirty、来源和probed_at；工作的dirty也可以null表示未知，不可写为false；非Git documents不需要伪造HEAD，缺/坏inventory时probe不能改写已有观测。公共canonical_remote不是href，redaction与凭据类别状态独立，不把private git config/凭据字段或操作转换为远端可达或Grant。`probeProject(id)`有per-Project busy，必须在同ID/read_only_probe:true/完整公开inventory时才替换Registry item，401/epoch/unknown都不能删除原本的旧观测。真root、token、dataDir重开按完整 inventory校验，不要误开空SQLite 或把整Project与 inventory子对象含糊比较。真实正反向证据见 [tests/projects/README.md](tests/projects/README.md) 与 `/tmp/loom-project-facts-proof.json`。缺北结果也可能只是更精确未知，并非HTTP failure。

- **持久化迁移还需要真实公开读取证明。** 旧schema行能`Store::get`不等于客户端能安全读取：应分别验证detail与byte下载的Authorization、`read_evidence:null`及内部`_json`列不泄漏，旧bytes/Grant/digest/audit完整保留。真实测试表明invalid read projection实际返回400，字节不一致为409，不要先假设一律500。错误路径也可能经过raw row的FromSqlConversionFailure，且需要在`public_read_projection`与detail原始SQL读取边界同时剥除storage列名/内部错误文本，不能通过删字段名的泄漏断言来“解决”。原row/bytes/审计最后必须恢复同值校验。命令与完整范围见`cargo test -p loom-concierge store::tests::v15_upgrade_is_additive_and_preserves_old_authority_and_bytes -- --exact --nocapture`，它是源码迁移回归而不是Full host或Universal DLP证明。

- **同一public artifact上的`read_evidence:null`不是read_namespace标记。** Schema16会让旧code/普通record显式携带空缺reader字段，只有真正非NULL候选才应进入严格reader关系检查。若把缺省元数据与`null`合并忽略，代码Artifact将因有Effect而被降级为incomplete，即使原始diff、验证、Grant、Assignment和Report都合法。这正是旧UI fixture没有server新null字段才会漏检的情况：应把真实payload放入code/view tests，旧Attempt失败/新Attempt正确对应到完整真实DSH Chain，而非只测自己构的value。原始Report SQL只有`state`，`ticketFrom`派生status；单独state应照常匹配，两字段矛盾必须继续失败，不可以借 new statuses/no Status 提升成功等级。本次已跑真实code-task(script完整cancel/reopen/revoke及旧失败→新attempt)证明；不要靠`public_code_projection`输出errors换成null来逃逸身份/byte integrity leaks。涉及同一新reader namespace的私有坏对象，在公开detail/download投影与SQL行错误处同样要收紧bounded error，而不是把内部Column名字/私有验证器原文交给客户端。可复验[迁移后的受保护读取](tests/harness/SENSITIVE_READ.md#schema-15--16-migration-through-protected-read-endpoints)。

- **Vue记录 identity key应匹配协议的复合身份，而不是套用Node ID。** 同一Node有多个Installation/Worker/独立timeline时，Node ID只是共享公共身份，真实安装关联要靠`installation_id`。`nodeIdentityKey()`统一`node.node_id ?? node.id`与全程`installation_id`，card有data-installation-id便于按真实身份验证，避免Node ID相同导致VNode复用和 duplicate-key warning。不要只在一定事件后require unique names才验：要实际A新鲜、B老化时间后保留A在线、B陈旧、online sum恰一，同时 immutable worker/root/inventory/registration都原样。测试内部还分`NodeIdentity.nodeId / installationId` getter 与`report.results.fixture.node_id / installation_id`存储映射，绝不能用错误一层. 两common logical installs在**同一物理fixture computer**是否已有legitimate pubKey不能冒充第二host/物理断网，陈旧也≠自动撤权；原binding B、A worker/root mismatch拒绝及sole legacy payload仍应分别通过。完整真实Edge结果见 [installation-ui](tests/browser/installation-ui.mjs) 与 `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-installation-ui-proof-pNBgte/result.json`。

### 5.6 Web、断连和 PWA 静态壳

- UI 条件分支被额外节点打断会让 Help 与 Ticket 同时出现，横向 overflow 也可能由长 Node ID 和 flex layout 引起。要按真实截图、DOM 和宽度修复条件链/`min-width`/换行，不能仅隐藏溢出或把面板 z-index 调高。
- 旧凭据读取/401/嵌套 preference/audit 回执不能覆盖新认证工作区；401 与离线分开，候选 token 必须经真实 protected read 才保存。已接受的写回执不因凭据代际改变而被撤销；stale read error 不应被 generic invalid JSON/空数据吞掉。
- `browser.setOffline` 时，组合 Ticket 读取中的内部 preference 网络错误需向上传播，否则顶栏会保留旧“在线”。公开的 standalone `readPreferences()` 仍须被原 `run()` 吸收，避免 `void` 调用产生 unhandled rejection。刷新必须以真实同 Ticket protected GET 成功为准，不能只看 `navigator.onLine`。
- 客户端断连仅表示已加载视图是历史快照，不代表 Worker 离线、任务停止或先前写未接受；旧 Ticket/Artifact/Effect 保持原值，重新读取不会自动创建新作业。
- 浏览器只使用标准 Playwright + 新建 owned Edge profile；不再直接 spawn Edge 的支线，因为曾触发厂商 updater/LaunchAgents 和公网请求。只清理本次 owned browser/server/context，不修厂商 updater 或用户全局数据。
- Service Worker 只缓存同源公共静态壳，不缓存 API、Authorization、Ticket/Grant/Artifact 或 token；首次未准备的 offline context 不应造出应用快照。冷启动、离线业务、移动 OS 生命周期与 Host 恢复都不是它的能力。
- Shell cache 从 v1 的经验改为候选 bucket 完整读取/逐项 MIME+SHA 验证，再发布和 read-back；非空同 version 不同 bytes 必须升 cache version。坏候选不删有效 release，不用“controller/update resolved”“cache 名字存在”代替发布完整性。
- `cache.addAll` 接受 RequestInfo 而不是已 fetch 的 Response 数组；正确 `cache.put` 逐项保存。Rust 静态服务需要实际允许 `.webmanifest` MIME，而不是把 manifest 当 HTML fallback。
- 已准备的桌面浏览器可验证真实进程关闭→同 profile 离线重开、Service Worker 导航和五项静态资源 hash，恢复在线后再受保护读取；这仍不是手机杀进程、离线 Ticket、后台执行、签名更新或全局 CacheStorage 原子事务。

## 6. 尚未解决、不要误判为已闭环的事项

- **完整 M0 场景验收**，尤其真实 iOS/Android 浏览、锁屏、杀进程、切网、非敏感审批，以及未覆盖路径的敏感过程审查。当前只有固定 `LOOM_FIXTURE_READ` 的真实echo→公开Proof已闭环，不等于其它普通DSH对话/历史材料的通用DLP。桌面窄视口和桌面浏览器离线壳不替代真机。
- 真实自然语言/通用编程质量、通用代码工具与 Shell、外部 Provider/Live LLM、完整模型治理、通用 Pipeline/Reviewer/多 Harness。
- 第二物理 Host、非 loopback TLS、Linux/Windows 实际 Host/服务生命周期、签名安装器、真实远程 Bootstrap、OS Credential Store、生产 DSH Profile/凭据集成。
- 全局 exactly-once、跨进程 NodeState 协作、所有工具/Provider 的中道 kill 恢复、任意 Artifact 大流/Range/跨机 Unknown 对账。
- 自动习惯学习、语义 candidate 合并/编辑 scope、自主 Skill 执行、完整 Memory/Transcript 生态。
- 固定的 1 Concierge + 3 Node Compose 仍按最初要求暂缓，不能拿局部多 Installation、多个 logical worker 或独立 driver 结果冒充它。

恢复开发时使用 [roadmap.md](roadmap.md) 的 M0 场景表作为主线；先选择可以实际闭环、对当前验收最有价值的一个缺口，不为继续增加局部数量而开启新领域。
