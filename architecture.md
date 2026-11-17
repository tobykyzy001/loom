# Loom Architecture

- 状态：设计基线 / proposed
- 日期：2026-11-16

本文保存 Loom 的长期架构约束、领域边界和不应随实现进度遗忘的设计判断。产品取舍见 [vision.md](vision.md)，分阶段验证见 [roadmap.md](roadmap.md)。

## 1. 核心不变量

```text
Agent ≠ Host
Worker ≠ Agent
Project ≠ Chat
Discovery ≠ Permission
Capability ≠ Grant
Assignment ≠ Ticket
Delivered ≠ Read
Unknown Outcome ≠ Failed
Collapsed Transcript ≠ Deleted Transcript
Visible Transcript ≠ Authorized Resource Access
Observed Habit ≠ Confirmed Preference
Saved Skill ≠ Standing Grant
Mobile Client ≠ Always-on Host
Device Reachable ≠ Device Trusted
```

- 控制面有唯一任务权威；执行环境和数据保持分布。
- 只共享路由、授权和必要工作简报，不共享全量记忆。
- 控制流经过协调器，大数据流尽量直达。
- 手机、IM 中的自然语言不是天然的系统授权；移动端敏感操作使用有明确操作摘要的显式、近期设备确认，必要时采用平台强认证，不能用长期记住的手机 Login 取代 Grant。
- 模型可以声明任务需要某种能力，但不能自行扩大权限。
- 没有合适的执行环境就排队或询问，不虚构已经完成的工作。
- 界面是否展示过程，与系统是否记录过程、用户是否有权访问过程，是三个不同问题。

## 2. 从 dsh-superagent 借鉴什么

参考：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。公开仓库是研究原型，不能将文章中的所有设想都视为已实现能力。

最值得借鉴的是控制面的四分法：

```text
Trigger → Eval / Decision → Mandate + Ticket → Assignment → Report
```

它把事件、授权、持久工作和具体执行分开，而非只给单会话加多个子 Agent。

### 2.1 保留的设计

| 机制 | Loom 的用法 |
| --- | --- |
| Trigger / Thread | 统一多端事件身份、顺序和幂等；来源消息不直接取得权限 |
| Policy Gate + Eval | 模型参与意图判断，代码负责准入；记录决定及依据 |
| Mandate / Grant | 授权独立于 Session；扩大范围必须取得新授权 |
| Ticket / Assignment | 工作可以换执行实例；一次执行故障不等于任务终结 |
| Delivered ≠ Read | 输入经过送达、纳入执行、形成报告等阶段，不能仅靠 MQ ACK |
| Durable Effects + Outbox | 先持久化待执行效果，再执行并保留恢复依据 |
| Structured Report / Attention | Worker 提交结构化状态、结果和人工问题，不靠自由文本猜状态 |
| Quiet by default | 只在有结果、需要决策、受阻或有价值进展时打扰用户 |

### 2.2 不直接照搬的部分

- **Ticket ≠ 本机 DSH Session + 本机绝对目录**：中心只保存逻辑 ProjectRef 和 Placement，Host 在实际执行时绑定本地 Workspace。
- **不承诺直接迁移 Session**：跨机迁移的是 Task、Grant、必要 Input、报告、Git 引用及 Artifact。
- **不让第二个 LLM 充当资源调度器**：Resource Scheduler 使用可认证的库存与确定性约束。
- **不把进程级命令 Shim 当隔离**：公司/个人 Worker 同机时，权限由 Host 强制执行，必要时使用独立 OS 用户或容器。
- **不把身份映射写进提示词**：跨端用户身份使用经过验证的 Principal 与 Device Link。
- **不把已有 Effects 当作跨机 exactly-once**：增加 Lease、fencing、unknown outcome 和确定性对账。
- **将 GitHub PR 生命周期移出通用核心**：通用任务以 Result、Review 和 Artifact 表示交付；PR 终态属于 GitHub 适配器。
- **SourceKind 与 SourceInstance 分离**：每种入口可以有多个独立来源，各自有身份、游标、Policy 和命名空间。

参考文档：[Domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) · [Authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md) · [Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md) · [Architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)。

## 3. 目标架构

```text
                   Phone / Web / IM / Other Sources
                                  │
                            Loom Concierge
                                  │
       ┌──────────────────────────┼───────────────────────────┐
       │                          │                           │
 Identity / Policy           Ticket + Grant           Resource Registry
 Router / Eval          Assignment + Placement       Project / Model Index
 Effects / Outbox        Lease + Reconciliation       Artifact Index
 Conversation Views         Task / Message Graph           Audit Index
       │                          │                           │
       └──────────────────────────┼───────────────────────────┘
                                  │
                     Authenticated Node Control Plane
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                      │
       DSH Desktop A           DSH GPU Host B         Bare Linux C
       DSH Loom Plugin         DSH Loom Plugin       Rust Host Agent
       Local Project           Local Model Worker    API / CLI Worker
       Local Context           Local Models          Local Checkout
           │                      │                      │
           └──────────────────────┼──────────────────────┘
                                  │
                   Task Reports / Grants / Artifact Refs
```

Host 数量、设备类型、模型能力和任务组合均由用户环境决定，不复制说明性场景中的固定机器名称。

设备角色分开建模：

| 平台 | Client | Host Agent 首版定位 |
| --- | --- | --- |
| macOS / Linux / Windows | Web / Desktop Shell | 已装 DSH 时以其 Loom 插件作为节点；裸机使用轻量 Rust Host Agent，逐步验证后台服务与开机恢复 |
| iOS / Android | Web / PWA，必要时薄原生壳 | 用户入口、审批、任务与 Artifact 查看；不是默认可靠的长驻 Host |
| NAS / 服务器 Linux | Web | 在资源和权限满足时可作为 Host |

移动设备受系统后台限制、锁屏、应用切换、网络迁移和电池策略影响，不自动拥有稳定 Lease，也不以持续轮询或 PWA 保活伪装长期执行能力。其能否作为有限、专有的 Worker，必须独立能力和政策验证。

### 3.1 Concierge 中心

负责：

- 统一聊天入口与用户身份；
- 意图判断、Policy Gate、Source 与回复 Channel；
- Ticket、Grant、Assignment 与结构化 Report；
- Project、Model、Worker、Host 和 Artifact 索引；
- Placement、Lease、资源配额与任务 DAG；
- 持久 Effect、恢复、对账及超时；
- 主 Agent 的路由记忆，不汇聚完整 Worker Transcript。

推荐初期采用中心单写者与事务化存储，不为了“去中心化”引入多主写入。

### 3.2 Local Node / Host Agent 职责

每个被纳管的执行环境具有 Local Node 身份，负责：

- 设备、硬件、服务和 Worker 注册；
- GPU、显存、队列、负载、模型的本地探测；
- 本机 Project 路径与 Workspace Grant；
- 本机 Harness / Worker 执行；
- Secret Broker 和实际权限执行；
- Lease 心跳、停止与过期；
- 本机 Effect Ledger 和副作用对账；
- Artifact 内容存储与受控传输。

中心不绕过 Local Node 的边界直接操纵其他机器的 Harness 内部服务，也不假定每台机器模型目录相同。Local Node 的主要包装有两种：

| 部署形态 | 实现与职责 |
| --- | --- |
| **DSH Loom Plugin** | 在 DSH 进程内实现 Local Node：节点注册、Profile / Workspace 标签、SessionRef、事件流、本地 Grant、心跳、ArtifactRef 和效果对账；复用已有 DSH Agent / Session，不要求独立 Rust Host Agent。 |
| **Bare Rust Host Agent** | 在没有 DSH 的桌面或 Linux 服务器提供相同 Node 协议，通过 Native API / MCP / CLI 管理 Worker 和本机资源。 |

两种 Node 都主动向中心注册；只有中心签发 Assignment / Lease 后，节点才执行相应副作用。同一节点上直接启动的模型 HTTP 服务属于该节点声明的 Runtime，并不要求再部署一个 Rust Agent；其本地 Secret、文件与监听地址由所属节点控制。DSH Plugin 是一等节点而非仅为补充 MCP 能力的薄插件。

节点可以访问自身 DSH 内部能力，不代表中心自动信任其自报权限。Owner、Device Link、Node Identity、Profile Identity 和 Workspace Scope 分开映射，避免把整台机器或任意 DSH Profile 混为同一主体。

