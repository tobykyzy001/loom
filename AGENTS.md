# AGENTS.md

本文件给后续修改 Loom 仓库的 Agent。它是开发约束的简短索引，**不是架构事实的替代来源**。

## 1. 当前状态和阅读顺序

当前仓库只有设计文档；没有 Rust workspace、Vue 工程、DSH 插件、安装器、可执行构建或测试命令。不要把预期结构写成已经完成的功能，也不要只格式化 / 通过编译就声称任务闭环完成。

开始实现前按顺序阅读：

1. `vision.md`：产品目的、用户体验、多端与部署目标、非目标。
2. `architecture.md`：领域边界、中心 / 节点协议、安全规则、平台与部署约束。
3. `roadmap.md`：当前所在里程碑、范围、验收场景和未决问题。

设计变化必须同步更新相应文档；不要将新增的长期架构概念只埋在聊天记录或代码注释里。`roadmap.md` 只写当前实际状态、下一步与验证证据，不把愿景、设计原则和未知实现统统累计进去。

## 2. 已冻结的技术选择

- **Rust**：Concierge、任务状态机、Registry、Policy、Lease、持久化应用层、无 DSH 时的 Bare Host Agent。
- **Vue 3 + TypeScript**：共享 Web / PWA 界面，桌面与移动端复用相同任务脉络。
- **Tauri**：桌面壳优先；移动端先 PWA，经实际需要与设备验证后再使用 Tauri Mobile 或薄原生壳。
- **DSH Loom Plugin（TypeScript / JavaScript）**：DSH 所在主机首选的完整 Local Node，主动注册到 Rust Concierge；不提供仅名称接入的假 Adapter。
- **其他 Harness / 模型服务**：保留原技术栈，通过版本化 API、MCP、CLI 或必要 Runtime Plugin 接入。
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

DSH 插件是预期的实现组成部分，但当前仓库尚未存在插件代码。实现时：

1. 先加载并使用环境中的 `dsh-doc` Skill，阅读当时实际 DSH 版本的 Plugin API、配置和会话机制；不要仅凭本项目文档臆测 DSH 私有服务名或接口。
2. 选择最小可行的 Node 协议增量，优先复用现有 DSH 能力与事件。需要 UI 时使用实际 DSH Client Slot 体系，不使用不受控 iframe 或外部 DOM。
3. 不追加不能被 DSH 恢复的私有 Session Event；插件缓存 / 投影不是唯一事实。原始 Session 与中心 Node Envelope 的版本关联必须可恢复。
4. 配置使用宿主支持的 Config Editor / `cordis.patch.yml` 的正式安装路径；不要手工改用户正在使用的 Profile Patch、猜测包路径或遍历目录找配置。
5. Secret 使用宿主 Credential Store；节点公钥可注册，私钥只在本机受控存储。不要把开发 Token 提交到仓库。
6. 插件内部状态、事件与外部副作用分别处理；安装 / 启用插件不等于已经安全执行任务。注册、配置变更、重启、断线重连和 Profile 作用域都要有测试。
7. DSH 插件用其要求的方式安装与验证，不能声称 Rust / Vue 的测试覆盖了插件宿主行为。
8. 不为了形式统一用 Rust 重写 DSH 内部插件；跨语言边界使用协议。

## 6. Rust / Vue 实现原则

这些是实现策略，不是虚构的现有目录：

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

当前只有文档，没有测试命令。工具链建立后，应先读 Manifest / CI 并运行对应的最小检查和端到端测试，**不要把下面示例当已生效命令**：

```text
Rust：format / lint / unit / protocol / persistence / restart / lease fencing
Vue：typecheck / lint / unit / responsive / disconnected client
DSH：compatible installation / registration / cancellation / session reopen
跨机：offline / reconnect / duplicate report / unknown effect / rollback
安装：fixture inventory / authorized bootstrap / partial failure / privilege boundary
```

构建平台目标与实际可用平台能力不同。宣称“支持某平台 / Harness”前，至少验证安装、注册、真实任务、取消、失败恢复和权限负例；移动还必须验证锁屏、杀进程和断网恢复。

安全测试至少包括：伪造节点、Token 撤销、旧 Lease、越权目录、Secret 泄漏、跨 Profile / Worker 隔离和错误消息重放。测试不能以用户真实私有项目或生产机器作为默认可写靶标。

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
