# Loom Roadmap

- 状态：M0 实现中；确定性本机任务链已通过，完整 M0 和后续里程碑未完成
- 基线日期：2026-11-17
- 计划口径：按验证结果推进，不预设日历日期或固定硬件

本文只回答当前先验证什么、暂缓什么，以及如何用多类真实任务决定下一步。长期产品方向见 [vision.md](vision.md)，架构约束与术语见 [architecture.md](architecture.md)。

## 1. 路线判断

首个目标不是搭齐全部控制面，也不是完成某条行业 Pipeline，而是验证：

> Loom 能否在真实、有限的用户环境中，可靠完成任务、如实说明能力边界，并让用户在需要时理解 Agent 如何协作。

路线图据此按以下顺序推进：

1. 先跑通单机最小闭环，避免在执行边界尚未验证前铺满 Registry 和调度协议；
2. 再感知真实项目与设备，包括明确回答“支持”“不支持”“未知”；
3. 随后引入第二个可信 Host，验证跨机交接而非只增加设备展示；
4. 随核心闭环验证 Vue 的多端交互，逐个验证三种桌面 Host；移动端不是等所有核心完成才开始的一次性移植；
5. 在已有可靠闭环上开发行业 Pipeline、异构 Harness 和开放生态。

每个里程碑都必须通过一组场景，而不是一条精心准备的演示。阶段完成也不意味着所有长期架构组件已经实现。

## 2. 当前与下一步

### 已确定的技术决策

- 首版控制面、裸机 Host Agent、Registry 与持久化应用层使用 **Rust**；Web UI 使用 **Vue 3 + TypeScript**。
- 桌面壳优先 **Tauri**；移动端先做响应式 Web / PWA，确有推送、商店与系统能力需求时再包装 Tauri Mobile 或薄原生壳。
- **DSH Host 的首选形态是 TypeScript Loom 插件**：作为完整 Local Node 主动注册中心，适配 Session、事件、心跳、Artifact 和本机权限；不再为同一 DSH 机器强制部署 Rust Agent。
- 其他既有 Harness / 模型服务保留原技术栈，按 API / MCP / CLI / Connector 接入；本地模型服务复用所属 DSH Node，不要求再套一层 Agent。
- 协议使用版本化、语言中立的 Schema 与 HTTP / MCP / RPC，不把 Rust 或 TypeScript 内存对象当公共接口。
- macOS / Linux / Windows 是桌面 Host 目标，逐个平台验证；iOS / Android 首版用于查看、沟通和审批，不承诺后台 Worker / 长期在线 Host。
- 每种其他 Harness 需要 Adapter 实例但不强制宿主插件；按 **Native API → MCP → CLI → 专用 Runtime Plugin** 的顺序选择能满足能力约束的接入方式。
- 提供**选择性组网安装和主动注册**：管理机审核包和 Inventory，在选中的机器安装 Plugin / Bare Agent，节点主动注册并完成一次性配对，中心保留 Grant / Lease / 任务权威。
- **Ansible / SSH 免密引导是允许的**：本质复用已有运维授权，传输、安装、提权和后续任务 Grant 分开；不做模型临时拼脚本的远程执行，也不因免密而默认接管全 LAN。
- 分发代码和配置不等于分发 Secret、模型、权限或长期无人值守批准。首版仅承诺可信单用户 LAN 的官方包与固定受审计 Installer，不做任意第三方包和跨不受信网络的聊天触发安装。

接入、多端边界与部署见 [architecture.md](architecture.md) 的第 7～8 章。Rust 运行时、SQLite 驱动、特定平台服务管理和 Tauri Mobile 的实际适用性，均须通过原型与目标设备验证。

### 当前

已有真实 `crates/protocol`、`crates/concierge`、`packages/node-client`、`plugins/dsh-loom` 和 Vue 工程，以及使用前台真实子进程实现的 Rust↔TypeScript 本地任务链。可执行命令和硬断言见 [BASELINE.md](BASELINE.md)，提交与实现/缺口对照见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)，集成缺陷记录见 [MEMORY.md](MEMORY.md)。

这并不等同于完整 M0 完成。下述状态在没有对应证据前均不能视为已完成：