### 3.3 Router、Project Scheduler、Resource Scheduler

三者不应混为一个路由 LLM：

```text
Router / Eval
  → 决定：是否做、做什么、依据与 Grant

Project Scheduler
  → 决定：任务 DAG、依赖、优先级、项目阶段及输入输出关系

Resource Scheduler
  → 决定：Host 能力、模型、位置、权限、负载与 Placement

Host Agent
  → 执行：本机启动、授权、监控、恢复、对账及上报
```

库存状态是资源事实，不是行动 Grant。

### 3.4 核心领域对象

| 对象 | 含义与关键边界 |
| --- | --- |
| Principal | 经过验证的人或组织身份，不是显示昵称 |
| SourceInstance | 一个具体消息、文件或系统事件来源及其游标和策略 |
| Trigger | 不可变事件；正文和元数据默认不可信 |
| Thread | 同一来源的连续事件与路由上下文 |
| Policy | 经过版本化、由代码执行的准入与行动规则 |
| Grant | 谁允许哪些动作、作用域与资源，以及何时结束 |
| Ticket | 用户工作本身的持久身份，独立于某次执行与 Session |
| Assignment | 将 Ticket 某部分交给一次执行实例，可更换或恢复 |
| Placement | 一次 Assignment 选择 Host / Harness / Worker 的结果 |
| Lease | 某 Host 在某时间内执行 Assignment 的短期资格与 fencing epoch |
| Conversation | 用户、Agent 与 Worker 交流的稳定容器；内部可对应多个执行 Session |
| ConversationSegment | 主对话、某个 Worker 内部交流或 Worker 间交流等可过滤的消息分区 |
| MessageRef | 对消息的引用，含发送者、接收者、任务关系、可见性和敏感级别 |
| SessionRef | 某 Harness 的执行会话引用；不能等同于全局 Task 或 Conversation |
| Project | 代码、文档、素材及位置、保存方式和权限的集合 |
| Worker | 某 Host 上有独立职责、上下文、工作记忆和工具权限的执行身份 |
| Model | 模型的身份、版本、调用方式和各 Host 放置情况 |
| Effect | 有独立身份、可恢复、可对账的副作用意图 |
| Artifact | 有版本、位置、语义、生成谱系和访问策略的产物 |
| Report | Worker 对 Assignment 的结构化状态、证据和人工问题 |
| HabitObservation | 对重复选择或工作流的临时观察，有来源、作用域、置信度和保留期限，不是长期事实 |
| MemoryCandidate | 等待用户确认的偏好或经验草案；接受后才成为对应作用域的 Memory |
| SkillCandidate | 从重复会话提炼的工作流草案，含适用条件、输入、步骤、验证和产物，不自动取得执行权 |

### 3.1 当前实现的资源与执行证据补充

当前开发基线使用 `InstallationResourceBinding` 表示“哪个 ProjectId 在某个 Node + Installation + Worker 的真实本地位置上如何映射”。Host 先声明候选位置，单用户管理员显式确认绑定，Grant 再引用绑定及 digest；**生命周期为发现候选 → 绑定确认 → Grant → Assignment/Lease**，不是发现即授权。Ticket/Grant digest 与绑定版本需要一致，不能指向另一个 installation 或另一个 root，且当前实现没有 fallback 到任意备用目录。节点本地 Executor 也应把中心签发 binding 与 operator 私有 config 的 Canonical Root 再次核验。

`ResourceObservation` 对应正在引入的 `loom.inventory.v1`。它至少具有名义资源、可选值、来源（用户声明 / Host 自报 / Controller 实测 / 未验证）、观测时刻、新鲜度、available/missing/unknown/denied/offline/busy/error/stale 等状态、放置范围和适用约束。**观测事实不能颁发 Grant**，Unavailable、Unknown、Offline、Timeout 和 Unsupported 不等价，更不得当成同一种“存在”。PlacementDecision 只解释当前事实与既有 Grant、Binding、Worker、心跳的关系，最终执行仍走原权威任务协议。`models` 未探测时明确 unknown，不默认存在模型/GPU或图片能力。

该补充是在前述长期架构上的实现策略，不替代其他 Domain 定义，也不宣称 M1 全套能力已验收。实际验证入口与缺口见 [BASELINE.md](BASELINE.md) 与 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。

本地硬件查看是一种显式、只读的 Controller Probe：只在进程选择 `LOOM_ENABLE_LOCAL_HARDWARE_PROBE=1` 时启用，固定使用当前OS自带命令及白名单参数（macOS 使用 `/usr/sbin/system_profiler` 和 `SPDisplaysDataType`，或同时读取 Hardware与Displays）。固定子进程超时、stdout/stderr上限和pipe结束上限均有处置；超时、超限、启动失败或无法解释的输出形成稳定error/unknown，绝不直接当成“此设备没有这个模型或 GPU”。不会保留原始报告、stderr、用户名、路径、serial/device UUID、bus或display详情。真实当前OS上的硬件来源标为 `controller_probed / local_only`；未验证 fixture 和 host-report不能冒充该来源。GPU/Metal只是一类设备事实，**没有**自动激活 Model Registry、图片生成Grant或其它主机的能力；模型未探测保持 unknown。


### 3.2 当前受限文档工作流的授权与恢复约束

控制器目前支持一种受限、版本化的两阶段 Document Workflow，而不是通用的行业 Pipeline 或任意 `Command` Graph。它复用现有 Host ProjectBinding 和已授权的 Ticket 与 Lease：

1. 校验两个实际 raw Grant、未撤销 ProjectBinding、ProjectId/Node/Installation/Worker 和所需 read/write operation，再创建授权的 `read_summary` Task。
2. 只有原 Task 真正成功，且其 Artifact 身份、来源、SHA256 和受限存储的真实 bytes 均有效，才可能创建 `edit_file` 子任务。**客户端不在这两个对象之间新增 Grant**。
3. 新 Assignment 也必须对应当前 ProjectBinding。下游文件执行器得到的受限 `artifact_input` 只包含已知 parent UUID、origin、source ticket、受控 Artifact location 以及真实 base64 bytes。Local Node 在副作用发生前验证源 hash 和引用，然后为自己的真实输出重新计算 hash；控制面再次校验 parents 与 known immutable dependency，禁止用客户声明的历史替代已验证谱系。
4. SQLite v4增量保存 `document_pipeline_runs` 与 `document_pipeline_stages`：定义、stage↔rawGrant、真实Ticket链接及停止意图。原Ticket、Grant、Assignment/Epoch、Effect、Artifact和Report依然是任务权威，pipeline只保存检查点与展示投影。
5. Unknown、Cancelled、Reconciling 的父阶段不能产生新 effect，且不自动重试。停止意图持久化，各 child 继续使用原有取消与恢复流程；不能改写已完成的文件结果，也不能把等待直接标成已结束。
6. 当前仅支持 `docs/` 内相对文件和四类文本变换。DSH 与 Bare 在未验证共享的 source input 之前，必须拒绝而不是偷偷丢掉上游 provenance 并声称完成。

所有类型与状态验证必须来自真实 HTTP 与文件 effect，不能因出现 `Pipeline` 类型和路由便推断通用工具或 Harness 已可执行。真实第二物理设备、Host直传、模型生命周期、Tauri/Mobile及其他Adapter需要另行验收。

### 3.3 受限父子 Agent 的委派与来源校验

当前已在同一个隔离用于验证 DSH Profile 中实际验证：父 Agent 完成一个正常授权阶段并产生原 Artifact 与自己真实的 Session 后，**另一个独立 Session** 的 child Agent 可在既有 Grant 范围内使用经过中心验证的来源生成实际输出。

