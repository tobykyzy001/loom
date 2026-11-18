# AGENTS.md

本文件给后续修改 Loom 仓库的 Agent。它是开发约束的简短索引，**不是架构事实的替代来源**。

## 1. 当前状态和文档索引

当前仓库已有 Rust 协议/Concierge 初版、Vue 工作空间、TypeScript Local Node 和 DSH Host bundle，以及真实本机确定性基准与 Rust↔TypeScript 集成。不要把全部 M0 或 M1–M6 视为完成，也不要只格式化 / 通过编译就声称任务闭环完成。真实 DSH 安装与任务生命周期、移动真机、平台安装器和后续里程碑仍有未验证缺口；当前开发与验证状态见 `docs/IMPLEMENTATION_STATUS.md`、`BASELINE.md` 和 `MEMORY.md`。

### 1.1 每份文件负责什么

| 文件 | 负责回答 | 后续维护方式 |
| --- | --- | --- |
| `AGENTS.md`（本文件） | 给后续开发 Agent 的阅读入口、关键技术选择、不可忽略的安全边界和交付规则 | 简短指针和改动约束；更新仓库状态与实际工具入口。不替代下述事实来源，不复制全部协议 / 测试用例 |
| `vision.md` | Loom 为什么存在、给谁使用、交互与多端体验、哪些不是产品必答 | 修改产品方向、目标用户、体验原则或非目标时更新；里程碑进度不累积在这里 |
| `architecture.md` | 系统组件、Local Node / 中心权威、协议、权限、恢复、记忆、接口与安装模型 | 改变组件职责、跨语言接口、注册、Grant / Lease、存储或部署时同步更新；不描述不存在的已实现 API |
| `roadmap.md` | 当前实际状态、M0 起的实现顺序、每项范围与场景验收、尚未决定的问题 | 每次功能边界或完成状态变化时更新；不把愿景和架构全文搬入，只给出处与可验证证据 |
| `docs/BARE_PACKAGE.md` | **当前架构**Bare Host 二进制打包候选的真实构建、复制/拒绝校验与独立原生流程证据 | 只记录本机实际生成与执行的有限验收入口，不把它扩张成安装器、跨平台或远程部署承诺 |
| `testing.md` | 1 Concierge + 3 Node 的容器拓扑、单元 / 协议 / 宿主 / 回放 / Live LLM 分层、硬断言、Token 预算与 CI 触发 | 增加测试模式、Fixture、模型成本、验收口径或 CI 时更新；只有真实运行过才记录 PASS，未执行不可写成已验证 |
| `tests/runner/README.md` | LocalNode 启动取消/注册凭据恢复、持久 admission、内容稳定回执、HTTP限流、首达预取消、篡改/缺digest负例与真实回放的验证入口和限制 | 只在这些围栏、输入快照和 receipt/耐久恢复契约改变时更新；区分 SyntheticCoordinator、本地文件、真实socket和真实DSH，不替代多机验收 |
| `tests/sources/README.md` | 受限 SourceInstance / Thread / Trigger 入站身份、幂等事件、游标、认证与重启恢复的真实 Rust 验证入口及边界 | 只在来源协议、持久化、入口授权、事件与游标语义或测试覆盖变化时更新；不代替业务触发/审批、真实 IM、跨进程或多宿主验收。当前 Vue `SourceWorkPanel` 是明确run/read摘要消息流：`tests/sources/browser.mjs` 真实Edge验证消息→用户选existing精确Grant/内部file/worker→Artifact，不自动解释或授权 |
| `tests/observations/README.md` | 受限 MemoryObservation 的来源/审阅证据、本地真实HTTP/浏览器入口和边界 | 只在来源/审阅契约、关联存储或验收变化时更新；不代替完整习惯学习架构 |

### 1.2 开始工作的阅读顺序

1. 本文件，了解当前状态和不可绕过的约束。
2. `vision.md`，确认正在实现的产品目的与平台角色。
3. `architecture.md`，确认触及的领域对象和协议 / 权限边界。
4. `roadmap.md`，确定本轮所属里程碑及不提前实现的范围。
5. `testing.md`，在实现前确定最小确定性测试、宿主覆盖和选配 Live 验证。