- 已通过真实 HTTP 的确定性读写、取消/失败、重放与恢复；隔离 DSH Profile 的真实安装/Agent工具任务/取消/Session重启恢复也已验证；当前独立真实桌面浏览器完整链已达11阶段（含偏好、正常取消、撤权及重试确认期间撤权）与受限 Agent 文件 Tool Effect亦有证据，详见 [tests/browser/README.md](tests/browser/README.md)，但这些仍不是完整 M0 业务与多端验收；
- 受限文档流水线已真实跑通（`read_summary` → 四种允许的文本变换之一 → `edit_file`），包含两张精确Grant 的下发、真实Artifact 接收转换、Node作用域校验、不可变谱系、重复执行保护和中心恢复。这里仍然只是当前受限场景，不能当作后面模型生命周期、任意 DAG、跨机部署、通用 Harness 或 M6 已完成；
- 已有最小 Host / Project / ResourceBinding / Grant Registry 与 `loom.inventory.v1` 的事实矩阵、来源/freshness 和 PlacementDecision；现有单一隔离 DSH `loom-stub/loom-stub-v1` 文本 SDK adapter observation 的真实 heartbeat 只读投影，匹配已认证 Node/Installation/Worker、保留源时间并拒绝其他provider/模态/授权包装；多心跳不重复prepare，未调用stream/生成或产Grant，控制面HTTP重启后一致。`model-inventory`只是观测，`tests/model-inventory/browser.mjs`另已让设备视图在真实Edge中根据认证心跳的projection显示 Node/Worker、text/context/source与未激活边界；仅读没有模型POST/Grant，390 viewport没有溢出。尚不支持download/install/activate/general_provider_registry、通用 Model Registry、真实模型生命周期、跨 Host 大 Artifact 直传和完整设备能力发现的全平台验证；
- 已完成受限 `model_descriptor` 本地文件读取、proof Artifact 原始字节 SHA 与完整 metadata 注册/独立 `place_model` 批准/撤销/撤档和 SQLite v9 重启保留；真实 `tests/models/local-descriptor.mjs` 通过，输出始终 `registered` 或“批准的放置元数据（未运行）”，并非安装/加载/模型推理。Provider Registry、模型执行与下载部署尚未支持，只有冻结的本地文本 descriptor 元数据 chain，详见 [tests/models/README.md](tests/models/README.md)；
- 已有版本化 Assignment/Lease、内容哈希与分配的 Artifact 上传；当前已经在一台macOS上以两个独立Node、各自Grant/身份、真实loopback与接收者 Ed25519签名完成了小Artifact真实直接取源。Source当前Grant与目的Assignment/运行时取消状态都会再次核验、nonce一次使用且可恢复。它受1MiB/文本变换限制，物理第二机、跨机大Artifact 直传及完整双向对账仍未验证；
- **持久 LocalNode 入场与实际回执恢复已有新的硬断言**：主/vendored runner 与 Dispatcher 在写入 assignment 前核验合法授权、保持工作输入，旧epoch/改grant digest/变更任务path/content不能借同Assignment ID继续执行；取消需要先前受理记录且不会改写历史。重复活跃作业的promise/控制器与pre-start cancellation保留input digest；拒绝核销及实际Artifact/Report/Effect分开记录。`tests/runner/real-receipt-replay.mjs` 已在真正的RustConcierge中让HTTP成功响应被本地注入丢失，随后通过真实NodeState重开按同receipt补传且保持一份Artifact/Report/Effect和原始文件bytes。真实DSH安装/Agent/tool/cancel/resume及固定模型binding链仍分别验证，详见 [tests/runner/README.md](tests/runner/README.md) 与 [MEMORY.md](MEMORY.md)。这进一步缩小当前围栏与恢复缺口，**不是**通用exactly-once、物理多机或整个M0完成；
- **HTTP响应读取已形成实际分块与停止证据**：共享/vendored客户端按真实byte上限读取Web Stream，不只先读整段再检查大小；超限可快速停止该reader，外部AbortSignal与总timeout唤醒pending read且不破坏原取消原因。零字节帧不能饿死超时，非法chunk/reader清理error不能冒充Node任务状态。底层新增独立本地 socket/scoped case，按每server自己的 close验证，且结束严格关闭listener/owned sockets，没有遗留测试服务。`tests/runner/http-stream.mjs` 与 `tests/runner/http-socket-stream.mjs` 均实测。这是新的本机 HTTP 输入可靠性增量，不替代大 Artifact 直传、远端 TLS/物理设备或其它里程碑验收；
- **启动初始化已有明确取消与恢复证据**：两Runner的注册/heartbeat采用同一可选caller signal；既有身份的只读验证与取消阶段检查分开，正在被验证的损坏身份不再降格为缺code。已保存的真实注册token在取消后不丢失且重开以同Node恢复；过期观测和外部取消不再混淆。普通Coordinator仍由dispose停止，不声称Cordis/SDK所有effect都自动取消。证据：`tests/runner/startup-cancellation.mjs`与真实DSH生命周期回放。
- **凭据丢失之后的真实查看恢复已形成闭环**：401不再把缓存或授权列表当作刚验证完成的现况。读响应受token revision与内容校验，旧的候选或浏览器tab后的读取不能覆盖新工作区；知识上过去接收的写操作receipt仍被保留。设置dialog的候选token先经过全栈受保护读取、未通过则不保存，旧用户数据明确标为早前快照，认证无效的新写入不会发起。真实standalone Edge+Rust抵抗过401、错误candidate与重注册测试，恢复same-cancelled-Ticket及真实cancel_acknowledged，未产生新Artifact/Effect。它不是手机锁屏/杀进程或Keychain迁移承诺。
- **首次预取消与重放补齐了合法停止缺口**：之前center第一次将cancel flag发给未接收Assignment时，runner以missing_previous_assignment隔离。现在先验明工作、Grant、Worker/root/stop intent后才原子的保存Admission 与取消完成。`state`里有execution_started=false和digest，可在失败重连重开后只重放原取消/receipt，没有executer 或文件副作用。已有真实promise按二者的状态处理，无法判定的效果仍为unknown。限`read_summary/edit_file/model_descriptor`的确定性文件工作，未将模型的placement或credential设置默认认可取消；旧持久拒绝也不再遮掉当前实际非法原因。证据： `tests/runner/cancel-before-admission.mjs`、 `tests/runner/prestart-replay.mjs`、全套active/deactivation回归，以及同Grant/work输入摘要与Legacy缺digest未验证状态负例。
- **M0 SourceInstance / Thread / Trigger 已有真实持久入口（限流、记录，不是自动触发）**：Rust `POST /sources`、`POST /source-events` 提供受认证的原生来源注册及用户消息 事件，严格typed DTO、来源/线程/幂等命名空间，尊重RFC3339时间但不以它排序。事件源seq、原文 digest、JSON duplicate/unknown字段拒绝、并发首建、内部thread与外部client名称隔离、来源事件与既有Ticket引用、精确分页/服务器cursor与真实中心重启持久化已实测，source产生的message跟ticket原有活动和历史来源分开。新schema12只是新增source与nullable message关系，v6/v11 populated history仍恢复，unknown futures拒绝。**不是**自动创建Task/Agent/newGrant、`source_id` 当OAuth或当前用户全部资源授权、真实 IM, current_source multi-principal multi-tenancy、真实物理设备或跨进程集中 exactly-once。已进一步提供受限的 `source_event_id → 用户明确 read_summary / 文件 / 当前有效 Grant / 物理Node/Worker → 实际LocalNode文件Artifact`，不是消息自动授权。schema13 将旧 `ticket_id` 标为 unverified intake history，并另外保存不可变 `loom.source-work-spec.v1` 与独立 task 关系；spec、Ticket、Assignment/Message/Audit同一 savepoint 原子提交，strict canonical digest 与原始身份/范围双向校验，跨Project、无read、错root/worker、退绑与撤销后的首次新工作拒绝。重复受理新建工作回源 Ticket，不新增 Assignment/Artifact；过后 Grant 撤销只让历史可见，不再次创建权限。waiting approval 与实际 poll 也再次核验当前 Binding/root/原物理Node，宿主不可用不是完成。真实 Node 文件Artifact/Report/Effect 与数据库触发器故障注入、退回修复后再执行、历史迁移恢复都有实际驱动 [tests/sources/authorized-ticket.mjs](tests/sources/authorized-ticket.mjs)，另含SQL解绑及Node身份篡改负例。**没有**自动意图推理、授权自动收款、generic Source DAG、实际IM/OAuth、多宿主或跨进程exactly-once；也不建立DSH Session /长期手机工作态。见 [tests/sources/README.md](tests/sources/README.md)。
- 已实现 Conversation/Activity/Collaboration 的默认折叠与 Ticket 展开。当前已在一个隔离 DSH Profile 内实测父 Agent 产生不可变来源，由其真实 `parentSession` 指向的独立 child Session 通过受控工具产生另一份文件、正确血缘和原父 Session 引用，且在协作视图可按需看到已核验来源。依据见 `tests/harness/DELEGATION.md`。这只是单 Host、固定 Stub 的两 Agent 小任务，不能代表跨 Harness、任意 Agent/DAG、完整隐私分离或普遍生产编程能力；
- 分发目前有真实但有限的两条证据：`node tests/harness/bundle-preflight.mjs` 对当前 DSH bundle 源做 31 项**不安装**的预检；`node tests/harness/real-bundle-lifecycle.mjs` 在唯一临时 Profile 中用公开 CLI 安装、替换 metadata 版本并重启，worker 默认关闭，已撤销 Grant 在同 worker 角色下仍不能被升级复活。它们是本地 `file:` 流程，不是 GUI/remote registry、生产 profile、资格授予或任意代码更新认证。
- 裸 Host 的 `node scripts/bare-package-smoke.mjs` 已在**当前 macOS arm64**实际离线构建并执行 binary，检查真实副本 SHA、权限、信息调用无注册，以及错误 root/enrollment、截断/symlink/hardlink/空 payload 拒绝；`scripts/bare-integration.mjs` 的真实读写、取消和重启继续通过。见 [docs/BARE_PACKAGE.md](docs/BARE_PACKAGE.md)。这不等于通用平台包、签名服务安装、远程部署或第二物理节点验收。
- 安装编排现有**仅限合成 Inventory** 的可持久计划和 Vue 审阅：固定 Bare 描述符、已选/未选/不兼容目标、明确plan_digest审批、操作关联的 fixture 观察及带回滚父 operation 的持久历史；已有v7 DB增量迁移到schema8。`tests/install/plan.mjs`已实测HTTP、同op回执、Unknown不可盲重试、健康失败→批准回滚→回滚观察、真 server restart与禁用501；`tests/install/browser.mjs`也实测了真正确认、父子operation的关系、390 viewport与不变Ticket/Grant/Node数。见[tests/install/README.md](tests/install/README.md)。**这不是**真实主机安装器、遥测、SSH/幂等执行、root/Grant或Manifest生成的生产部署许可；未知需要后续具体证据对账而不悄悄自动分类。
- Rust/Tokio、SQLite、Vue 在当前 macOS 验证；尚无 Tauri 或真实移动设备验证。DSH 0.2.2-rc.3 在专用临时 Profile 已跑过真实安装、任务、取消和原 Session 重开（见 `e1da1f0`）；这不是当前用户 Profile、系统 Credential Store 或真实 Live LLM 的验收。

### 已有Source入口的真实用户确认链（M0局部）