- `POST /api/v1/nodes/assignments/source` 只接受当前 child Assignment、正确 Node 身份和有效 Lease。中心按本 workflow 的原始父阶段选择不可变 Artifact，验证其对应 Ticket、Project、真实 bytes/hash及父阶段普通 `session_link`，返回确定的 source proof；不允许 Worker 任意查询其它 Ticket 或 Session，也不给 Agent 管理员 token。不能仅凭 UUID、session 名称或 `parentSession` 推导权限。
- DSH 默认拒绝未验证的 `artifact_input`。显式的 `scoped_fixture` 只用于上述窄测例，通过公开 `ctx.agents.create` 的 `setup` 在 child 创建前登记 source-bound scoped Tool，并用 `meta.parentSession`建立实际父子关系。它不是任意文件写入、模型自报能力或另一套授权注册表，不自动称为跨机、跨 Host 或多 Harness 能力。
- 子 Artifact 的产生仍需有真实 ToolCall/ToolResult、正确固定 ProjectBinding root及被独立重算的输出 hash/bytes。父子 Session、source ticket、origin/hash、immutable parent 和新 child file Effect 要相互一致，并由中心确认不可变谱系。这一消息通过普通 `/nodes/events` 的下级 `session_link` 与 `delegated_from` 附在真实 child Ticket 下；`GET /messages?ticket_id=...`支持受限的精确 ticket 过滤，而不是返回全部或错误地只返回全局对话。
- 如工具已声明可能产生文件效果但证据不完整，不得忘为“失败/无副作用”或直接成功，应保持 Unknown 待对账。恢复也不能擅自执行第二次文件工具；验收比较真实原 ToolCall/Result、持久化 Session、报告与未改写的 bytes，而不是重演历史事件。

未验证此能力的 DSH/Bare Host 必须继续拒绝该输入。真实第二主机、外部 Provider 模型质量、一般生产文件操作和通用 Harness 委派不包含在这项已验证的小场景内。

### 3.4 当前的受限文本模型调用

当前还有一个窄的、真实 DSH `ctx.llm` 调用证据。它只支持这里明确测试过的 `loom-stub/loom-stub-v1` 文本 fixture，不冒充通用 Model Registry 或本地模型安装/激活。任务使用 `kind=model_text` 和 **单独的 `invoke_text` Grant**，不能用普通文件读/写授权替代。请求将其目标与精确 provider/model 写入受限 `loom.model-text.v1` 内容，循环利用 Node Binding、Assignment 和 Lease下发，不把路径或模型名字默认为运行权限。

模型选择由公开的 `ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall` 验证，runtime带 `{provider,model}` 调用prepare并检查冻结 config、文本模态及实际适配器流。`prepareCall` 只准备同一代adapter，policy本身的探查不执行stream，真正的文本又由普通 Agent Session followup、stream/assistant-message 和 turn/end 证明。新的 Artifact有相应独立 `loom.model-ref.v1`（来源、provider/model、Grant、输出byte hash和会话观察），不因目录写入或父Artifact引用就自动获得scope。

缺少这类确切选择、公开adapter、文本模态或权限时必须拒绝，不能改成实际未知模型的“存在/激活”。`model_text_tasks` 默认关闭，按Guest profile明确启用配置且仍需每次正确OperationGrant。普通文档授予的 read/write 在这里不提供调用，另一侧文本模型也不产生文件effect；scope之外的tool可能file效果保留unknown而非自动成功。

真实运行与限制见 [tests/harness/MODEL_TEXT.md](tests/harness/MODEL_TEXT.md)。整装的Registry、placement、activation、下载安装、实际模型质量和图像/跨机推理仍需另外实现与验收。下面的 catalog 投影只表达当前 SDK 元数据，不是本次实际Artifact/Grant的替代品。

### 3.5 受限的 peer Artifact 直接取源

已验证的基础 direct dataplane 不把所有 parent Artifact bytes 都让Concierge代拿。它复用现有原始 project、Grant和pipeline parent → child关系，只支持受限 `edit_file + trim` 且 `direct: true` 的 descendant。原Task的byte hash与不可变Artifact-query、现在的destination Grant / ProjectBinding / raw worker / installation / Lease 仍需满足；**直接 URL、Nonce或Id 本身不是权限**。

- B用自己的Node凭据请求 `POST /api/v1/nodes/direct-offers`。中心实际选择当前 child对应的父来源、列明原Origin、Ticket、读/写Grant版本与可用ref，随后持久v5 `direct_offers` 为每个 current ticket attempt保留irrevocable offer id和nonce。它不能在回放时重置DirectOffer或把已有Grant的权限换成共享来源。
- B为包括artifact/ref/recipient/installation/worker/ticket/assignment/lease/epoch/grants/binding/expiry可靠完整事实签名。A只允许明确数字 loopback 地址和自管辖的短临时HTTP server。A验证B的真实Ed25519 key和请求内nonce等事实，再调用普通 Node `/nodes/direct-offers/scope`让中心复核。这里**没有管理员token被转给任意Node或Provider**。重复/endpoint/hostname等不当调用一律不支持。
- 中心同时复查当前 destination attempt/running/cancel状态与lease/offer expiry，即使此前已有合法签名。因此 `cancel_requested` 不再意味着可从未使用的一次性offer继续窃取或写入下个effect。原read Grant/Binding/运行中Artifact origin / hash / Task健康也不能只凭早期已保存DirectOffer一直有效。generation和commit允许的默认路径不换样。
- A通过纯本机socket直接向B交付有界的原始bytes（目前为≤1MiB具体固定Asset），不是中心中转get_bytes，而本机绝对路径不作为全局Root。B必须再次检查真正的byte count/sha/origin及谱系，才能执行普通ControlledFileExecutor生成新Artifact。其parents loom://artifact/refs仍是不可变且有-verify的父连接，不能以UUID名字表明上代关系而已。
- Nonce由A私有状态持久化并单次消费，重开未完成的中心保留原请求凭据。但这不是所有端到端副作用保证一次，传输中途的未知须由Host reconciliation另行处理；错误签名/revoked/deadline/cancel/offline/oversize/shape未通过禁止生成新的file effect。
- v5 的新增direct_offers只是辅助关系，是[id,current attempt,artifact,recipient,nonce,key与definition]的保存，不是新任务权威，也不代替Ticket/Grant或Artifact。迁移采用IF NOT EXISTS；对legacy ticket/grant、原有Artifact bytes与审计链保持不覆盖。其它数据面和非本机部署继承须另行实测。

实际一次 source→socket→checksum→B Grant→child file验证在[tests/direct/README.md](tests/direct/README.md)，含取消 expires/lifecycle错误与重启幂等测试。它**不是**第二物理机连接/TLS保证、远程安装包部署、任意大文件默认可下载或全面M2完成证明。中途断流、nonce已经消费而下游结果不确定的自动收据/对账仍未完整验证，不可用一次领取或Model Observation替代未知付款的结果确认。

### 3.6 受限模型调用的可读观察

需要早期模型功能的第一个回答不是全套激活面板，而是**这一份实际任务用到了哪个资源、产生了哪一份Artifact、哪次Grant关联何来源**。在严格`model_text`的SDK返回Artifact时，Concierge只接受受限`loom.model-ref.v1`，核对原Task原始`loom.model-text.v1` provider/model、实际origin Node/Assignment、精确原`invoke_text` Grant和结果bytes SHA。它保存`model_observations`仅作**已登记Artifact的观察关系**，与Artifact在同一SQLite事务创建，不能独立预造。

schema v6新增可选的`loom.model-observation.v1`信息随现有Ticket Detail返回：原artifact/sha/ticket/assignment/node、精确provider/model、Text mode、host_reported来源、report-declared的执行/输出布尔值、observed_at/recorded_at、可选真实Session UUID、Grant与`grant_current`在读取时的状态。这里的`grant_current`仅表示原记录现未被撤销；**不是当前模型可用，仍须分别查证Node、能力、Lease等**。撤销Grant不删合法的过去任务及报告，而会阻止它成为新的授权。缺失/不同provider/model、其他Grant、错sha、假session UUID、image模态、对stub声称实际LLM均不得成为模型观察。

早期只有文件索引没有现存完整受限ModelMetadata的旧Artifact保持不补造此零散历史；否则仅以严格现状/原始字段记录这个信息缺口，不凭文件名或Goal假装知道做过什么。普通文件任务没有模型观察。 目前完整模型生命周期/激活/下载/通用Provider Registry仍未交付，不能把已实证的模型观察冒充全局`models registry`支持；Text Result也没有原生文件副作用。另有严格的`loom.model-descriptor.v1`注册/放置允许/撤档骨架（仅source byte+受类型约束的小model description），仅后述显式来源检查与元数据授权，不提供模型生成或完整推理工作流。