### 1.3 文档更新边界

设计变化必须同步更新相应文档；不要将新增的长期架构概念只埋在聊天记录或代码注释里。不要用一份文件取代其他文件的全部职责。

- 技术 / 接口决策变化：更新 `architecture.md`，必要时简短同步本文件。
- 用户角色、平台承诺、非目标变化：更新 `vision.md`。
- 当前开发状态、里程碑范围、完成证据：更新 `roadmap.md`。
- 测试拓扑、确定性 / 真实模型分层、Token 和运行频率、证据要求：更新 `testing.md` 与 `roadmap.md` 的相关验收指针。
- 新文档加入仓库：先定义其单一职责，再加入上表和必要的阅读入口。不把同一规范平铺复制到多个 Markdown。
- 实际命令 / Manifest / CI 建立后：把实际验证入口写回本文件与 `testing.md`，删除过时的“当前只有文档”状态，不把模板命令当事实。

## 2. 已冻结的技术选择

- **Rust**：Concierge、任务状态机、Registry、Policy、Lease、持久化应用层、无 DSH 时的 Bare Host Agent。
- **Vue 3 + TypeScript**：共享 Web / PWA 界面，桌面与移动端复用相同任务脉络。
- **Tauri**：桌面壳优先；移动端先 PWA，经实际需要与设备验证后再使用 Tauri Mobile 或薄原生壳。
- **DSH Loom Plugin（TypeScript / JavaScript）**：首个目标的原生 Local Node，主动注册到 Rust Concierge；不提供仅名称接入的假 Adapter。这是首版实现优先级，不是节点协议只能支持 DSH。
- **其他 Harness / 模型服务**：按宿主的扩展形式实现原生 Local Node 或通过 API / MCP / CLI 接入，例如后续可能的 Kimi Code Loom Plugin；各自保留原技术栈和独立分发包，不将 DSH 专有特性强加给所有宿主。
- 核心与跨语言插件共享**版本化消息协议**，不共享 Rust struct、TypeScript 对象、私有 FFI ABI 或中心数据库。
- 首个开发基线为 macOS 单机闭环；Linux / Windows Host 需要真实验证。iOS / Android 首版是 Client，不是默认可靠的长期 Worker。
- 常用的框架、crate、SQLite 驱动、工具链与最终仓库目录没有在文档中确定；开始编码前先做最小选型，不把这些约束误读成必须使用某一个库。

## 3. 节点与安装模型

```text
Vue Web / PWA / Tauri Client
              │ authenticated versioned Client API
              ▼
Rust Concierge（Ticket / Grant / Lease / Registry / Artifact / Audit）
              ▲ outbound authenticated registration + assignment / lease
              │
       ┌──────┴────────────┐
DSH Loom Plugin        Bare Rust Host Agent
已有 DSH 的 Host        无 DSH 的桌面 / Linux
       └──────┬────────────┘
       API / MCP / CLI / Python Runtime Connector
```

### DSH Plugin 是一等 Local Node

当前可安装包位于 `plugins/dsh-loom`；临时专用 `loom-local-fixture` Profile 已实际安装、启用并执行过真实 DSH Agent/受控 Tool/Artifact 流程。它没有修改或读取当前 `desktop` Profile，也没有使用系统 Credential Store、真实模型或用户凭据。完整 Cancel/Resume 验收必须以 `tests/harness` 的最新实际报告为准，不从旧探针或局部 PASS 推断完成。

- 实现主动出站的注册、配对、心跳、Assignment / Lease、SessionRef、必要事件流、本机 Grant、ArtifactRef 和 Effect 对账。
- DSH 机器不因 Loom 再强制安装独立 Rust Agent。DSH 进程中的插件负责复用既有 Agent / Session。
- 节点附带的本地模型 HTTP 服务可由该节点声明和管理；不要求为模型服务复制一份独立 Agent。
- 多 DSH Profile / Agent 可有独立 Worker 作用域，但不把同机或同 DSH 实例等同于相同身份 / 授权。
- 中心不绕过 Local Node 的权限边界直接操纵远程 Harness 内部资源；节点按中心授权执行，不以平台自动发现替代 Policy。