生产 Vue 已加入有界的 Source/thread消息入口。打开/记录消息仅达成 immutable intake，不创建ticket或新权限；用户必须选择**同一当前有效 Grant**、指定实际文件与精确Node/Worker，并再次确认后才生成受限 read_summary。没有 message→授权的自动意图识别，没有自报 Source 根目录替代ProjectBinding，也不会用前端 digest、received acknowledgment代替执行状态。运行/等待审批与实际Report/Artifact分开；同Source原spec duplicate仅返回原Ticket而不产生第二个执行、producer、Assignment或Artifact。

真实独立Edge、Rust中心与LocalNode证明两支不同Source各自创建及duplicate、一次failed Report经显式retry的新Assignment成功、源spec/digest对账、Artifact下载bytes/hash、SQL审计和当前Grant撤销时的old lease fencing；此入口桌面默认UI保留Task/Activity脉络而不再误混入Help面板。390px桌面viewport也测过实际detail/activity/artifact无横向overflow，非移动真机/锁屏/切网测试。`node tests/sources/browser.mjs` 连续两轮通过；`node tests/browser/run.mjs --keep-evidence` 普通read/write/cancel/auth-expiry-recovery也全阶段通过。这里的Proof不是Live LLM、真实IM/OAuth、通用Agent Provider或第二物理宿主/Compose验收；M0及后续里程碑继续保持各自验证边界。

**这一入口的首次人工批准现已真实完成，而不仅是有按钮可以POST。** 原先UI已写着理由必填且写入审计，后端却根本没有读取它；现在带明确 `approval_id` 和最多1000UTF-8字节的规范化reason一并校验。真实用户拒绝某次待批准Source工作会记录 `task.approval_rejected`，继续保持waiting而不是取消/失败、没有Assignment。用户重新检查后明确approve才会在当前Grant/Binding/root/source原范围里签发**仅此一次**first Attempt，并在同一事务中保存真实Assignment/Lease和 `task.approval_granted`。旧 `retry_after_approval` 仅库内generic兼容，不是HTTP省略理由的入口。普通failed retry新Assignment和既有两种retry审计也已归入同一原子事务，解决先签发工作、后无法写入审计的结果裂缝。具体不得改变的监管边界与证明见 [tests/sources/README.md](tests/sources/README.md)。

真实Source浏览器现走完第三条独立工作：host离线导致的waiting → 用户填拒绝理由并确认后仍零执行 → 真实Node以原project root inventory心跳恢复 → 用户填新理由并再次明确批准 → 独有Assignment/lease epoch交付真正读取Artifact。从原audit逐条核验reason/ID及Assignment/Lease，不拿输入字段或按钮文案冒充持久记录。最终为 **3 Tickets、4 Assignments、4 Reports（1次failed、3次succeeded）、3 Artifacts、3 Effects、3 immutable specs**。原始两条任务与其字节/Grant/digest/历史仍受后续撤权保护。详见 [源UI报告](/tmp/loom-approval-browser-result.json)，另有[HTTP approval与公共retry的故障回滚证明](/tmp/loom-approval-http-final-jrwOGs/result.json)及[真实DSH源码原失败retry回归](/tmp/loom-approval-dsh-final-wvhkGI/result.json)。`approval_id`不是无限授权或幂等主键，HTTP响应未知时需读取真实Ticket/audit；多principal审核、跨机exactly-once和物理手机锁屏/杀进程仍不在该验收内。

**显示偏好已有同一条真实 Edge 链的专门检查**：全局默认折叠与 Task 自己的展开、再次折叠、刷新恢复相互不串值；并非把任意读取到的 effective bool 固化为本 Ticket 的 override。真正的 Node-authored `session_link` 通过中心读取后仅按显示偏好隐藏/展示，原消息、Ticket/Report/Artifact/Effect ID 与真实文件 hash 不变。各自的 scoped PUT 都有实际200响应与 payload 校验。API仍沿用 schema14 的 `settings.global_expanded` 和 Ticket preference 行，读取额外返回精确 scope/ID/是否有该行，帮助 frontend 区分继承与显式覆盖；不建立新 Grant、消息授权或 Worker 任务。认证失效、同一 Ticket 重复读、切换 Ticket 和 audit/轮询代际由 Vue 专项负例覆盖，见 `apps/web/tests/display-preferences.test.ts`、`tests/browser/run.mjs` 和架构第4.1.1节。这仍非多标签冲突协调、完整 DSH transcript、真手机或整个 M0 完成证明。

### M0 受限的真实编程样例（已验收，非普遍代码Agent）

已在本机隔离 DSH Profile、owned 干净 Git示例库、真实Rust控制面上完成一个小的 **源码修复及其真实验证**：Agent在当前 write Grant / binding / physical Node-worker / Assignment 下，通过真实 public scoped tool 只把固定`src/calc.js`的一处错误修复，并独立读取实际bytes、原始commit与unified diff；随后只执行固定的 `node --test test/calc.test.js`。每次Attempt交付对应一个实际 diff 与一个验证 Artifact（`loom.code-change.v1`/`loom.code-verification.v1` 的**证据内容**，不是新Ticket授权或通用协议）。

真实失败测试产生 failed Report和确认的文件effect，**不自动回滚或洗成unknown/无变更**；用户在driver明确准备clean的已知失败基线后正常retry，是第二个合法Assignment而非重复执行。中央与孤立DSH重启保留原历史、Session与字节hash而不再次执行。已完成一共1 ticket、2 assignments、2 reports（fail + succeed）、2 confirmed effects、4 artifacts（两个Attempt各diff/verification），不能误把重试后的新证据当成重复一份文件或把旧失败删除。失败Tool callback或源写入后续校验不完整必须保持unknown/reconciliation，不冒充“拒绝写入”。独立测试同时禁止非currentScope凭据、任意外部provider/model以及旧的ScopedAgent复用；缺许可的默认关闭配置没有code tool path。

本轮**可称已验证一个 M0 受限源码任务**，而非通用自然语言编程能力、自动worktree/review pipeline、live LLM、通用shell/编辑器或全M0通过。真实production Vue可打开该Ticket的两类Artifact（与两个per-attempt effects分别关联），桌面与390视口实际尺寸without溢出，不等于iOS/Android真机。证据和代码范围见 [tests/harness/CODE_TASK.md](tests/harness/CODE_TASK.md)。连接CLI `node tests/harness/real-code-task.mjs` 已反复0 exit；通用Source浏览器也完成full PASS而非只调用底层helper。

除真正执行与四个 Artifact 之外，现还补足**对应 Attempt 的可检查 View Process**。center严格保存/公开 whitelist 的 `loom.code-provenance.v1` 工具引用（schema14可空列，没有发布私有metadata、provider/env、prompt/transcript或任意tool命令），再检查精确代码文件SHA/大小、真实验証字bytes、固定命令、当前Assignment/Node、编辑→验证顺序及Effect/Report交叉关联。客户端需下载相关source/testproof并匹配当时的Assignment/effect/Retry report，才能在现有交付 UI 显示单文件diff、真实test退出码与输出及身份关联；错跨Scope/Hash/Session或缺失时只显示原字节不完整提示，并不靠最新Ticket总体成功伪装先前失败。

同时查清并修复了**报告级 Effect identity吞并**：第二合法Attempt复用旧Effect ID不能靠`INSERT OR IGNORE`吞掉新Effect，须比较原Scope/digest/status/evidence/Artifact引用并返回冲突；同Report重复ID也拒绝。Unknown effect保持unknown/对账，不因已知test byte或public proof升级成整体成功。实际 `cargo run ... -- smoke` 的跨Attempt report冲突已409且旧effect/Report不变，合法pending retry仍运行，第一份失败Report也保留。这个是本机实现与验收上的共享身份可靠修复，非新增Permission或确切一次跨机副作用。