实际DSH SDK生文本、中心接收、原始Grant/Artifact及恢复后读取由`tests/harness/real-model-text.mjs`验证。模型报告本身是宿主报告，不是Conci erge独立验证任意商业LLM；Stub并不收费或触网。提供方功能、资源生命周期和质量评价仍分别NOT RUN。原任务详情只展示这个边界明确的观察，没有管理模型或浏览器读取Profile/凭据。

### 3.6.1 最新认证心跳的 SDK catalog 只读投影

`GET /api/v1/model-inventory` 在普通管理员认证后读取最新已持久 Node heartbeat 的 `inventory.model_catalog`，不是新通用 model Registry。输入是严格 `loom.model-inventory.v1 / revision:1`：实际上下文 Worker、公开 `ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall` 的来源、`host_reported` 和真实 RFC3339 观察时间。身份绑定已认证 Node Envelope 的 Node/Installation 和注册 Worker，不能用 body 自称另一身份、安装或 shadow worker。可选精确筛选不能扩大授权；原始 model body 不需要 node/installation 字段。

只接纳已有的 `loom-stub/loom-stub-v1` 文字 SDK fixture：`resource_state: adapter_observed`，`prepared_call_observed:true`，`generation_observed:false`，`input_modalities:['text']`，可选 context window ≤1048576，以及 `install/download/activation/generation` 全 false 的 policy。控制器检查strict字段与有界lowercase标签；不额外原样转发未知key、key/token/credential/endpoint、prompt或主机信源声明。它输出稳定Node/Installation/Worker/provider/model摘要ID，`source: host_reported`，`read_source: authenticated_node_heartbeat`，自己的 `catalogued:true, controller_matches:true`，但强制 `activated:allowed:executable:false`。Common `inventory.resources` 另经既有 `normalize_reported_facts` 处理，不能因为模型条目而覆盖controller直接硬件观测。

空models和合法 `requested_disabled`、`unsupported_*`、`lookup_*` finding是真实的“当前没有符合条件对象”，不是异常或旧模型presence。缺失/非法data、错误policy、unknown worker与错误scope分别输出missing/invalid和固定finding，不能沿用旧模型为当前fresh。观察时间与GET时间分离；现有heartbeat90秒阈值使`models[].freshness=stale`、`resource_state=unavailable`。重开沿用已在v8时期存现有表里的Node inventory；v9仅扩展descriptor授权元数据，不重写这些事实; GET也不会重新accessSDK、provider、stream或grant一个model_text任务。API policy是`read_catalog_only`，download/install/activation/general_provider_registry/image_generation/model_execution_grants不支持；下述局部descriptor Registry不是这些能力的实现。

签署Node的真实HTTP、负例与上线/缺失/恢复由`node tests/model-inventory/controller.mjs`要求验证；真实隔离DSH SDK一次prepareCall和stream/request零次由`node tests/model-inventory/real-dsh.mjs`另行实测。文本adapter观测绝不是任意付费模型、模型质量、下载安装、本地图片、通用provider execution、跨机或全M1完成证明。设备页已以`apps/web/src/components/ModelInventorySection.vue`呈现相同的认证投影，包含精确 Node/Worker、source/text modality、上下文窗口（token声明，不是内存bytes）与观察时间；读取只在进入设备页与用户手动刷新发生，未提供下载或激活操作。`node tests/model-inventory/browser.mjs`用真实签名 Node heartbeat 验证实际Vue请求与只读状态，长标识在390px换行，不改变已有Ticket/Grant/Node计数。它不是手机、生产目录管理或生成/安装能力。

### 3.6.2 本地模型描述符与独立的放置授权

`POST/GET /api/v1/models` 只支持实际Node的小范围`loom.model-descriptor.v1`证据，不是此前全模型管理API的同义复用。显式普通`read`Grant下的专用 `model_descriptor` Task只读当前项目`model.json`（UTF-8≤8KiB、严格五字段`schema/provider/revision/input_modalities/local_only`，本版仅`fixture-local-text/v1/text/local_only:true`），产生json proof Artifact。Proof保留`source_kind`、`relative_path`、`source_document`原文与`source_sha256`，另有独立的proof wrapper SHA。注册再次核对成功Ticket/Assignment/Report、真实Worker/ProjectBinding、当前readGrant、原Artifact索引与实际bytes的SHA、两层严格字段和 `sha256(source_document)==source_sha256`；非literal原文、outer↔document不符、secret键、路径/URL、weights或额外模态均不注册。不能让普通summary或write-effect wrapper冒充这个Artifact。

Schema v9仅在旧models/model_placements上增加null-permitting source和授权身份列，并新增`model_placement_authorizations`。已有v3/v6/v7/v8的Ticket/Grant/Artifact/audit不改写，legacy模型行缺证据也不补造。registry model永远`registered`而非installed/active，retire只标记`retired`保留Artifact/Grant/history。`place_model`是独立Grant operation，不含read/write/invoke_text插入。`POST /models/:id/placement-approvals`强制当前place_model Grant、digest、真实Node/Installation/Worker与相同ProjectBinding；重复相同范围幂等，其它Grant或修改hash拒绝。`/place`只在已有approval下记录“approved_for_placement（未运行）”，同一model+grant+binding返回旧receipt不重复写audit；它不创建Ticket/Assignment/Effect或模型执行。撤销Grant、retire后current是false，任何旧审批仍不可重新授权。没有runtime加载、模型质量、下载、激活、Provider切换、图片生成或自动Placement claim。实际文件生成、独有bytes SHA、负例、独立Grant与retire/reopen见[tests/models/README.md](tests/models/README.md)。

### 3.6.3 本地来源绑定与独立的实际文本适配器调用

SQLite v10额外保留**可选的原始源 Assignment** `source_assignment_id` 和 `assignment_digest`（DTO名 `source_assignment_digest`）。它们关联真实 descriptor-read Assignment 与其**逻辑输入规范**：实际Assignment ID、`model_descriptor`、`model.json`及其无正文（由持久化`NULL content`表达）的紧凑 SHA。它不是描述文件原byte SHA、Proof Artifact SHA、后续`model_text` Assignment digest或模型权重。旧v8/v9记录只能保留其现有元数据，不能补造来源Assignment证据。真实完成Effect中的`input_digest`与该Assignment字段必须一致佐证，不能再只把hash藏在`effect.evidence`而上传空的顶层字段；对应的Immutable Artifact UUID也在Effect中保留。

新增新票时的`model_id + placement_id`只允许选取已注册来源。中心从实际store组装 `loom.model-binding.v1`（**不从接手body复制引来Key/token/root**），必须有对应sourceTicket/Artifact、注册SHA、精确源Assignment digest及当前**另一个**`place_model` Grant/批准/放置票据。`POST /tickets kind=model_text` 现在还需要**单独的** `invoke_text` Grant：目录/profile能力不能充当这两个权限，place授权也不能自动转义为 invocation。

在每个Node poll发放这新任务时，controller重新查阅：`bound_for_invocation`核对当前Model registered/status/immutable source Ticket+Artifact、原Assignment一致性、精确Node/Installation/Worker/ProjectBinding、当前place Grant/批准与SHA；还要求**本认证Worker最新**严格 `loom-stub-v1/loom-stub` 适配器观察，`prepared_call_observed`、text-only、fresh、`generation_observed:false`、`permission_granted:false`等严格条件。任何retire、撤权、过期、缺失、错误Worker/来源或缺Scope均拒绝发放。不会由Model Registry GET或heartbeat中的flag重新探测、下载、激活模型或生成额外Ticket/Grant。

DSH host也会在 **每次实际 SDK prepare/stream前** 再审同样的13个固定binding字段、两项不相同currentGrant及当前scope/digest；必须确认当前immutable request/binding及没有`artifact_input`升格。Poll中给`assignment.grant`增加ProjectBinding的派生`project_root`时，只有精确的当前`resource.root_scope`才接受这个非持久附加字段；其它真实Grant事实（身份、operations、scope、digest/version/revoked/binding）仍逐条对比，绝不因一个project_root或all-shape差异而忽略伪造Grant。