### 注册不等于授权

节点注册使用出站长连接、节点密钥 / 设备身份、中心签名挑战和一次性配对码、预注册证书或管理员批准。**首次配对需要明确信任**；节点能够连接中心或自报能力，不自动获得 Membership、目录、模型或执行权。

中心是 Ticket、Grant、Lease、调度和恢复权威；插件保留本地 Effect Ledger / Session 事实和必要缓存，不建立第二个跨机任务权威。断线、Token 撤销、中心重启和协议不兼容时，不伪造成成功、不盲目清空状态、不重复副作用。

### Ansible / SSH 免密可以做 Bootstrap

- 可以复用运维已有免密 SSH、SSH Agent、Ansible Inventory / 固定 Playbook 或 MDM，在明确目标上安装 Bare Agent 或 DSH Plugin。
- 免密只是已有运维授权的一部分，不是从聊天得到的任意 Shell 授权。执行安装的是固定、受审计、有版本的 Installer，不是模型临时拼出的脚本。
- 使用目标清单和凭据引用；优先用户级安装。sudo、系统服务、防火墙、重启和卸载单独授权并审计。
- 安装后仍需节点主动注册、配对与领取 Assignment。**Built ≠ Installed ≠ Activated ≠ Registered ≠ Granted**。
- 同一安装包可选择性分发到部分节点，不复制完整安装目录或 Profile；Secret、私有模型、Memory、完整会话不因安装包扩散。
- 没有任何已配置凭据的机器，提示手动安装或单独建立运维授权，不暗中扫描或猜测登录。

## 4. 不可轻易改变的产品与安全边界

除用户明确要求重新设计外，保留：

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

- Grant 与 Lease 分开版本化；撤销 Grant 后不能仍接受旧 Node 的新执行。跨机副作用采用 **at-least-once + 对账**，不承诺无证据的 exactly-once。
- 模型参与意图判断，代码执行 Policy；Resource Scheduler 基于可认证的库存与确定性约束，不能由另一个 LLM 凭自述拍板。
- 不将 Git / SSH 凭据、API Key、私有模型权重写入 Prompt、普通事件记录或全局配置。凭据使用宿主受支持的 Credential Store / 本机 Broker。
- 大 Artifact 尽量 Host 直达，内容寻址并保留位置、版本、Hash 和生成谱系；不把本机绝对路径当全局 Artifact URI。
- 默认主对话简洁；Agent / Worker 过程可折叠并按 Ticket 展开。只有结构化 Report 表示状态，原始 Transcript 不替代任务状态。
- 展开、搜索、复制、导出消息也检查权限。Adapter 不能提供完整 Transcript 时明确缺口，不伪造对话。
- 用户明确说“记住”可保存相应 Memory；自动观察只能产生 MemoryCandidate / SkillCandidate，支持来源预览、编辑、拒绝、撤回和作用域限制。
- Skill 必须经过保存后的回放验证才标为已验证；保存 Skill 不产生持续执行或扩大授权的 Grant。
- 不包揽游戏资产生产、指定固定 GPU、固定三机或本地图像生成作为必要平台条件。准确回答“不支持”“未知”同样是功能。
- 手机退出不停止桌面任务。手机锁屏、杀进程、网络切换、过期认证和推送通道不可用必须显式处理，不能靠保活轮询虚构可靠性。

## 5. DSH Plugin 开发约束

DSH 插件是已打包的 Host-only bundle；临时隔离 Profile 已验证过真实安装、注册、Agent/Tool/Artifact，当前隔离 fixture 也覆盖真实取消、停止核销和 Session 恢复；完整平台、多宿主与生产环境的持续验收仍未完成。修改实现或安装时：