**同一受限样例的“已写源码、尚未验证即用户中止”已验收。** 真正 `loom_fixture_verify.execute` 在固定 `node --test` 启动前停留，当前Agent的真实 user AbortSignal 和 `turn/end(aborted,user)`均在完成编辑之后被记录；这不等于有测试完成。Adapter释放自己该Assignment的 bounded gate 只解除等待，不证明取消；center已有停止意图又确认 SDK 实际中止后才保存 `cancel_acknowledged`。经过精确字节/Git/diff/tool 关联验证后，Ticket可保存一个真实源 diff 与一个 confirmed source Effect，但整个操作保持 unknown/reconciling，不产生验证 Artifact、测试成功宣称或回滚。普通 `unknown+confirmed` 及普通 cancelled upload 仍被拒绝，只有当前Ticket/Node/source hash 对齐的单一真 diff 作为例外留存，供这个Report引用。

该结果经 center与Host真实重开仍可用同一 Report/Effect/Artifact 读取，不新增工具调用。旧 reconciling Ticket 自动retry返回现有`400 invalid_request`且不生成新Assignment；随后显式创建新Ticket，沿用原有效Grant/Binding，得到新的Agent/Assignment/Session并真实测试成功。最终完整 driver 包含正常失败重试、这次中止和独立成功三组数据：3 tickets、4 assignments、4 reports、7 artifacts 和4 confirmed source effects，SQL完整性/audit chain也通过。它仍是当前 owner fixture 的**这一处前测试中止**，不是通用 pre-step/任意工具进程停止、移动真机、live LLM、多机或全M0完成。详见 [tests/harness/CODE_TASK.md](tests/harness/CODE_TASK.md)。

下一道受控补片已完成 **已领取、未出报告的源码编辑中的 Grant 撤权停止**：同一可由暂停查证的原作业在固定 verifier 子进程前获得真实 native `user` abort。Concierge 只对已经被 Node 实际领取且尚未出 Report 的原 `edit_file` 下发撤权对账帧，保持原始Grant/version/Grant immutable work、physical binding/assigned Node一致，查看 current revokedGrant为v2，不延长旧 Lease，也不把 `cancel_requested` 设成事实。Node在 durable/incoming/original active三方任务身份一致，且其原 wait/running/session-owner 成立后才调用 bound `agent.cancel({kind:'user'})`；`authority=false` 的本地撤权视图必须与 SDK取消原因分开。若缺真实 live claim，不会借旧Session或DB历史去取消/启动另一份 Agent。

撤权后，真源diff与整体 unknown 报告在Node outbox保留。旧 Artifact实际上报被 **409 outcome_unknown** 拒绝，该Report会因引用该未接受 Artifact而被**403 artifact_lineage**拒绝，不伪装成center接受的新效果。当前 revoked Ticket无新Report/Artifact/Effect，普通用户 cancel 的严格 `cancelled_change` 例外不会被套用；重开、重复poll和新Ticket尝试均无再次原生停止或第二源码执行。此前全部正常failed/retry/cancel阶段仍过，最终只增至4 Tickets/5 Assignments维持4 Reports/7 Artifacts/4 confirmed中心 effects。原生原因仍是SDK支持的`user`而非 `revoked`。 [实际最新driver证据](/tmp/loom-code-revocation-tested-wYGIiL/result.json) 与 [CODE_TASK](tests/harness/CODE_TASK.md) 说明这一受限v1→revokedv2 file-edit闭环；`tests/runner/grant-revocation-fence.mjs`另以真实HTTP、26个未执行的受控Task和33条 socket可读审计 验证未领取不能执行、旧 artifact/report 409与grant.revoke 审计不失真。没有扩展多工作类型、新的模型/Grant或任意工具，不把物理真机/全网视为已验收。

**用户撤权与普通未领取工作的实际控制也已有独立的 UI 证明**：在 Edge 中创建普通pending/running Assignment，但不先让Node领取，随后从权限页选择该精确Grant、确认撤销，收到同一Grant ID的200、真实`revoked_at`和版本1→2。原合同保持 immutable digest和原Assignment/Lease epoch，旧Lease不续，Ticket进入reconciling而非自动cancelled。两次真实Node poll均按原`LocalNodeRunner`返回`assignment:null`；临时fail-on-call executor未调用，outbox、报告、Artifact、Effect及目标文件保持零效果，以前成功Artifact的byte/hash不受影响。复用此已撤Grant的合法Ticket请求得到403 `grant_scope`且没有新任务，审计SHA链再次验证。

前端修复了真实Grant SQL不返回独立status却让卡片仍显示有效的问题，状态徽标以revoked_at优先；`revokeGrant()`也只在确认id正确的撤销receipt且读取到最新资源后完成。读取失败要明确区分“中心确认撤权但还没有最新快照”，不把旧有效badge当作实时权限。确认操作在POST后的资源刷新中也不会重复进入。普通已受理源码撤权阶段与此**未acknowledged**的正常用户权限收回不是一回事，不能把后者误宣为取消/终止/自动重启Agent。原有普通cancelled Ticket和401 credential recovery这同一回归中仍通过，现在已是含新撤权时序的11阶段，详细证据见 `tests/browser/README.md`。

**真正失败才允许重新尝试，Unknown结果不能重放成新执行。** 公开retry现仅面向已failed且没有停止意图的原Ticket，仍要求在它的原Grant未撤销时创建新Assignment/epoch，digest、Node/worker/binding与历史Report/Artifact/Effect不被替换。pending、running、cancelled、succeeded、reconciling等直接retry不再签发多余作业或伪造retry审计。等待人工批准的首Attempt走单独approved/source校验后共享签发路径，未被误包进failed-only电网。前端对未知对账提供不可提交的说明/禁用操作，并在用户确认前重新核对当前failed对象和选中ID，不以隐藏按钮代替服务端权限。

真实DSH源码单元已经在UI中完成这一条闭环：先以真实`node:test`的失败结果和diff/verification Artifact核对earlier failed，再由production Vue的重试按钮产生**恰好一次**retry，故后得到独立的第二次Agent执行与验证exit 0，第一笔失败的原始报告、Effect和两个Artifact在前后下载都保持原bytes/hash/ID。该种重试不是静默回滚，也不以最新总体成功掩盖历史失败；完整脚本仍保持取消、宿主/中心重开、原撤权隔离和真 实片段节点不可重试的证据。普通Edge里的reconciling按钮也已改为先对账，force-click不会发起retry或确认框，直接API照样拒绝而没有新Assignment。报告与固定场景见 [CODE_TASK](tests/harness/CODE_TASK.md)、`tests/browser/run.mjs` 以及真实source失败的UI retry链。

### 下一刀：M0 的最小垂直切片

一句话输入 → 创建一个 Ticket → 一个 DSH Worker 在授权目录内执行 → 产生一个可检查的 Artifact → 中心重启后恢复任务状态与结果引用。

先证明这条链路，再扩展项目索引、设备感知和多机调度。

- **M0/M1 的局部凭据引用切片**：单机隔离 DSH Provider 的一次合成 record 已跑通 `inspect present → 独立撤销 Grant + 真实检查 Artifact → real delete → 无播种 restart missing`。两次在线授权（含破坏性调用前）复验当前 Grant/Lease/Binding/原字节证明，错误 scope、篡改 Artifact 和撤权拒绝；报告也验算 scope digest 与 Grant 结果。只有元数据，没有真实 Secret 内容、凭据发现/克隆/联网、OS CredentialStore、生产 Provider 或远程授权。详见 [tests/harness/CREDENTIAL_REF.md](tests/harness/CREDENTIAL_REF.md)。