本小步已由 `tests/harness/real-model-binding.mjs` 的真正同源worker读取源→注册→place→独立invoke→实际SDK→新Artifact/Session通过；`real-model-text.mjs --browser` 以同样前置raw-source/place许可旧路径完成且读取已发生于前次任务的授权历史回调。源Descriptor读取并不产生模型Agent会话，另一次调用才有此次Assignment、`request`和文本Artifact。它**只支持固定的fixture-local-text/v1描述和loom-stub适配器绑定**，不是生产模型注册/安装器、通用Provider连接器、任意模型权重/activate/invocation、图像生成或跨物理机模型生命周期；Raw Grant/CredentialStore/current Profile 未使用，也未下载任何真实模型。可验证脚本与边界见[tests/harness/MODEL_BINDING.md](tests/harness/MODEL_BINDING.md)。

### 3.7 受限技能候选与具体重放证明

当前 `SkillCandidate` 与 `Memory` 不共用验收语义。只有**已真实执行过的一个确定性 `read_summary` 样本**可用于当前受限技能重放，不支持任意命令、脚本、HTTP connector、模型学成的通用技能或代理执行。`source_refs` 必须实际含该 source ticket，候选 project、原 Node/Installation/Worker、Grant digest/version、ProjectBinding及其声明 Root都要对应。

`POST /api/v1/candidates/{id}/replay` 在原受信过程及当前权限存在时创建**另一个普通只读 Ticket**，带实时 Assignment/Lease，不复制原始Artifact。它只有等待执行的意义，不是原始标成 Skill 的工具。重放必须重新经过Node、原Grant/root-binding的普通任务流程及报告，产生不同UUID的采样Artifact；controller各自读真实存入字节重新计算hash，要求原内容与replay逐字相等并有确定`loom.synthetic_summary.v1`形态，才保留`loom.skill-replay.v1`验证证明。版本号与SQLite v7完全独立。

Review时客户端`replay_verified:true`不构成证据。完整原source/新replay Assignment、node/worker/attempt/lease和ticket终态、stop意图以及candidate实际附着的source_refs都要一致。First acceptance前必须原Grant尚未撤销、当前Binding及匹配root/worker仍有效；已撤 Grant/Binding的过去replay可以提供历史说明，但**不能因此创建本新的技能审核记录**。已保存skills只是该条作业的proof索引，不是长期执行凭据。`undo`撤销该审核记录，不执行Grant回滚、不重复Task、不抹掉原Artifact或审计，而Memory accept保持独立工作路径。`verified_at`是第一次实际proof形成时间，不因GET刷新。

[tests/skills/README.md](tests/skills/README.md) 的`node tests/skills/read-replay.mjs`真实运行了候选/回放/接收与改变输入不匹配、撤权与重启恢复。示例页面 `apps/web/src/views/SkillsView.vue` 增加独立Skill证据审阅，不把skill并入Memory或发起通用执行。用户可读取实际source_ticket绑定的原始Task引用，核对Replay Structure与其新Ticket、source/replay Artifact UUID与SHA；只有用户确认后才发送**唯一**`source_ticket_id`开始普通只读Ticket。仅查看证据/刷新不会自行执行或偷偷建立Grant。

前端会以**受限的按需详情读取**补足列表所没有的Task Artifact/Report；不把列表/summary状态的`status=succeeded`误当真实Artifact证明。等待worker、字节不一致或未知证据不能被背景屏幕标记为verified/accepted。用户随后**另行**确认accept/reject/undo，不会由页面加载自动存档，也不能用`Replay Button`立新的Skill激活。Grant撤销必须阻止首次保存，过去proof仍是只读历史，不可变成可执行、授权或模型入口。有向的与原任务/回放Ticket的实体关系可以回任务详情，不把Skill建议和输出Artifact混成另一层权限。普通worker仍通过原Grant执行，不来自浏览器。

`--browser`实际验证明示的replay请求与后续human审批，还包括真实worker与Source/Output SHA；390px没有溢出的关键UUID信息，不等于移动真机或多平台验收。当前仍无通用技能runtime、记忆跳跃获授权、分布式技能分发或持久的Skill执行引擎，不能把其视为M5全部完成。

## 4. 会话可见性与审计架构

### 4.1 默认简洁，过程可展开

用户面对一个稳定联系人，但一个 Ticket 可以产生多个 Agent / Worker ConversationSegment。UI 至少区分：

- **Conversation**：用户提出的需求、必要确认和最终结果；
- **Activity**：任务阶段、执行位置、关键状态与阻塞；
- **Collaboration**：Agent / Worker 之间的消息、委派、回复和共享简报；
- **Worker detail**：某次 Assignment 的执行 Session、工具调用摘要、产物和报告。

界面提供全局偏好与单次任务覆盖设置：默认折叠、始终展开、只看关键协作或完全隐藏过程。偏好不得改变已保存数据，也不得绕过访问权限。

### 4.2 展示与协议边界

- 不把所有 Agent / Worker 之间消息转发到用户主聊天流。
- 不把原始 Transcript 当作结构化状态的唯一来源；消息展示与 Report / Effect / Artifact 记录分别建模。
- 消息需有稳定 ID、Ticket / Assignment 关联、发送者与接收者、时间或顺序信息、来源和可见性策略。
- 展开视图至少要能回答：谁在协作、为何委派、交接了什么、达成了什么结论、哪里需要用户。
- 工具调用可默认展示摘要，原始参数和输出按权限与敏感级别访问；不得因“可展开”而暴露 Secret、私有模型权重或越权项目内容。
- 外部 Harness 的内部 Session 通过 Adapter 映射为 ConversationSegment / MessageRef，不要求统一其内部存储格式。
- 不支持读取完整 Transcript 的 Harness，应明确标记可见性缺口，不得伪造完整交流记录。
- 折叠或隐藏只改变视图；保留、归档与删除策略独立控制。
- 用户可隐藏或删除自己的过程展示，不代表系统可以删除尚未完成的 Grant、Effect 和必要审计事实。
- 消息导出、复制、检索和跨 Worker 引用必须重新检查可见性与 Grant。

### 4.3 存储与性能边界

初期不要求把全部原始 Worker Transcript 汇聚到中心。中心可以保存：

- 用户主对话和关键协作消息；
- 有界 Shared Brief；
- 指向 Host 侧原始 Transcript 的受控引用；
- 消息索引、可见性、摘要和审计元数据。

用户展开细节时，可以按需从有权限的 Host 获取。离线 Host 的不可读取记录应显示“暂不可用”，不能把摘要冒充完整原文。

## 5. 记忆、上下文与归档

### 5.1 记忆分层

| 层 | 内容 | 默认行为 |
| --- | --- | --- |
| Concierge Memory | 用户偏好、Agent / Host 索引、授权关系、活跃项目索引 | 长期保存，路由时按需使用 |
| Agent / Worker Memory | 各角色长期规则、项目经验和局部上下文 | 留在所属 Worker，不默认共享 |
| Task Working Memory | 当前约束、阶段状态、错误、局部决策 | 只交给相关任务和后续 Worker |
| Shared Brief | Worker 提交给协调器的结论、证据、阻塞与 Artifact 引用 | 有界、结构化、与权限分开 |
| Cold Archive | 原始会话、日志、旧资料、生成参数和历史版本 | 不主动注入，按需检索和恢复 |

### 5.2 记忆保留规则

- 当前活跃任务的约束优先保留；
- 用户确认的稳定偏好和长期安全规则不会因时间自动过期；
- 被替代的信息标记为历史版本，不当作当前事实；
- 原始过程与老日志进入冷档案，不反复占用 Token；
- 重复、无效中间过程可以淘汰；
- 未完成的承诺、Grant 和审计事实不能由模型自行清理；
- 长期记忆的自动整理支持预览、纠错和恢复。

记忆可见性不等于资源访问权限。即使某 Worker 看到项目引用，也不自动取得该项目的读取权。会话折叠偏好是展示设置，不是记忆清理指令。

### 5.3 从使用习惯形成 Memory / Skill 建议

采用“观察 → 提议 → 审核 → 保存 → 验证 / 撤回”的生命周期：

```text
Explicit Remember ───────────────────────┐
                                        ↓
Conversation → HabitObservation → Candidate → User Review → Memory / Skill
                       │                        ├→ Reject
                       └→ Expire / Forget       └→ Edit → Save
```

**显式记住与自动建议分开：**