1. 先加载并使用环境中的 `dsh-doc` Skill，阅读当时实际 DSH 版本的 Plugin API、配置和会话机制；不要仅凭本项目文档臆测 DSH 私有服务名或接口。
2. 选择最小可行的 Node 协议增量，优先复用现有 DSH 能力与事件。需要 UI 时使用实际 DSH Client Slot 体系，不使用不受控 iframe 或外部 DOM。
3. 不追加不能被 DSH 恢复的私有 Session Event；插件缓存 / 投影不是唯一事实。原始 Session 与中心 Node Envelope 的版本关联必须可恢复。
4. 配置使用宿主支持的 Config Editor / `cordis.patch.yml` 的正式安装路径；不要手工改用户正在使用的 Profile Patch、猜测包路径或遍历目录找配置。
5. Secret 使用宿主 Credential Store；节点公钥可注册，私钥只在本机受控存储。不要把开发 Token 提交到仓库。
6. 插件内部状态、事件与外部副作用分别处理；安装 / 启用插件不等于已经安全执行任务。注册、配置变更、重启、断线重连和 Profile 作用域都要有测试。
7. DSH 插件用其要求的方式安装与验证，不能声称 Rust / Vue 的测试覆盖了插件宿主行为。
8. 不为了形式统一用 Rust 重写 DSH 内部插件；跨语言边界使用协议。
9. 受限真实父/子委派当前有 `tests/harness/real-delegation.mjs` 证据，读 `tests/harness/DELEGATION.md`。源proof由当前Assignment/Lease受限读取，不把管理token给Worker。默认`delegation_tools=unsupported`，不得扩展到未验证代理/Harness或任意路径；潜在文件效果但source/session或字节证据未完整时必须保持unknown。

## 6. Rust / Vue 实现原则

当前存储 schema 为 v13：schema11的 `candidate_memory_links` 继续用于精确定位 MemoryCandidate 与派生 Memory；schema12提供受限 `source_instances/source_threads/source_events/source_event_cursors` 与 nullable `messages.source_event_id`；schema13再用独立 `task_ticket_id/creation_kind/task_digest/task_spec_json/source_work_specs` 将事件接收历史与**明确用户选择的** read_summary 工作分开。此Source工作仍需真实Grant/Binding/root/Node/Worker与真实worker输出，原ticket reference和冻结Spec都不是持久授权，证据与边界见 [tests/sources/README.md](tests/sources/README.md)。当前受限候选来源/审阅的验证入口见 [tests/observations/README.md](tests/observations/README.md)。`loom.install-plan.v1` 的协议版本和 Skill 回放版本仍是独立的 1。`install_plans/install_targets` 仅保存受控合成 Inventory 的审批与 **合成观察**（`observations` 手动 fixture 分类、operation_id 与父回滚关联），不能成为真正 Host 安装、授权、Pairing、系统服务或节点健康证明。未授权的 `observe` 默认 501，Unknown 禁止因换结果重试/滚动；恢复约束与验收见 `tests/install/README.md`。增加表须按已有 v7→v8 增量升级并保留旧数据，不得倒置迁移顺序或用自报状态生成 Ticket/Grant。`cancel_requested` 和最终 cancel acknowledging/unknown effect 是不同事实。受限文档 `document_pipeline_runs/stages`、`direct_offers`、`model_observations`、`skill_replays/skills` 保存阶段/原Grant/Ticket投影、直接交接nonce、已登记Artifact或逐项实证的模型与技能观察，不是替代权限、目录、产物、完整模型注册/激活或永久执行技能授权。Skill验证只支持约束内普通`read_summary`重放并由实际Worker输出验收，原始候选或`replay_verified`客户端布尔值不构成验证。`verified_at`是第一次通过证明的时间而不是任意GET观测时间。真实增量迁移前，都要保留已有Grant/Ticket/Artifact/审计记录。不得用导出的session_ref或url代替有效Assignment及Grant来源。新增对象仍要有明确的 Assignment/Lease/Grant 关联，不能把 nil/空 Project/Worker ID 当作有效资源权限。`model_inventory.rs`只把严格v1模型目录/当前心跳投影为已认证Worker的适配器观察：目前仅精确`loom-stub/loom-stub-v1`文本模式加实际PrepareCall；它不是Model Registry、下载/安装/激活或运行Grant。`Store::row_value`的inventory当前已是JSON Object，不能再次按字符串解析而错拒有效v1。`source:'host_reported'`与`read_source:'authenticated_node_heartbeat'`分开；缺失/非法/过期/worker不匹配分别保留，不借source标签伪造Controller直接探测。新鲜观察只读取已有事实，不因GET刷新检查时间；`generation_observed`必须false；`/models`的全量Provider生命周期/下载/激活仍未交付；另有真实 byte-backed `loom.model-descriptor.v1`注册与`place_model`授权/retire（请读[tests/models/README.md](tests/models/README.md)，既JSON proof与source_digest要分别验证）。不要借`/model-inventory`的目录观察或`Grant=[place_model]`推断有真加载/新推理权。新的`loom.model-binding.v1`仅在当前**固定fixture**且存在真实source/placement/独立invoke_text和fresh exact Worker适配器观察时绑定调用，两端严核scope与source作业；源 Assignmentdigest 是读取作业的逻辑摘要，不是原文件SHA或新调用Assignmentid/生成证明。读[tests/harness/MODEL_BINDING.md](tests/harness/MODEL_BINDING.md)及其实际driver，不能以此宣称通用provider/m3或任何模型已完成下载激活。需要真SDK观测和真实Edge目录审阅，见[tests/model-inventory/README.md](tests/model-inventory/README.md)。