M1 局部新增：版本化 Inventory/ResourceObservation 已在本机验证 13 项针对缺失/陈旧/忙碌/未知/拒绝/权限隔离的测试，另有执行时 busy/offline/unknown 分支。`crates/concierge/src/inventory_probe.rs` 仅执行受限 canonical root、只读解析和显式 opt-in 的 `uname/system_profiler` 查询，未宣称真实 GPU/模型/图片能力。PlacementDecision 仅解释已绑定 Grant 的可用性，不另发证。接口和平台验证范围见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。
- **M1 的只读 Git 项目事实增强**：`node tests/projects/git-probe.mjs` 已调用真实 Git 提交/dirty 重探测，并检查 userinfo token 不进入公开 API、Inventory 或 audit；safe ssh/HTTPS 语义保留，未知 scheme 明确清洗。无 Clone、Fetch、credential 查询或远端可达推断，非 Git 目录仍不会伪造 revision。详见 [tests/projects/README.md](tests/projects/README.md)。

- **M3 的局部增量（`loom.model-binding.v1`）**：已在同一隔离 DSH Worker真实证明 `model_descriptor`读取原文字节及来源 Assignment → 注册 → `place_model`当前的独立批准 → **另外一笔** `invoke_text` Grant → 调用精确的`loom-stub/loom-stub-v1` SDK并产生真实文本Artifact和Session。两次中心/Worker授权验证和 fresh SDK目录source都严格，不能拿name/catalog model flag/revoked或retired source当新执行权。实际driver为[tests/harness/real-model-binding.mjs](tests/harness/real-model-binding.mjs)。没有general Provider Registry、任意模型选择/权重/下载/注册/激活/生成或第二物理机生命周期；v10只保留原始来源Assignment/digest以连接这一有限证据链，不改变其它Skill、Artifact、`invoke_text`和数据原权限。仍仅受限的一个fixture与单机单worker，未把用户首版skip的1+3 Compose测试伪称完成。

`ticket.status` 额外包含 `cancel_requested` 过渡态：停止意图已持久但尚未证实取消或完成对账，不能被 UI 当成最终取消。Task unknown/reconciling 不会被盲目重试。

## 3. 里程碑

**显式Memory来源现在是经过中心核验的关系。** 项目Memory不能把另一个项目的Ticket直接从客户端填入source_ticket_id；未知ID明确404、bogus数字字段拒绝且不写入任何Memory/审计。合法同项目引用、完全不引用历史的独立Memory、既有项目／用户scope编辑、linked Candidate撤销与再次接受均保留真实流程。候选撤回编辑后的Memory仍使用同一关联事务，没有自动学习、借引用来激活Ticket或创建新的执行Grant。实浏览器另已走过接受→显式project→user编辑且保留出处→直接删除linkedMemory使候选pending→再次接受新ID。另有先前driver没有随当前存储schema14同步更新而失败的问题已修正，当前重启重新读取schema14，而不是沿用user_version11的旧断言。`POST /memories`仍保留allowed optional source，校验来源本身不意味着原Ticket已成功或可继续执行。后续M0补片已另完成普通Memory编辑／无候选关联删除的独立action审计：同Memory实际修改／删除与审计同属一个现有Store事务，记录确实的旧／新版本、scope、出处与变更标记而不复制敏感正文，审计写入失败时原Memory及旧链完整回滚。真实SQLite故障注入、普通UI编辑、linked delete只允许原有candidate withdrawal、成功操作及重开均已验证。schema14与完整源出处规则不改，且不承诺其它旧源码、Ticket/Grant/外部Effect被回滚或所有历史正文已经归档。
详见 [tests/observations/README.md](tests/observations/README.md)。

## M0 — 单机任务闭环与会话可控

**要证明什么**

一个 Concierge、一个作为 Local Node 的 DSH Loom Plugin 和一个 DSH Worker 能完成真实任务；过程可恢复、结果可检查、默认聊天不被内部协作淹没。它可独立部署在 DSH 所在主机，无需另装 Rust Agent。

**本阶段包含**

- 单用户、单聊天入口、单可信 Host；
- Source / Trigger / Thread 的最小实现；
- Ticket、Grant、Assignment、结构化 Report 的最小持久模型；
- 一个本地 Project 目录的读写边界；
- Durable Effect 的最小链路、取消与重启恢复；
- Artifact 索引、执行证据和基础审计；
- Conversation / Activity / Collaboration 三层视图的最小版本；
- Agent / Worker 过程会话的默认折叠、按任务展开、发送者过滤与全局/单任务显示偏好；
- 消息、SessionRef 与 Report 的关联；首版可只实现一个 DSH 内部子 Agent 场景；
- 用户明确“记住这个”时的单条 Memory 保存、查看和删除；首版不自动归纳全部历史会话；
- 完整 DSH Loom Plugin 最小版本：主动出站注册、一次性配对、心跳、Assignment、SessionRef、事件、ArtifactRef 和本机 Grant；
- MCP 仅用于需要的工具通道，不代替 Node 协议；不强制装 Rust Agent；
- Rust Concierge / Types workspace 与 TypeScript DSH Plugin 的版本化协议验证；
- Vue 3 响应式界面，同一 Ticket 在桌面与手机浏览器可查看过程、收起会话和完成一次非敏感审批。

**本阶段暂缓**

- 多 Host 调度和动态资源分配；
- 通用 Model Registry 与模型自动放置；
- 跨 Worker 全量 Transcript 汇聚；
- 复杂任务 DAG、主动工作和跨会话自动习惯归纳；
- 从会话自动生成 Skill、自主执行 Skill；
- 任意行业生成 Pipeline。

**场景验收**

| 场景 | 通过条件 |
| --- | --- |
| Rust ↔ DSH 协议 | Rust Concierge 主动向配对节点签发任务与 Lease，TypeScript Plugin 承担完整本地 Node 语义；任一方升级、断线或崩溃不产生伪造状态 |
| 移动 Web 基线 | iOS 与 Android 浏览器可进入同一 Ticket、查看产物和展开允许的过程；锁屏、断网后刷新仍对应原 Ticket，不承诺后台仍在执行 |
| 编程任务 | 在示例仓库完成一个小改动，展示变更与验证结果，不访问未授权目录 |
| 资料处理任务 | 读取授权资料并生成独立 Artifact，不覆盖原文件，结果可追溯 |
| 中心重启 | 运行中和已完成任务均能恢复；外部失败不被伪造成成功 |
| 取消任务 | 用户停止意图被持久保存，不被自动恢复覆盖 |
| 多 Agent 小任务 | 主 Agent 委派一个子 Agent；默认只显示关键阶段，展开后能看到委派、回复和结论的关联 |
| 主动注册 | 插件使用一次性配对码 / 预注册证书主动向中心连接；中心完成身份挑战，未批准节点不能执行 Assignment；撤销后不能继续领取任务 |
| DSH 接入能力 | 真实验证任务提交、取消、运行状态、失败和重新打开宿主 Session；完整插件复用宿主日志和凭据机制，不私造不可恢复事件或手写 Profile |
| 显示偏好 | 全局折叠、单任务展开及再次折叠均生效，不改变 Task、Report 和 Artifact 数据 |
| 敏感过程 | 展开记录不暴露测试 Secret 或未授权文件内容；权限边界不只依赖 UI |
| 审计保留 | 隐藏过程后，任务授权、关键决定、结果和待处理副作用仍可查询 |
| 显式记忆 | 用户说“记住默认用中文报告”后可查看、修改和删除该 Memory；它不改变项目访问权限 |
| 记忆隔离 | 项目级偏好不在另一个项目自动生效；旧偏好不覆盖本次明确指令 |

**进入 M1 的证据**

至少两类真实任务完成端到端运行，并分别覆盖成功、失败、取消和重启。先根据实测确认最小领域模型，再冻结 M1 的 Registry Schema。

### M1 — 真实项目与设备感知

**要证明什么**

系统理解项目在哪里、设备实际有什么能力，并能把能力结论用于规划；它也能准确说明“不支持”和“尚未知道”。

**本阶段包含**