- 用户明确说“记住我偏好……”时，可以直接保存为明确的 Memory，但敏感信息、权限和无限期后台行为仍需单独确认；
- 系统观察到稳定习惯时，只创建临时 HabitObservation，不直接写成长期事实；
- 多次出现且足够一致时，生成 MemoryCandidate 或 SkillCandidate，在合适时机集中提出，避免每次会话都追问；
- 用户可预览、编辑、接受、拒绝、稍后处理、暂停此类建议或永久遗忘；
- 接受 Memory / Skill 时可以限定全局、当前项目、某 Worker 或某 Host 作用域，默认最小可用范围。

**Memory 与 Skill 的边界：**

- Memory 表达偏好、事实和过去确认过的经验，例如“报告默认使用中文”“此项目优先使用指定 Worker”；
- Skill 表达可复用的任务方法，至少包括名称、适用条件、必要输入、步骤、验证方式、预期 Artifact、来源和版本；
- 持续性操作步骤不应只埋在 Memory；不确定是否稳定的选择不应固化成 Skill；
- Skill 保存后仍需经过测试或样例回放才能标为已验证，运行时的资源、路径、模型和副作用权限逐次由 Grant 决定；
- 工作流中包含 Secret、完整私有会话或不必要的原文时，候选必须排除或引用化，不能复制进 Skill 正文。

**来源、冲突与保留：**

- 候选保留来源 Ticket / ConversationRef、出现次数、首次与最近观察时间、作用域及摘要；出于隐私设置的证据不可用时，显示“依据不足”，不得编造出处；
- 用户可以查看候选依据，也可以删除用于学习的历史记录；删除后是否撤销派生 Memory / Skill 应给出明确选择；
- 新的明确指令优先于旧习惯，候选与已有规则冲突时必须询问，不得静默覆盖；
- 不能仅凭“用户经常批准”推断出永久授权；Grant、Policy 和审计事实绝不能由习惯学习自动扩大；
- 被拒绝的建议应降低同类提醒频率，用户可选择“不再建议”；拒绝本身不得被模型重新解释为一个新的长期偏好；
- 候选及其接受、修改、拒绝、停用均有审计记录，但普通操作日志不应因此无期限保留。

## 6. Resource、Project 与 Model Registry

### 6.1 Host / Worker 能力声明

```yaml
host: gpu-example
online: true
hardware:
  gpu: Example GPU
  vram_total: 12 GiB
  vram_free: 9.4 GiB
services:
  - kind: comfyui
    endpoint: http://127.0.0.1:8188
models:
  - ref: example-model-revision
    kind: lora
    placement: local-only
policy:
  public_upload: deny
  external_model_download: ask
```

字段值仅为 Schema 示例，不代表用户必须拥有 GPU、ComfyUI 或本地模型。

信息来源：

- Host 自报硬件、目录、Worker 和在线状态；
- Controller 实测模型健康、显存、队列、服务与延迟；
- 用户声明生产用途、隐私范围、是否允许无人值守；
- 历史记录提供冷启动时间、成功率和任务耗时。

Worker 自己宣称“可以跑”不是最终资源事实。

**能力未知也是一种有效探测结果。** 没有本地图像生成能力、没有兼容运行时或无法读取某台 Host 时，系统必须返回未安装、不支持、未实测、离线或缺少授权等明确状态，而不是输出静态“可用能力”清单。

### 6.2 Project 位置模型

必须区分：

1. **Canonical Remote**：GitHub / GitLab 等权威远端；
2. **Working Tree**：某台机器上正在修改的工作树；
3. **Generated Workspace**：某次任务创建的 Worktree、分支或临时目录；
4. **Credential Location**：允许 Clone、Pull 或 Push 的凭据位置。

```yaml
project: example-project
locations:
  working_tree:
    host: trusted-host
    path: /work/ExampleProject
canonical_source:
  type: git
  remote: git@github.com:me/ExampleProject.git
  branch: develop
contents:
  docs: docs/
  references: assets/references/
permissions:
  read: granted
  write: ask
```

行为要求：

- 优先复用已授权的本地工作树，避免重复 Clone；
- 检测到未提交修改时保留并明确说明；
- 并行代码修改优先使用独立 Worktree；
- Clone 是独立操作，不是“知道有 Git URL”就自动执行；
- Git 或登录凭据留在本机 Broker，不进入模型上下文；
- 不把某机器的本地绝对路径当作全局 Artifact URI。

### 6.3 模型的注册、批准与放置

Model Registry 管模型的身份、版本、适用环境、可用范围和放置计划；Host 管实际存放、加载与调用。

```text
Register → Approve → Place / Load → Invoke → Retire
```

- 私有模型可以声明 `no-copy`、`local-only` 或指定 Host 专用；
- 中心可以看到模型元数据，不等于可把权重复制到另一个环境；
- 外部下载、公开上传、模型迁移分别有权限；
- 权重不进入提示词或普通事件记录；
- 任务结果记录模型、LoRA、参数、Revision 和执行环境。

## 7. 首版技术栈与 Harness 接入

### 7.1 首版实现语言与多端结构

首版采用 **Rust 核心 + TypeScript / Vue 薄客户端**：

- Concierge、Host Agent、Registry、Policy、Lease、任务状态机和持久化应用层使用 Rust；
- 共享协议与核心数据模型放在一个 Rust workspace，减少控制面与 Host 的定义漂移；
- 默认 Web / Desktop / Mobile UI 使用 Vue 3 + TypeScript；Rust 核心与 Web 前端通过版本化 API 通信；
- 桌面壳优先采用 Tauri，以复用 Web UI 并调用受控的 Rust 本机能力；Tauri 的桌面集成不自动证明 iOS / Android 后台能力；
- 移动端基础采用响应式 PWA，先验证近距离网络通信、通知与强认证；需要应用商店、后台推送和系统能力时再包装为 Tauri Mobile 或薄原生壳；
- 共享 Vue 领域组件按需要保留平台适配层，不承诺“同一套 DOM 和所有权限在五个平台原样运行”。

首个开发基线仍是 macOS 上的单用户任务闭环，随后逐个验证 Windows / Linux Host，而不是核心写完就宣称全平台支持。移动浏览器和桌面壳的会话恢复从 M0 开始验证。

**Rust 的核心价值**是 Host Agent 的单二进制部署、资源占用、进程与文件边界，以及被多个桌面平台共享的策略执行逻辑；不是消除所有平台差异。SQLite 事务驱动、Tokio async runtime、HTTP/WebSocket/SSE API、操作系统 Keychain / Credential Manager / Secret Service 适配等具体 crate 通过 M0 Prototype 选型。

**跨语言不是异常路径**：DSH Loom Plugin 保留 TypeScript / JavaScript；已有 Harness、LLM、ComfyUI 或 Python 助手保留原语言，通过版本化 HTTP、MCP 或受限本地 RPC 通信。核心禁止把 Rust struct、内存指针或私有 FFI ABI 当成公共 Harness 协议。

```text
Vue 3 + TypeScript
  ├─ Web / PWA（桌面与移动浏览器）
  └─ Tauri Shell（桌面优先；移动按需）
                │ Versioned Client API + Strong Device Authentication
                ▼
Rust Concierge / Control Plane
  ├─ Persistent State / Policy / Lease / Artifact / Registry
  └─ Outbound, Authenticated Node Registration
       ├─ DSH TypeScript Loom Plugin（Local Node，首选 DSH 接入）
       ├─ Bare Rust Host Agent（无 DSH 的设备）
       └─ Runtime Connector：API / MCP / CLI / Python
```

### 7.2 不为每种 Harness 强制开发插件

DSH 通过专用 Loom 插件接入；其他 Harness 各自需要 Adapter 实例，但不等于每种都需要安装进 Harness 的插件：

| 接入方式 | 使用条件 | 主要部署位置 |
| --- | --- | --- |
| Native API Adapter | 已有任务、输入、取消和状态查询 API | Host Agent 旁的独立进程 |
| MCP / Tool Adapter | 标准工具或配置连接已覆盖必要行为 | Host 本地服务或 Harness 配置 |
| CLI / Process Adapter | 只能可靠启动和观测进程，且产物边界可确定 | Host Agent 的受管子进程 |
| Host Runtime Plugin | DSH 的正式本地节点，或其他 Harness 确实需要的 Session 事件、细粒度取消和进程内状态 | 各 Harness 自己的进程 |