- Rust 将协议、领域逻辑、服务端和平台适配边界分层，避免 Center 与 Bare Agent 产生各自不同的 Ticket / Grant 定义。
- Node Envelope 至少带协议版本、Node / Installation 身份、请求 / 幂等 ID、Ticket / Assignment / Lease 关联、时间与能力信息；具体字段以原型验证后固定。
- 持久化先采用适合单用户的小型事务化存储，中心保持单写者。迁移、恢复、回滚和旧版本读取纳入基本测试。
- 外部 Connector 必须显式声明支持操作与平台依赖；不支持的取消、事件或 Transcript 能力显示为缺口。
- 平台文件路径、进程 / 服务、凭据库、目录 ACL 分离到桌面适配，不假设 `POSIX == Windows`，也不假设可以一条 Shell 跨平台。
- Vue 消费版本化 API 而不是直接读取中心数据库。共享领域组件与平台外壳适配分开，适配键盘、触摸、断线、认证过期和窄屏。
- Web / PWA、Tauri 或薄原生壳的更新不得成为未签名或未授权的静默副作用。

## 7. 修改和验证协议

### 每次改动

1. 先读本文与相应设计，再读已有文件；不要仅凭过时的讨论覆盖当前设计决策。
2. 小范围完成当前里程碑的端到端能力，不提前建完所有平台、Harness、Pipeline 与 Registry。
3. 新功能写清能力缺口、失败状态和授权边界。错误结果不能被 UI 的统一“成功消息”覆盖。
4. 新架构决定、安装模型、平台承诺或里程碑变化要同步 `architecture.md` / `vision.md` / `roadmap.md`；不要让代码成为唯一真相。
5. 不修改用户既有凭据、SSH 配置、DSH Profile、其他机器或全局插件作为测试副作用。未经用户明确许可，不进行局域网扫描、远程部署或远程 sudo。
6. 产生安装器或远程操作时，使用测试 Inventory / 固定虚构参数作为默认；先验证静态计划、权限与回滚路径，再请求真实目标。

### 验证

完整测试策略、1 Concierge + 3 Node 的 Docker 拓扑、硬断言、回放与 Token 预算见 `testing.md`。本轮按用户要求优先单节点基准，不实现特定 1+3 Compose fixture。尚未建立 CI 或 Live LLM 结果。实际命令：