- Project Registry：Canonical Remote、Working Tree、Generated Workspace 和 Credential Location 分离；
- 本地修改探测、只读内容映射、ProjectRef 与 Assignment 连接；
- Host / Worker / Harness 注册和心跳；
- 硬件、服务、模型、运行时和队列的事实采集；
- “用户声明 / Host 自报 / Controller 实测 / 当前未知”的来源标记；
- Capability Probe 与能力不可用原因；
- Activity / Fleet 视图的只读版本；
- 能力检测的时间与缓存状态，避免把旧库存当作当前事实。

**本阶段暂缓**

- 自动跨机执行；
- 自动安装模型、Clone 仓库或下载权重；
- 将远程服务作为默认能力补齐方式；
- 根据单个图像生成演示推断通用媒体能力。

**场景验收**

| 场景 | 通过条件 |
| --- | --- |
| Git 项目 | 说明权威远端、实际工作树和未提交修改；只读任务不改仓库、不自动 Clone |
| 普通资料目录 | 能注册非 Git 项目，路径不被误当成全局 Artifact URI |
| 权限不足 | 能发现项目引用但拒绝读取；发现资源不自动产生 Grant |
| 本地图像能力问询 | 用户问“能否本地支持图片生成？”时，列出必要运行时、模型和硬件的实测状态；不能运行则明确回答不能、缺失什么 |
| 最小图像 Smoke Test | 只在环境已经满足且用户授权时执行一次小尺寸生成；证明可用性，不要求固定模型或专用 GPU |
| 无 GPU 设备 | 不误报图像生成不可用等于整个 Host 不可用；仍列出该 Host 可执行的其他能力 |
| 无本地模型 | 不假称存在模型，不自动外发数据或下载；提供排队、用户安装或经授权使用已有服务等选项 |
| Host 离线 | 显示离线及最后探测时间，不把缓存状态写成在线实测 |
| 工作负载变化 | 忙碌、显存不足或服务异常能与“从未安装”区分 |
| 库存到 Placement | 根据一次简单任务解释为什么选某 Host；没有合适 Host 时等待或询问 |

**进入 M2 的证据**

能力矩阵由实际探测产生，并覆盖能力存在、缺失、离线、无权限和状态过期五类情况；至少一个不具备图像能力的测试环境也得到正确、可操作的回答。

### M2 — 双机可靠交接

**要证明什么**

第二台可信计算机不是 Fleet 页面上的装饰；任务能在两个 Host 之间受控交接，失败时不会产生虚假交付或重复副作用。

**本阶段包含**

- 确定性 Resource Scheduler 与 Placement；
- Assignment / Attempt、Lease、心跳和 fencing；
- 任务级输入简报与 ArtifactRef；
- Host 间受控 Artifact 传输，大文件不经过 Router；
- 跨机 Structured Report、Effect Ledger 和 Unknown Outcome 对账；
- 无可用设备的排队、替代建议和显式重调度；
- Collaboration 视图增加 Host / Worker / Assignment 关联与跨机过程追踪；
- Package Manifest、内容寻址包 Store、OS / arch / Harness 版本兼容检查；
- 选择性 Rollout：管理机批准包版本，选择部分 Host，本机独立安装 Grant、健康检查与回滚；
- Bare Agent、DSH Loom Plugin 与其他官方 Adapter 的安装和启停，分别声明宿主兼容版本；
- 新机器可选手动安装，或通过**独立授权的 Ansible / SSH Bootstrap**引导；免密仅复用运维传输授权，节点安装后仍需主动注册和配对；
- 已有节点可通过自身通道后续升级；Bootstrap 不自动获得后续项目 / 模型 / 外发权限；
- 初始 macOS Host 之外，至少验证一个 Linux 或 Windows Host；其他桌面系统保留在明确支持矩阵中，不因 Rust 可跨编译就默认通过；
- Host 包按 OS / arch 独立构建、签名和回滚，平台服务、凭据库与目录权限走本机适配层。

**本阶段暂缓**

- 无中心任务争抢；
- 任意 Session 无损迁移；
- 通用 exactly-once 承诺；
- 多机动态任务 DAG 的所有优化；
- 任意第三方插件、全网自动更新、跨不受信网络部署；
- 直接同步本机安装目录、Harness Profile、凭据和私有模型。

**场景验收**

| 场景 | 通过条件 |
| --- | --- |
| 编程与分析交接 | Host A 读取项目并生成简报，Host B 返回分析 Artifact；双方只获得所需最小输入 |
| 纯文档流水线 | 跨机摘要、校对和产物保存可追踪，不依赖 GPU 或媒体模型 |
| 可选媒体流水线 | 若测试环境恰好具有授权图像环境，可作为附加实例；它不是 M2 的必要条件 |
| Host 离线 | 原 Ticket 保留；未执行、执行失败和结果未知被分别表达 |
| 重复回调 | 同一 Report / Effect 的重复投递不重复提交副作用 |
| Lease 过期 | 旧 Host 的后续执行结果不会被接受为当前权威结果 |
| 结果未知 | 进入对账或询问，不盲目重跑、不宣称成功 |
| 过程追踪 | 用户能按 Ticket 展开两个 Worker 的交接消息、Shared Brief、Assignment 和 Artifact 关系 |
| Host 侧原文不可用 | 中心显示摘要和可见性缺口；不伪造完整 Transcript |
| 选择性安装 | 一个已批准包仅部署到选中的两个测试 Host；未选中设备不改变安装状态，包签名与内容摘要在每台设备校验 |
| 平台不兼容 | 缺少对应 OS / arch / Harness 版本的设备明确跳过；不复制不兼容安装目录、不将整个 Rollout 伪报为全部成功 |
| 本机安装权限 | 管理端不能单方面获得新目录、模型、外发或宿主管理员权限；逐目标批准并保留 Secret 在本机 Broker |
| 安装失败回滚 | 激活后健康检查失败时回到上一个可用版本，其他 Host 不被无意义重装；断线时安装结果进入 Unknown 并对账 |
| 配置与 Skill | 可单独选择性分发不涉敏配置 / Skill 包；保存和安装仍不授予执行或自动运行权 |
| 免密 Bootstrap | 对选定 Linux 测试机通过预置 SSH / Ansible Installer 安装 Bare Agent；对选定 DSH 测试机安装插件。只使用已批准 Inventory / 凭据引用，执行固定安装任务，记录逐机结果 |
| 注册与安装分离 | 安装成功的节点仍需出站长连接注册和一次性配对；伪造或撤销身份的节点不能领取 Assignment；未配对不能宣称是可用 Worker |
| 最小安装权限 | 优先用户级安装；sudo、系统服务、防火墙修改、重启分别明确授权；SSH Key 不进入模型上下文，安装结束不提供默认长期 Shell 通道 |
| 无凭据机器 | 普通 Rollout 不暗中扫描或猜测登录；可提示用户手动安装或单独配置明确的 Bootstrap 授权 |
| Rust 跨平台 | 分别安装并运行覆盖平台矩阵的签名 Host 包，验证路径、进程、服务、凭据库和重启恢复；不把“编译成功”作为支持证据 |
| DSH 节点无重复 Agent | 已有 DSH 的主机只安装并配对 DSH Loom Plugin，即能注册、执行和展示本地 Harness / 模型资源，不强制再安装 Rust Host Agent |

**进入 M3 的证据**

至少两类不同载荷的任务完成双机测试，并完成断线、重连、过期租约、重复回调和未知结果故障注入。选择性安装必须通过一个官方 Host Agent / Adapter 包在部分目标上的部署、失败回滚和权限测试；在 macOS 之外至少通过一类 Linux 或 Windows Host 验证，另一个桌面系统保留为后续明确验收项。跨机成功、编译成功或安装演示本身不足以通过。

### M3 — 通用 Pipeline 与模型治理

**要证明什么**

用户能组合适合自己的多阶段任务，而不必由产品预装某条固定 Pipeline；私有模型、输入和产物始终受权限与位置约束。

**本阶段包含**