| Harness / 服务 | 首版策略 |
| --- | --- |
| DSH | 专用 TypeScript Loom 插件作为 Local Node，主动注册中心；任务、SessionRef、事件、Artifact 和本地权限直接适配，MCP 只作为辅助工具通道 |
| Bare Host | 轻量 Rust Host Agent 提供同一 Node 协议，供无 DSH 的桌面 / Linux 服务器使用 |
| 其他 Harness | 优先 Native API / MCP，其次 CLI；确需同节点内部状态再增加专用插件。不复制 DSH 独有实现，也不因接入了名称而承诺 Session 级能力 |
| LLM / 图像等模型服务 | 直接使用已有 HTTP / API Connectors，不默认编写 DSH 或模型服务插件 |
| ComfyUI | API-first 的模型 Worker Connector，而非通用 Harness 插件 |

DSH 的 MCP 配置只提供工具接入；它本身不能证明完整的 Assignment、取消、Lease 和恢复语义。DSH 插件需要采用其版本兼容的会话机制：不私造不可重开的 Session Event，不把插件缓存当作唯一事实。配置通过宿主支持的编辑器持久化，Token 等 Secret 放入宿主 Credential Store / 本机 Broker，不手写用户 Profile 文件。具体接口按对接时的 DSH 版本验证。

Adapter 通过 Node / Adapter Capability Declaration 告诉中心它支持哪些操作，例如 `register / submit / interrupt / resume / events / artifacts / transcript`。未支持的能力必须在 UI 显示缺口，不得用状态轮询伪造完整会话。

### 7.3 主动注册与中心权威

```text
Install Plugin / Bare Agent
  → Configure Trusted Concierge Address
  → Generate Node Keypair + Device / Profile Identity
  → Outbound HTTPS / WebSocket Hello + Signed Challenge
  → Short Enrollment Code or Pre-provisioned Certificate
  → Center Binds Node + Owner (first enrollment requires explicit trust)
  → Node Receives Node-scoped Capability / Policy
  → Periodic Inventory / Heartbeat
  → Per-Assignment Grant + Lease
  → Execute → Report → Reconcile
```

- 节点启动后**主动**连接中心，不要求中心直连各 DSH 的管理端口；NAT / 防火墙后的节点可以出站长连接。
- 主动注册只代表可发现或已认证节点，**注册本身不是任务 Grant、目录访问或无条件 Membership**。首次加入需一次性配对码、预注册设备身份或管理员批准；凭据自动取得不等于信任自动扩张。
- 节点配置中心地址和最小凭据；中心对节点进行身份挑战。节点也必须验证中心 TLS / 签名身份，不能只因内网 IP 就上传私密库存。
- 节点保存可重放的 Outbox 和幂等上报；协议版本不兼容、中心离线、Token 撤销时明示状态，不盲目清空任务或重复副作用。
- 同一 DSH 的多个 Profile / Agent 可以作为独立 Worker / Tenant 命名空间。Profile 的隔离级别要如实声明，不能把安装在同一 DSH 实例的公司 / 个人工作身份混为同一 Worker。
- 中心保留 Ticket、Grant、Lease、调度和恢复权威；插件可保留本地 Effect Ledger、会话日志和必要缓存，但不成为独立跨机任务权威。

### 7.4 组件、包和权限边界

```text
Loom Control Package
  └─ Concierge / Policy / Registry / Scheduler

Host Agent Package
  └─ Host enrollment / local execution / Local Broker

DSH Loom Plugin Package（DSH Host 首选）
  └─ Local Node / DSH Session / Registration / Local Grant / ArtifactRef

Harness Adapter Package（其他 Harness，按能力选择一个或多个）
  └─ API / MCP / CLI / Runtime Plugin Connector

Runtime Connector Package
  └─ LLM / ComfyUI / 专用 Worker，与 Harness Adapter 分离
```

协议应尽量采用带版本的消息 Envelope，而非共享数据库或进程内对象。Host Agent、插件和 API Connector 是独立部署单元；一台机器上的 Harness 1 插件不应被错误当成 Harness 2 的适配器。

## 8. 组网内选择性分发与安装

### 8.1 支持“装一次，选择一组机器部署”

用户可以在一台管理设备上构建、导入或下载经过批准的安装包，然后向组网内的部分 Host 创建 Rollout。中心负责计划和审计，已有节点或受权 Bootstrap Installer 在目标机执行安装与激活：

```text
Discover Hosts → Select Targets → Approve Package and Version
  → Stage / Transfer → Local Compatibility Check → User / Policy Approval
  → Install → Activate → Health Check → Report
                                       └→ Rollback / Needs Person
```

这不是无差别广播安装，也不是将某个 Harness 的当前安装目录整体同步到其他机器。相同版本可以复用下载内容，但每台 Host 都独立校验、安装、激活和报告。

**引导与后续分发分开**：新机器可以通过手动安装，或经用户明确授权的 Ansible / SSH / MDM Bootstrap Installer 纳入 Loom。裸 Linux / Windows / macOS 安装 Rust Host Agent；已有 DSH 的机器安装或配置 DSH Loom Plugin，不重复安装独立 Agent。节点注册成功后，后续更新可以走自身 Node 通道或同一受控 Bootstrap 通道。

**免密 SSH 可以消除交互登录，不会消除安装授权。** Bootstrap 有独立目标清单、身份、有限操作和审计；复用运维已有的 SSH Key / Agent / 管理证书是允许的，但不得把普通聊天 Grant 当作开机或 sudo 权限。不能把一键安装包包装成任意远程命令执行。

### 8.2 包与安装计划

Package Manifest 至少声明：

```text
package_id / immutable_version / artifact_digest / source / signature
component_kind: host_agent | harness_adapter | runtime_connector | skill | config
host_kind / harness_kind / supported_host_versions
supported_os / arch / required_capabilities
install_requires: service_restart | harness_restart | dependency | none
permissions_requested / declared_effects / default_disabled
```

Rollout Plan 至少包含：目标 Node / Worker、包版本、期望状态、逐项安装 Grant、超时、是否允许重启、健康检查和回滚版本。Bootstrap Plan 另外声明连接方式、目标凭据引用、是否允许 sudo、配对方式、安装范围和卸载 / 回滚策略。

**当前实现只证明了合成 Inventory 的计划与人工观察**：`loom.install-plan.v1` 使用固定的、已实测 Bare 候选描述符与显式 `fixture-*` 目标，服务生成的 `plan_digest` 与每个目标的 `current_operation_id` 约束审批操作。SQLite schema 8 仅追加计划和目标 JSON/时间戳；每个 fixture 观察带有当前 `operation_id` 与人工 `manual_synthetic_inventory_report` 标记，回滚保留父 apply/自身 op 的关系。这不是主机报告、Grant、配对或 Artifact，也不是已安装、可启动的主机身份。背景枚举和回环使用静态清单，`LOOM_INSTALL_SIMULATION=synthetic_inventory` 是仅供测试的 explicit process opt-in，未启用默认501，client不可自行宣称拥有一个有效 fixture service。未知状态保持未知，不可换结果盲目 rollout/rollback，也不由 UI直接反写为健康。合成的健康失败记录不会自动抹除原证据或生成第二张工单。真正的宿主安装、真实效果entry和可追溯session必须另作明确对接，不能靠视口/模拟观察升格。

真实 `node tests/install/plan.mjs` 的HTTP、回滚/未知与controller重启，以及`node tests/install/browser.mjs`的实际创建确认和审批、失败与父关联回滚、Unknown和窄屏已形成一处基础证据。此前UI只检查所有历史 observation便阻止下一次合法回滚的错误，已限定为当前operation ID校验。合成观察可以见证历史 apply 和新的 rollback 两类独立操作，但不会互相篡改或者授予真实执行权。范围、迁移和证据见 [tests/install/README.md](tests/install/README.md)。

运维可以自带 SSH Config 或 Ansible Inventory / Playbook 选择目标，但 Loom 不能静默扫描并接管整个网段。Ansible 或其他安装器应作为外部工具 Adapter 生成审计结果，不依赖模型临时拼出的脚本。

中心先把可信包放入可寻址 Store；Host 在线时拉取或经 LAN 点对点获取。包体不经聊天 Router，不重复传大文件。不同 OS / arch 选择对应产物，不兼容的设备明确跳过。

### 8.3 权限与安全规则