工具链建立后，应先读 Manifest / CI 并运行对应的最小检查和端到端测试，**不要把下面示例当已生效命令**：

```text
Rust：format / lint / unit / protocol / persistence / restart / lease fencing
Vue：typecheck / lint / unit / responsive / disconnected client
DSH：compatible installation / registration / cancellation / session reopen
跨机：offline / reconnect / duplicate report / unknown effect / rollback
安装：fixture inventory / authorized bootstrap / partial failure / privilege boundary
```

构建平台目标与实际可用平台能力不同。宣称“支持某平台 / Harness”前，至少验证安装、注册、真实任务、取消、失败恢复和权限负例；移动还必须验证锁屏、杀进程和断网恢复。

安全测试至少包括：伪造节点、Token 撤销、旧 Lease、越权目录、Secret 泄漏、跨 Profile / Worker 隔离和错误消息重放。测试不能以用户真实私有项目或生产机器作为默认可写靶标。

- 默认用确定性 Worker / Replay 覆盖权限、路由约束、幂等、恢复与故障；未经用户或测试配置明确启用，不调用真实计费模型。
- `Live LLM` 保留真实自然语言 E2E，但不是所有 PR 的前提；Token 上限、Provider / 模型版本和成本均记录。缺少凭据或预算记为 `NOT RUN`，不能标为真实模型 PASS。
- 硬断言以 Ticket / Grant / Assignment / Lease / Effect / Artifact 和真实外部效果为主；不能仅依据最终上下文“看起来合理”或 LLM Judge 给出通过。
- 修改协议、路由、权限或宿主适配时至少增加一个对应负例。不能通过删除旧场景、替换更有利 Prompt、降低 Rubric 或用 Replay 冒充 Live 让测试变绿。

### 分发与本机可执行产物

`node tests/harness/bundle-preflight.mjs` 只在源/临时副本中检查当前 DSH bundle，不代替真实安装。`node tests/harness/real-bundle-lifecycle.mjs` 只在唯一隔离 Profile 中运行公开 CLI 的安装/替换/禁 worker 和撤权保持测试，不调用当前 desktop 的 Plugin Manager。当前 Bare 分发 smoke 是 `node scripts/bare-package-smoke.mjs`，原生正向流程仍为 `node scripts/bare-integration.mjs`；具体实证和平台限制见 [docs/BARE_PACKAGE.md](docs/BARE_PACKAGE.md)。这些都是 local/test-only 命令，不是默认安装、SSH 操作、Prod Credential Store 或 daemon 激活授权。不要提交运行时生成的包、身份私钥、project input 或真实 Profile 数据，继续维护内容与来源负例，避免仅更新版本号就当成代码更新/权限刷新。

### 交付说明

- 清楚区分：已实现、已本地测试、已在目标平台验证、仅设计、未验证。
- 给出改动位置和验证命令；缺目标设备 / 凭据 / DSH 宿主时，明说缺口。
- 文档改动检查相对链接、段落编号、残留旧术语和空白错误。
- 用户要求提交时，先检查 `git status` 和将提交的差异，只 stage 本任务文件；提交后说明 commit，并在尚未推送时明说。
- 不要为了运行泛称的 `cargo test` / `pnpm test` 先引入无关脚手架；根据本轮实际实现创建与验证最小工程。

## 8. 当前开发入口

下一步以 `roadmap.md` 中 **M0 — 单机任务闭环与会话可控** 为准。首个增量建议：

> Rust Concierge 最小 Ticket API → DSH Loom Plugin 主动注册与一次性配对 → 一个授权目录任务 → Session / Report / ArtifactRef → 重启恢复 → Vue 显示，默认折叠过程。

M0 内亦验证手机浏览器只读 / 一次非敏感审批与断线恢复。移动端长期 Worker、多 Harness、自动习惯归纳、通用 Pipeline 和开放生态都不能提前偷渡进这个切片。

不要将游戏资产 Pipeline 当成默认开发前提；应用验收场景应覆盖编程、资料处理、缺少能力、设备离线、权限撤销和移动查看。