- 通用 Stage / Dependency / Artifact Lineage；
- Model Registry 的 Register / Approve / Place / Invoke / Retire 最小生命周期；
- Host 侧 Secret Broker 与模型/凭据引用；
- `local-only`、`no-copy` 和外发批准；
- 修改输入后只重跑受影响阶段；
- Pipeline 模板与自定义组合；
- 游戏资产、文档研究、代码分析等作为可插拔模板，而非控制面专用分支。

**本阶段暂缓**

- 自动寻找、下载和复制所有缺失模型；
- 默认把任务发给公共服务；
- 为不同任务类型复制一套任务与权限系统；
- 以单一行业案例代替全套验收。

**场景验收**

| 场景类别 | 代表性场景 | 共同通过条件 |
| --- | --- | --- |
| 科研与文档 | 项目资料检索 → 摘要 → 报告 → 引用核对 | 引用可回查，失败阶段可单独重试 |
| 编程 | 需求简报 → 独立 Worktree 修改 → 测试 → Review Artifact | 不覆盖本地修改，凭据不进入上下文 |
| 知识整理 | 多目录资料 → 去重组稿 → 版本化输出 | 权限隔离、输入与输出版本清晰 |
| 私有模型文本 | 授权本地模型 → 私有文档摘要 | 私有内容不被发送或记录到未授权位置 |
| 可选图像生成 | 本地文案生成 → 已授权图像运行时 → 版本化候选图 | 仅在测试环境支持时运行；谱系包含模型 Revision、参数与位置 |
| 不支持的能力 | 请求当前环境缺少的模型、图像生成或工具能力 | 明确缺口，安全替换或保持排队，不假称完成 |
| 局部修改 | 改变中间输入，仅重跑受影响后代阶段 | 未受影响 Artifact 保持身份与版本关系 |
| 权限撤销 | 运行中撤销模型、目录或外发 Grant | 新执行停止，旧 Lease 失效，未授权写入被拒绝 |

**通过标准**

至少三个不同任务类别使用同一套 Ticket / Grant / Assignment / Artifact 核心完成；额外类别专用代码只存在于 Adapter 或模板层。游戏资产案例只是其中一项可选回归测试。

### M4 — 多 Worker、多 Harness、多端与会话检查器

**要证明什么**

同机或跨机的多个 Worker、不同 Harness 能协作，桌面与移动端能访问同一任务脉络，但不因共享 UI、设备或模型而共享权限、记忆和全部过程。

**本阶段包含**

- 同机公司 / 个人 Worker 身份、目录、记忆与默认 Placement 隔离；
- DSH 之外的第二类 Harness Adapter，优先复用 Native API / MCP；如需专用 Runtime Plugin 则独立声明宿主兼容版本；
- ConversationSegment / MessageRef 的适配、分页、搜索和按权限导出；
- 对 Worker 内部会话、Worker 间消息和用户可见摘要分别设置展示策略；
- Harness 仅上报摘要、无法提供完整过程时，明确展示记录完整度；
- 任务级成本、设备、时间和通知预算；
- Tauri 桌面壳的真实安装、升级与最小本机操作，保留纯 Web 客户端；
- iOS / Android 的 Web / PWA 会话恢复、任务追踪、Artifact 查看、审批与通知入口；
- 根据实测需求决定 Tauri Mobile / 薄原生壳、推送通道与系统强认证接入；不把壳的构建成功当成可用性验证；
- 身份认证后的多客户端连接恢复、受限权限、实时断线提示，移动端无需保持连接才能恢复任务视图。

**场景验收**

- 两类 Harness 完成同一协议下的委派和交付，统一 Ticket 不强迫统一其内部 Session；不得为每个 Harness 重复实现控制面；
- 用户能展开两个 Harness 的协作链，也能回到无过程消息干扰的主对话；
- 搜索、复制、导出和引用过程消息同样经过权限检查；
- 公司 / 个人 Worker 不互相读取目录、凭据和长期记忆；
- Adapter 不支持完整 Transcript 时，UI 明示可见性缺口；
- 大量过程消息下主聊天仍可用，按需加载不阻塞任务状态读取；
- macOS、Linux、Windows 桌面 Host 均完成各自的安装、后台运行、凭据与恢复测试；至少一个桌面平台验证 Tauri 壳；
- 同一 Ticket 在桌面、一台 iOS 和一台 Android 真实设备上保持身份、任务状态和交流记录一致；允许少量平台布局适配；
- 用户在手机上只能看到其权限范围的内容；敏感操作有明确摘要和显式、近期设备确认，不能因为常用手机登录就无限授权；
- 手机锁屏、杀进程、网络变化后，运行中的桌面 Host 不受影响；移动客户端恢复时展示权威状态，不冒充自身为持续在线 Host；
- Web、桌面壳和移动壳的前端版本保持兼容；旧客户端不会误读新协议，断开部分客户端不会影响其他设备；
- Tauri Mobile / 原生壳只有在设备通知、认证、后台限制和权限用例验证后才标为支持；否则交付 PWA 并明确功能缺口。

### M5 — 习惯学习、Skill 建议与受控自主性

> 当前仅验证很小的**来源可查人工偏好审阅**子集：明确选择的真实同项目Source Ticket可形成最多32个引用链接的候选，来源去重/过期、明确接受/稍后/不再建议、精确派生Memory及撤回可恢复且有审计。 SQLite新增schema11 `candidate_memory_links`。原Skill的真实独立回放保持不变，且不能退化为workflow/Memory同一回看。 `node tests/observations/candidates.mjs --browser`、`node tests/skills/read-replay.mjs`为当前证据，详见[受限观察与审阅说明](tests/observations/README.md)。 尚未通过**真实沟通中的自动观察/有效抽象、候选内容/作用域编辑、冲突、批量历史整理、自然语言偏好质量、通用Skill归纳**，所以不把M5或N3标为完成。



**要证明什么**

Loom 能从使用中提出真正有用的 Memory / Skill 建议；长期记忆和主动工作改善体验，但不覆盖新指令、不扩大权限，也不以高频消息或建议制造价值感。

**本阶段包含**

- Concierge 路由记忆、Worker 私有工作记忆、Task Working Memory 与 Shared Brief；
- 记忆筛选、替代、归档、预览纠错与恢复；
- 轻量 HabitObservation：只记录经规则筛选的重复选择、明确反馈和成功工作流摘要；
- MemoryCandidate：从重复偏好形成可编辑的建议，说明来源、出现次数、适用范围和最近观察时间；
- SkillCandidate：从多次同类会话归纳名称、适用条件、输入、步骤、验证和产物，支持预览与编辑；
- 手动“总结这段会话为 Skill / Memory”和受控的批量历史整理；
- 候选的接受、拒绝、稍后处理、暂停建议、不再建议、撤销及派生内容清理；
- 保存 Skill 后的样例回放、版本和验证状态；
- 主动观察和 Speculative Work 的明确规则；
- 用户默认显示偏好与长期通知规则的持久化。

**本阶段暂缓**

- 未经确认把所有历史会话写入长期 Memory；
- 因技能来自多次成功会话就无人值守运行；
- 自动跨项目、跨用户分享学习结果；
- 未经审核把工具参数、私有路径、Secret 或完整会话复制进 Skill。

**场景验收**