- **Built ≠ Installed ≠ Activated ≠ Registered ≠ Granted**：构建、下载、安装、启用、注册和任务权限是独立动作。
- 管理端有某个凭据，不代表该凭据可以进入所有目标 Host 或交付给模型。Secret、API Key、SSH Key 和 Harness Profile 默认留在执行安装的运维环境或目标本机，由 Broker 绑定或单独录入。免密 SSH 仅让安装器证明既有运维授权，不授予 Loom 任意的后续访问权限。
- 不因安装了 Host Agent 或 Adapter 就获得项目目录、模型、外发和 Worker 执行权限。
- 代码包与 Harness 插件可分发；本地模型、私有 LoRA、Memory 和完整会话不默认分发，仍受 `local-only / no-copy` 与 Policy 限制。
- 跨用户、跨公司 / 个人 Worker、跨不信任网络不得默认接收同一 Rollout。
- 严格执行的包激活规则以版本化 Policy 判断；不能让安装包内的说明或模型自行声明可信。
- 安装 / 激活 / 重启各自是可对账 Effect 或受控本机操作。超时后进入 Unknown，不假装成功也不无条件重装。
- 首版支持签名包、版本锁定、逐 Node 批准、健康检查和保留上一个可用版本；仅运行固定、已审计、有版本的安装 Playbook / Installer，不执行模型临时生成或任意网络 Shell 安装脚本。
- Bootstrap 完成只说明已安装；节点仍须配对并主动注册。远程安装结果不等于 Node 在线、不等于 Harness 可用、不等于已获任务 Grant。
- 远程 sudo、修改防火墙 / 系统服务、卸载和重启均单独确认；优先用户级安装，减少系统级权限。
- 撤销分发与撤销 Grant 不同：可以禁止新安装、停用 Adapter、卸载程序，但不能假定网络包已从所有介质擦除。停用不得清除仍有用的审计证据。

### 8.4 首版范围

先支持可信单用户 LAN 中已有节点的选择性更新，以及通过明确授权的 Ansible / SSH 对目标机器引导 Rust Host Agent 或 DSH Loom Plugin。节点随后主动注册并领取最小权限。跨 Harness 插件因宿主版本差异单独打包。持续自动更新、任意第三方插件、跨不受信网络的普通聊天触发安装暂不进入首版承诺。

### 8.5 平台包矩阵与客户端更新

**当前实现证据的边界**：现已有 DSH bundle 预检和临时 profile 的真实选择、安装/替换与撤销保持测试，以及 **本机 macOS arm64** 的 Bare binary 构建、复制 SHA、执行、默认不注册及拒绝路径 smoke；具体入口见 [docs/BARE_PACKAGE.md](docs/BARE_PACKAGE.md) 和 [tests/harness/BUNDLE_LIFECYCLE.md](tests/harness/BUNDLE_LIFECYCLE.md)。这些候选/manifest 都不是签名证明、跨平台安装/升级服务、实际第二物理节点或生产 Profile 的授权。未通过目标 OS/arch 上的对应命令和健康检查，不得将下文例子与支持列表等同。

Package Manifest 按构建 Target 区分 Rust Host 二进制、Harness 插件、语言特定 Connector 和客户端资源，例如 `darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`windows-x64`。这些是部署例子，实际支持列表必须由对应平台的安装和健康检查产生。

- Rust Host Agent 以签名、按 OS / arch 构建的包分发，不把 macOS 二进制或本机编译目录复制到 Windows / Linux。
- 管理机可以储存多个目标平台的包，但不能假设 macOS 本机具备所有平台的可信构建与签名条件；官方 CI 或单独授权的 Build Host 负责交叉构建和签名。
- Host Agent 自更新由本机更新器执行，保留旧版本、数据迁移版本和失败回滚；控制面迁移与 Host 更新不得在一个不可恢复步骤中捆绑。
- Windows 服务、macOS LaunchAgent、Linux systemd 用户服务、目录 ACL 和系统凭据库通过独立平台适配层实现，不使用“一条 Shell 在所有机器有效”的假抽象。
- Vue 前端资源可由已认证的控制面提供版本化 Web / PWA 更新；桌面 / 移动壳与系统权限的更新仍走对应签名包，不通过 Rollout 静默修改。
- iOS / Android 客户端首版主要访问已有 Concierge，不接收通用 Harness 和任意 Worker 包。Apple / Google 的签名、发布、推送和后台模式限制不能由本地安装机制绕过。
- 无 Rust Host 的移动端不能冒充满足任务 Placement；在移动浏览器里保留操作记录与审批能力，不代表用户离开页面后仍能继续后台执行。

## 9. 授权、调度与可靠性

### 9.1 Grant 与 Lease 分离

- **Grant**：用户允许哪项任务使用哪些资源、目录、模型、操作及数据。
- **Lease**：协调器允许某 Host 在某时段执行某 Assignment。

二者分别版本化：用户禁止外发是 Policy，GPU 从忙碌变空闲是 Resource State。资源变化不能扩大 Grant；Policy 撤销后新执行必须停止，旧 Lease 失效，旧 Agent 的后续写入需被 fencing。

### 9.2 Assignment 的建议字段

```text
assignment_id / ticket_id / grant_digest
host_selector / selected_host_id / worker_id
project_ref / revision / workspace_hint
required_resources / resource_snapshot
lease_epoch / heartbeat / expires_at
budget / deadline
attempt / cancellation_state
report / reconciliation_state
```

一次换机是新 Assignment 或明确 Attempt，不延续原机器的本地会话假设。

### 9.3 Effect 与 Unknown Outcome

跨机采用 **at-least-once + 对账**，不承诺无法证明的 exactly-once：

```text
queued → leased → confirmed
              └→ unknown → reconciling → confirmed | needs_person
```

每个不可合并副作用有不可变 `effect_id`、输入哈希、执行 Host 和证据。断线或崩溃后，先查 Host Ledger 或权威远端：

- Git：核对 ref / commit；
- 外部平台：利用幂等键或记录标记；
- 本地文件：临时文件 + 原子替换 + 哈希日志；
- 模型生成：记录任务 ID、输入摘要、产物哈希和生成状态。

无法证明是否成功的敏感效果，询问用户而非盲目重跑。模型“先检查一下再决定”可辅助恢复，但不能代替确定性证据。

### 9.4 调度失败与离线

- 无符合 Host：排队、等待指定设备上线，或向用户提供替代方案；
- Host 离线：Task 保留，不能伪装为执行失败或成功；
- Worker 失联：Assignment 失联，与 Ticket 状态分别处理；
- 重试：先处理 Unknown Outcome，防止重复副作用；
- 通知可以广播预热，真正的副作用必须获得中心 Lease；
- 多机暂不采用无中心争抢任务，避免双写和权限不明确。

### 9.5 Host 与外部 Watchdog

- Host Watchdog：检查进程、资源、Lease、任务、磁盘与对账；
- Independent Watchdog：在另一设备或独立 Profile 检查协调器；
- 仅重启可解决的运行故障；配置错误、无权限和持续偏离目标须报告；
- 手动停止是尊重的持久意图，不应被自动恢复覆盖；
- 检查进展而非仅检查进程是否活着。

## 10. 用户交互与 Worker 放置

保持单联系人的体验，但用以下视图提供可控性：

- **Chat**：需求、确认、关键决策和最终结果；过程消息默认不占满主时间线；
- **Activity**：任务在哪个 Host / Worker、当前阶段和阻塞；
- **Collaboration**：可展开、可过滤的 Agent / Worker 交流、委派和共享简报；
- **Fleet**：设备、Worker、模型、能力和在线状态；
- **Project / Artifact**：项目来源、版本、产物及生成谱系；
- **Memory / Access**：工作记忆摘要、Memory / Skill 建议、权限、撤回和审计。

用户不必每次选机器，但首次创建以下边界时应提供选择：

- 新 Agent / Worker；
- 新项目或敏感资料目录；
- 本地专有模型；
- 多机都满足且长期成本、权限或体验有明显差别；
- 长期无人值守或高成本任务。

例：

> 某个长期项目 Worker 要放在哪台机器？是复用已有项目环境，还是更适合模型推理的另一台设备？

保存用户的默认规则，后续常规任务自动执行，冲突或成本变化时再询问。会话展开/折叠也属于可保存的默认规则，但单任务覆盖不改变长期偏好。