| 场景 | 通过条件 |
| --- | --- |
| 重复沟通偏好 | 多次选择中文简报后提出一条带依据的 Memory 建议；用户编辑作用域后保存，其他项目不受影响 |
| 重复操作习惯 | 多次选择同一 Worker / 交付格式后仅形成候选，不自动变成 Placement Grant |
| 重复工作流 | 多次完成类似的报告整理后生成 Skill 草案，包含输入、步骤、验证和 Artifact，而非整段聊天摘要 |
| 手动提炼 | 用户选中一段会话要求生成 Skill / Memory，可分别保存并检查内容 |
| 拒绝与纠错 | 拒绝后不会马上用相同内容打扰；“不再建议”长期生效，且能撤销 |
| 敏感内容 | 会话含测试 Secret、私有模型或未授权资料时，候选不得复制这些内容 |
| 权限边界 | 保存或执行 Skill 不自动获得目录、模型、外发或长期无人值守权限 |
| 回放验证 | 已保存 Skill 在样例任务中通过预期检查；失败时标为未验证，不能宣称可稳定复用 |
| 指令冲突 | 新的明确指令优先于旧习惯；冲突时询问，不静默覆盖 |
| 记忆性能 | 不调用冷记忆时不会占用当前上下文，大量历史候选不阻塞正常对话 |
| 主动工作 | Speculative Work 遵守 Grant，敏感副作用仍需确认 |
| 展示偏好 | 会话折叠不会被误解为删除记忆、撤销授权或停止习惯建议 |

**通过标准**

使用一组人工构造的重复会话和至少一类真实使用记录评估建议：候选须来源可查、内容可编辑、拒绝可尊重、作用域不混淆。只成功生成一份 Skill 文档不足以通过；还必须通过权限、隐私、回放和冲突测试。

### M6 — 开放协议与生态验证

**要证明什么**

外部实现可以接入，而不是只有 Loom 自己的内置组件能理解协议。

**本阶段包含**

- 开源核心协调器、Host Agent、协议与默认 UI；
- 版本化 Resource / Project / Model / Grant / Artifact / Conversation / Memory / Skill Schema；
- Harness SDK 与 Source / Channel SDK；
- 用户规则、能力、设备定义、显示偏好，以及经用户审核并脱敏的 Memory / Skill 导入导出；
- 第三方 Adapter 的兼容性与安全测试套件。

**通过标准**

至少一个独立实现的 Adapter 根据公开文档通过协议、权限、故障和消息可见性测试；导入配置、Memory 或 Skill 不会隐式授予资源访问权或自动执行权。

## 4. 跨里程碑的北极星验收

### N1：本地资源可用性报告

用户问：“我的本地环境现在能做什么？能否本地支持图片生成？”

系统应按设备和任务类型列出：

- 已安装、已实测、仅自报和当前未知的信息；
- 硬件、运行时、模型、工具、服务和负载；
- 项目位置、保存形式及访问权限；
- 若不支持图像生成，缺的是模型、运行时、硬件、授权还是可用资源；
- 用户可选择的下一步：补充环境、指定已有 Host、授权其他服务、缩小任务或等待。

该场景不要求最终回答“可以”。**准确回答“不能”和“还不知道”，同样是核心产品能力。**

### N2：用户自定义的跨机成果

用户提出一个符合自己设备和项目情况的目标，Loom 能证明：

1. 知道输入在哪里、是什么保存形式，并获得恰当授权；
2. 选择执行环境的理由来自真实资源事实；
3. Agent / Worker 协作默认不干扰主对话，需要时可展开检查；
4. 没有共享不必要的完整 Transcript、凭据和私有资料；
5. 产物能追溯到输入、执行者、模型或工具、版本和保存位置；
6. 局部修改只重跑相关阶段；
7. 离线、重连、重复回调和不确定结果不会造成虚假交付或重复副作用。

游戏资产可以成为这个验收的一个实例，但不是所有用户的必答卷。

### N3：从真实使用形成可复用经验

用户多次完成同类任务后，系统可以提出：“我注意到你通常这样处理，要保存为这个项目的工作流吗？”

用户可以检查来源会话摘要，删去不应保留的信息，修改适用范围，再保存为项目级 Skill；稳定沟通偏好则保存为 Memory。之后的同类任务可以引用它，但每次资源访问和副作用仍正常申请授权。用户拒绝、纠错或撤回后，系统能够停止旧建议使用。

## 5. 多场景测试矩阵

每个里程碑按适用能力选择测试项；“不适用”必须给出环境或权限理由，不能直接跳过记录。

| 测试维度 | 最低覆盖要求 |
| --- | --- |
| 任务类别 | 编程、资料处理、知识整理、至少一个用户自己的高频任务 |
| 可选专项能力 | 文本模型、图像、其他媒体或专用工具按实际库存加入，不强制拥有 |
| 成功路径 | 新建任务、重复任务、局部重跑、结果再次读取 |
| 资源状态 | 无设备、单设备、多设备、忙碌、离线、恢复、状态过期 |
| 能力状态 | 已实测可用、未安装、版本不兼容、无权限、当前未知 |
| 项目形态 | Git 工作树、含未提交修改仓库、非 Git 资料目录、独立 Worktree |
| 故障 | 中心重启、Host 重启、Worker 崩溃、网络中断、Lease 过期、重复回调、Unknown Outcome |
| 权限 | 只读、写入批准、撤销、跨项目隔离、跨 Worker 隔离、Secret 泄漏检查 |
| 会话可见性 | 默认折叠、全局展开、单任务覆盖、按 Worker 过滤、分页/检索、导出、原文不可用 |
| 习惯学习 | 显式记住、重复偏好建议、Skill 提炼、来源预览、接受/编辑/拒绝、撤回、作用域隔离 |
| 学习安全 | Secret 过滤、跨项目误用、新旧指令冲突、无永久授权推断、Skill 未验证、回放失败 |
| 交付 | Artifact 哈希与位置、输入谱系、验证证据、未完成与失败说明 |
| 平台与设备 | macOS / Linux / Windows Host；桌面 Web、Tauri 壳；iOS / Android Web / PWA；每个已宣称 Target 都单独验证 |
| 移动边界 | 锁屏、杀进程、网络切换、通知点击、过期认证、敏感审批；移动离线不中断桌面 Host，不冒充长期 Worker |
| 跨端兼容 | 任务与消息同步、协议版本协商、旧客户端行为、设备撤销、部分客户端断线、跨端权限一致性 |
| 真实使用 | 不只跑固定脚本；让用户完成自己的目标，并记录误导回答、额外确认和恢复成本 |

每次里程碑验收应保存场景清单、环境快照、实际结果和失败记录。测试拓扑、确定性 / Replay / Live LLM 模式、硬断言与 Token 预算详见 [testing.md](testing.md)；该测试文档是实现与触发方案，里程碑的产品范围仍以本 Roadmap 为准。下一轮范围由这些证据调整，而不是仅按章节顺序自动推进。

## 6. 尚未决定的问题

这些是实现时会用原型和测试回答的问题，不提前伪装成既定事实：

- Concierge、中心存储与首个 Host Agent 的进程边界；
- 中心保存多少消息原文，多少内容仅以 Host 侧 MessageRef 引用；
- DSH 子 Agent 消息与外部 Assignment 消息的最小统一 Schema；
- 哪些行为属于“用户可见关键协作”，如何减少无意义的过程通知；
- 能力探测的缓存时长、健康检查和用户主动刷新机制；
- 哪些远程服务可以成为一等执行环境，以及对应的费用和外发批准模型；
- Artifact 内容寻址、跨机传输和重跑缓存的具体实现；
- Tauri Mobile 是否能满足实际通知与系统认证需求，还是应保留 PWA / 采用薄原生壳；
- 各桌面 OS 支持的后台服务方式、自动更新签名与系统凭据库实现；
- 移动离线访问的最小只读缓存，以及如何过期、加密与撤销，不把本地副本当权威状态；
- 多少次、多大一致性才形成习惯建议，以及如何对不同建议类型减少打扰；
- 原始会话与 HabitObservation / Candidate 的默认保留期限，以及删除证据后来源如何呈现。

## 7. 近期完成定义

Roadmap 的近期成功标准不是 Agent 数量、设备数量或是否做出了游戏图片，而是用户能自然地说：

> 它知道我的项目在哪里、我的环境实际能做什么；不能做的会如实告诉我。我只交代目标，平时只看关键进展，需要时又能看清 Agent 是怎么协作的。它会记住我确认过的习惯，把值得复用的流程建议成 Skill，最后得到可验证的结果。
