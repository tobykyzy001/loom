# Loom Testing Strategy

- 状态：已有确定性协议、单元、真实单 Node HTTP 和恢复测试；无 CI、Live LLM 或真实移动设备验证
- 测试主场景：当前先完成 **1 个 loom-concierge + 1 个真实 Local Node + 实际文件任务**，用户明确要求首版不实现下面的 1+3 Compose 拓扑
- 质量口径：先验证任务状态与外部事实，再评估自然语言交付；真实模型成本单独管理

本文定义怎么验证 Loom，而不是为完成 Roadmap 的某一页制造一个成功 Demo。实际验收场景与完成标准在 [roadmap.md](roadmap.md)，安全与协议边界在 [architecture.md](architecture.md)，贡献流程在 [AGENTS.md](AGENTS.md)。

## 1. 测试原则

1. **区分协议可靠性、宿主适配质量和模型行为。** 故障的权限判断不能用 LLM 的恰当道歉来替代，模型生成表现也不能由纯 Mock 证明。
2. **硬断言优先于聊天全文。** 检查 Ticket、Grant、Assignment、Lease、Effect、Artifact、真实文件和宿主 Session；最终聊天只是其中一项输出。
3. **每个 PASS 有外部证据。** 不因进程活着、HTTP 200、容器启动或 LLM 说“完成”就通过。
4. **测试不包含用户私有资料。** 默认使用合成 fixture、短期测试身份、隔离卷和专用测试 Provider；测试凭据不纳入 Prompt、Transcript 与构建产物。
5. **模型成本自动采集并设上限。** 非 Live LLM 模式不向任何 Provider 发出请求；无凭据或被禁用时不是降级为假 Live PASS。
6. **测试并不自动授予它验证的权限。** 容器隔离是测试手段，不是产品权限沙箱；仍需验证 Host / Node 的 Grant 代码路径。

## 2. 支撑角色与命名

| 名称 | 含义 |
| --- | --- |
| `loom-concierge` | 唯一任务权威，维护 Ticket / Grant / Assignment / Lease / Registry / Artifact 索引 |
| `loom-node-a` | 一个经独立身份注册的 Local Node，拥有项目 fixture 与 Worker |
| `loom-node-b` | 另一个 Local Node，拥有资料或文档任务能力；与 A 权限隔离 |
| `loom-node-c` | 第三个 Local Node，用于受限资源、失败注入或第二种宿主验证 |
| `loom-worker-*` | Node 内实际执行工作的 Worker / Session 容器；不是中心 Assignment 或 Host 的同义词 |

Compose 的一个服务既可以代表通过 Rust Bare Host Agent 暴露的 Node，也可以代表带 Loom Plugin 的 DSH / Kimi Code 宿主。应使用一致的 `node_id / worker_id / harness_kind`，不能以容器名推测资源位置或权限。

容器相似不等于执行环境相同：不同节点至少拥有不同 Node 密钥 / Identity、配置、Scope、数据卷和测试能力。真实宿主测试必须使用独立的宿主 Profile / Session 数据，不能让多个 Node 共享一个默认 DSH Profile。

### 2.1 建议的初始仓库布局

```text
tests/
├─ contract/              # Node Envelope / Schema / 多宿主兼容用例
├─ deterministic/         # Scripted Worker、故障注入、恢复与权限用例
├─ harness/               # DSH / Kimi Code 真实插件宿主测试
├─ live/                  # 需要真实模型、显式启用的场景
├─ fixtures/              # 合成项目、资料、Secret、协议和模型回放
└─ artifacts/             # 本地、gitignore 的临时报告与证据；按保留策略清理

deploy/
└─ compose.testing.yml    # API 稳定后增加；当前仅表示计划位置
```

此布局是建议而非已有文件。需要 macOS 宿主插件、移动设备或真实 OS 特性时，不通过容器伪造测试结果；使用独立 Host runner 或真实设备。

## 2.1 当前实际高层验证入口

- `pnpm --dir packages/node-client test` / `pnpm --dir plugins/dsh-loom test`：真实节点HTTP和持久 outbox边界。缺/空白Node token**不得**被client token代替；匿名仅challenge与初始注册，旧Node token可重注册。预取消请求绝不先`fetch`，迟到响应不得重解释为没有任务；caller shutdown保持原pending/attempt/backoff，不取下一entry、不创建交付回执，后续普通可达的同一request body才能交付。正常离线/timeout仍有独立延迟重试。各自分别导入公共Node与vendored源，外加隔离DSH完整SDK流程，不用Rust拒绝来掩盖前端出局错误。见[transport专项](tests/harness/EVIDENCE.md)。
- [本地节点持久入场与回执专项](tests/runner/README.md)：实际 `NodeState.open` 重开后校验同Assignment工作输入、Grant digest/非回退epoch、合法重复活跃/取消、未知或非法停止、缺失input-digest旧record，checkpoint commit 内的 Artifact/Effect 归一化及持久拒绝ack ledger。`tests/runner/real-receipt-replay.mjs` 还用真 Rust中心、一次真实文件Effect与两次“收到HTTP200后丢响应”的专项故障，直接由中心 API/SQLite receipt 复核原request ID、byte body、hash、Effect lineage和一次外部副作用。它是本机单节点 at-least-once+对账而不是exactly-once或多机证明；本地 SyntheticCoordinator 与真实DSH不相互替代。
- `node tests/runner/http-stream.mjs` 与 `node tests/runner/http-socket-stream.mjs`：主/vendored HTTP 原生 stream 分块限流、真实byte计量、精准上限、header大小谎称、UTF-8跨块、非法chunk、零字节饥饿、在停止或超时中唤醒pending reader，以及keep-alive/stream和legacy fallback。独立loopback server实测partial JSON 不抵达任务状态、结束caller与timeout独立socket并验证每个 listener 和socket确实关闭；证明owned本地读取和唤醒，而非远程任务回滚、永不限内存或隐藏旧bug。见 [runner 专项入口](tests/runner/README.md)。
- `node tests/runner/startup-cancellation.mjs`：两Runner预检/打开身份/state 的真实中点取消、缺enrollment与坏身份、注册等待取消、真正中心签发token已保存后的取消及同Node恢复；还验证Coordinator等待不再继续poll、catalog真正deadline与延迟取消相区别。可选signal仅在显式启动调用上有效，不是整体 Cordis/SDK effect的取消保证、也不是远端撤销。见 [runner 专项入口](tests/runner/README.md)。
- `node tests/harness/real-lifecycle.mjs`：隔离profile中真实安装、注册、Agent工具任务、取消与恢复；具体按脚本最后报告判断。
- `node tests/harness/real-delegation.mjs`：同一隔离 DSH Host 的实际父/子 Session、current Assignment Source 验证、原父产物到新 scoped Tool/File/Artifact 与实际父子关系、错误来源拒绝、重开无重复效果。详见 [harness/DELEGATION.md](tests/harness/DELEGATION.md)。默认生产`unsupported`，此例零网络 Stub，不代表自然语言模型质量、物理第二机或任意 Harness。
- `node tests/direct/loopback-handoff.mjs`：两台同机逻辑 Node之间的真实direct Artifact取源/签名/Grant与nonce不可复用。比较字节hash和父节点谱系，加入取消/stale grant/offline等负例，实测14个断言。见[direct/README.md](tests/direct/README.md)。是同机回环的基础传输证明，不是物理第二机、任意路由、公网/TLS或大文件对账保证。
- `node tests/harness/real-model-text.mjs --browser`：真正的SDK文本调用、原`invoke_text` Grant和受限Artifact观察入库；renovate撤销后再看只读历史。真实Edge中检查模型观察/撤回、同Ticket Artifact hash和二开响应，发现长内容溢出会失败；不是完整模型目录、真实LLM或移动真机认证。配限方见 [harness/MODEL_TEXT.md](tests/harness/MODEL_TEXT.md)。无`--browser`时只核对原执行和API观察。
- `node tests/skills/read-replay.mjs`：真实Worker原Grant/Lease下，将read_summary样本重新执行并逐字比较新/老Artifact SHA；refuse客户端自报replay_verified、错误source/root/Grant、撤销后首答。新Skill和偏好Memory分开，永不成为新的持续权限或通用代码运行器。验证入口为[skills/README.md](tests/skills/README.md)；早期 Skill v7 数据在后续schema8增量迁移中与早期Ticket/Artifact/audit继续保留。
- `node scripts/document-pipeline.mjs`：受限原授权两阶段文件转换、`/run`、幂等和中心恢复；不是 M3 通用长图/大规模 Artifact 转运。
- `node tests/harness/bundle-preflight.mjs`：实际插件manifest/export/path/locale/icon和默认关闭等31项**不安装、不激活**源检查；临时副本导入shape，不调用`apply`，不能代替真实宿主兼容性。缺真正依赖 claim明确NOT RUN。详见 [harness/BUNDLE_PREFLIGHT.md](tests/harness/BUNDLE_PREFLIGHT.md)。
- `node tests/harness/real-bundle-lifecycle.mjs`：唯一临时profile中的真plugin安装、worker禁用、metadata-only remove/add/重启、坏包不覆盖和**精确匹配原worker/Grant**的撤权保持。仅本地`file:`流程，不等于生产桌面安装、GUI registry更新或真实 LLM。见 [harness/BUNDLE_LIFECYCLE.md](tests/harness/BUNDLE_LIFECYCLE.md)。
- `node scripts/bare-package-smoke.mjs`：当前macOS arm64真实 Bare native binary 的12项打包检查，包括offline构建、实际执行、SHA/权限、不注册的help/version、非法root/配对和截断/symlink/hardlink/空binary拒绝。只有当前host，不是通用安装器。原生读写/取消/恢复另实跑 `node scripts/bare-integration.mjs`。见 [BARE_PACKAGE.md](docs/BARE_PACKAGE.md)。
- `node tests/observations/candidates.mjs --browser`：真实注册节点/项目/Grant产生的 **手工选取** Source Ticket，验证最多32个同项目去重来源、重复/混合项目拒绝、过期重置、Memory candidate保存/永不重复/稍后再审阅/精确关联撤回、**接受前人工编辑候选文本**（version、原fingerprint/source、独立accept、含body/scope/terminals拒绝）、普通Memory删除共用事务及重开schema15。Edge实际走candidate草稿取消、修改、两种独立读取失败和接受后再撤回；删除当前编辑的Memory也清除其旧表单身份。含390px编辑器与取消零写回验证。隔离Edge真正确认 save/undo，**直接刷新Memory页**再问候选与390 viewport，table-derived Memory ID不再丢失；没有自动读取Transcript、自动习惯推断或模型生成。它只覆盖受限偏好来源/审阅而非完整 M5。见[observations说明](tests/observations/README.md)。可选无 `--browser` 时仅跑HTTP case。
- `node tests/runner/task-priority.mjs`：单个真实注册LocalNode下的有界整数priority选择(prefer higher)，包括旧80先于新0、默认0仍最新DESC、未ack重复、合法待停止候选先于urgent、真实heartbeat/approval前priority保持、真实missing-file failed后显式retry读取own file并保留原失败与priority，以及另一revoked Grant无法靠高priority复活。证明**本机合法候选领取偏向**及PendingStop不作为普通工作丢弃，不承诺preemption、cross-Node公平性/无饿死或general global scheduler。priority仅Ticket调度元数据，不在Node Assignment/operation/digest。代码与[实证入口](tests/runner/README.md)可复跑，计划属schema15且原Storage/权限fence不变。
- `node tests/install/plan.mjs`：真实HTTP和持久化合成 Inventory 计划；审核 immutable digest，逐目标审批、health_failed/healthy、父 apply 绑定回滚、Unknown只保留原记录。默认服务未启用 fixture 观察时返回501，跨端口重启保持原关系与审计。所有selected目标`fixture-*`，不会真实安装/注册；当前Storage为schema15，不影响既有 Skill replay.version仍为1；安装计划协议保留为loom.install-plan.v1而不是与Storage版本混淆。
- `node tests/install/browser.mjs`：真实Edge中合成 Inventory 的计划创建与确认，批准digest、失败报告、二次独立回滚观察和Unknown无retry，390 viewport溢出检查。当前op的回归 guard修复已验证有先前 apply 历史时仍合法报告新 rollback，而不是清空历史/继续create。仅合成 Inventory，无真实 Host、SSH或凭据；限界见 [install/README.md](tests/install/README.md)。
- `node tests/model-inventory/real-dsh.mjs`：真实隔离 DSH 宿主中执行一次公开 SDK 模型适配 inspection（prepareCall），多次心跳复用冻结 v1 catalog；`request:0`，没有Ticket/Grant或模型 Artifact。`host_reported`不等于控制器直接执行模型；此 stub 文本观察不提供下载、安装、激活或生成。
- `node tests/model-inventory/controller.mjs`：真正签名 Node 注册/HTTP 心跳及严格 v1 解析，验证 source/worker/freshness、无效/缺失最近快照、未知名称/模态均不会形成模型执行权限，真实重开保持一致。`/model-inventory`仅只读投影；通用模型下载、激活和推理lifecycle仍501或不存在。另一类仅受控`model_descriptor`注册有实际file-byte proof与独立place_model授权，也不过泛化为广义Provider+execution支持。
- `node tests/model-inventory/browser.mjs`：真实Edge验证设备页以已知Node心跳读取本机模型资源观察，Node/Worker/text上下文/时间来自实际注册数据，**不是浏览器代跑SDK**。仅进入设备及显式刷新各一次GET；新页面不提供下载/激活控制，390 viewport无溢出，不生成新Grant/Ticket。范围见[model-inventory/README.md](tests/model-inventory/README.md)。
- `node tests/models/produce-descriptor.mjs`：真的授予read并生成本地小文本model-descriptor proof。5个原始字段与byte SHA严格校验；对应Task kind与read Grant，但不是模型执行或私有权重发现。拒绝伪造content、其他path及invoke_text/place_model混用。Rust Bare新kind未声称已执行，实际类型是TypeScript Worker。
- `node tests/models/local-descriptor.mjs`：从真实proof注册 → 独立当前place_model审批 → 幂等的放置认可（metadata only，未运行） → 撤grant/retire阻止新放，再重开保history、源字节和审计。scope/Node/worker/currentGrant绑定必须匹配；普通read/write/invoke_text不能替代place_model。局部治理元数据和SQL v9暂存，不是完整M3/完整Provider lifecycle。见[models/README.md](tests/models/README.md)。
- `node tests/harness/real-model-binding.mjs`：同一隔离DSH Worker真实读取描述 → 真正注册和独立place授权 → 独有invoke_text Ticket → 公共SDK实际Adapter/Session产生Artifact。两个维护者/来源digest、二次`place_model`/`invoke_text`、当前Node/Worker/ProjectBinding/批准、immutable source Assignment input逻辑摘要及最新适配器观察均实际验证；read/place不可顶替invoke，错误scope/Grant/revoked/retire都不产生新SDK调用。这是**受限Source-to-Adapter bridge**，不是通用Provider registry、安装/权重部署/推理质量或物理跨机证明；见[MODEL_BINDING.md](tests/harness/MODEL_BINDING.md)。
- `node tests/harness/real-credential-broker.mjs`：在当前 DSH 已发布 `LocalCredentialProvider` 上由测试专用插件创建单个合成 record，真实 `inspect` → 以匹配原检查 Artifact 授权的 `revoke` → 无种子重启 `missing`。执行前/删除前都校验当前权限与精确 Assignment，同时验证 Scope/digest、Source 字节篡改与撤权拒绝。生产 broker 无 secret 读取/枚举，当前仅单节点本机 metadata/删除证明；未验证真实 Secret、OS 凭据库或远程认证。详见 [harness/CREDENTIAL_REF.md](tests/harness/CREDENTIAL_REF.md)。
- `node tests/projects/git-probe.mjs`：实际 Git creation/commit/dirty/reprobe 测试，并核对带 secret userinfo 的 remote 被 sanitize 而非泄露到 API/DB/Audit。未 Clone/Fetch/联网或配置凭据，非 Git 不得伪装为 committed source。见 [projects/README.md](tests/projects/README.md)。
- `node tests/sources/events.mjs`：覆盖受认证SourceInstance、Thread、Trigger 的可持久HTTP路径。硬断言真实请求/记录与SQL计数，包含并发首建与重复、原文 payload/时间/digest、同ID冲突不覆盖、跨Source同名thread分离、持久合格顺序cursor及其绑定关系；与既有Ticket关联不会新建Grant/Assignment/Agent副作用。友善的schema（typed JSON）、禁止复制keys 及非法role/time、错误path/cursor/limit都有对应负例。真实停止/重开及schema12升13保证既可查原始Messages，旧Message仍不伪造Source。见 [tests/sources/README.md](tests/sources/README.md)，不把记录入口当自动task intent或现实IM接入验收。
- `node tests/sources/authorized-ticket.mjs`：真正 Rust中心+隔离LocalNode，接收an immutable用户消息后在**另行明确有效Grant/Project/file/Node/Worker**提交一笔`read_summary`。中心将来源历史与独立 `loom.source-work-spec.v1`、Task latch 分离，canonical bytes/digest 与 current Grant/Binding/node/worker严格核验，真实Node Artifact/bytes、Report/Effect outbox与重启持久化必须落地。覆盖SQL解绑/原始事件与spec不可变、跨Project、wrong operation、Grant撤权、变更root/operations错误批准稳零Assignment、后段link故障整组回滚、reject0Assignment及重复创建不二次执行。它是单写者的Source→authorized file work proof，不自动解释意图、非实时IM或通用DAG/model/多机exactly-once；未以`execution_started:false`倒推外部永不生效。数据库范围见[Source入口与范围](tests/sources/README.md)。
- `node tests/harness/real-code-task.mjs`：真机macOS、实际隔离 DSH Install/注册、owned clean Git示例仓中两个正规源代码工具完成单一修复：真实baseline `node --test` 先失败，精确旧→新源码diff和SHA、实际测试exitcode、每Attempt一份 `code-change.diff` + `code-verification.json`。已验证一次真实失败保留confirmed file effect，明确retry才造成新Assignment成功；误把旧session/authority或外部provider当新的code authority直接拒绝。 editor 错误是unknown对账而非无效果拒绝，真实failed test仍failed并保留证据。中心/DSH重开后不重复tool call。正常失败重试Ticket共4 artifacts、2 reports、2 confirmed effects，附带有效审计及生产Vue实际内容/桌面390视口；扩展链再加入**真实已编辑源码在前测试工具体内被用户中止**和独立新Ticket成功整链路后、后续Grant撤权第4票之前为3 tickets、4 assignments、4 reports、4 confirmed source effects、7 artifacts，都读取原始影证据并用SQLite integrity/audit验证。该STOP要求完成edit后固定verify工具体启动`node --test`之前进入真实AbortSignal，得到abort/user终态、只有一个真实diff/source Effect、未知整体与显式ack，绝不把ABORTED工具结果或ToolCall当完成测试；中心对单一scope/hash/diff相符的change upload例外留存，并从实际Report传递保存cancel_acknowledged，不放开一般unknown+confirmed或取消后的普通Artifact上传。旧stopped entry自动retry拒绝且不新增Assignment，独立新Task分别进行真实fixed test，之前history不变。它另通过schema14保存并公开固定whitelist的`loom.code-provenance.v1`（call/result/sequence/session/path/sourcehash），分别核对actual Artifact bytes与匹配Assignment/Effect，不反公开私有metadata。Vue据此呈现**逐Attempt**的真实diff/fixed test exit/output/关联；旧缺失或不一致投影仅保留原始字节。中心还强制edit.result<verify.call，并在真实Report endpoint查重复reuse Effect的跨Assignment身份；Report不再靠IGNORE产生新Report却丢失对应Effect。`cargo run --quiet --bin loom -- smoke --listen 127.0.0.1:0`同时覆盖原常规流程与该409 identity负例、旧报告和合法pending retry保留，不是多机exactly-once或1+3 benchmark。**仅本fixture与现有write Grant允许，不增加任务kind或真实generic code agent。** 具体限制、current implementation及reproduce commands见[tests/harness/CODE_TASK.md](tests/harness/CODE_TASK.md)。
- **`real-code-task.mjs` 附加已受理编辑中的Grant撤权阶段**：对已经 ACK、尚无Report 的第4个owned源码task撤掉当前write Grant（creation v1 → revoked v2），只在 immutable work、durable/executing/current view全匹配且原boundAgent/waiter/request owner仍然存活时调原生cancel；local/durable note不能接管别作业。原生 `user` stop只用于既有 pre-test 工具 halted，不把撤权标作 `cancel_requested=true`，也不伪造SDK `revoked`原因、第二Report/followup或最终test artifact。Centre真实Artifact上报得到409 `outcome_unknown`，引用它的Report得到403 `artifact_lineage`；两个local outbox保留真实diff/unknown report与原始digest，独立自动retry/new Ticket不能从旧Grant启动。第4票没有新增中央Report/Artifact/Effect，最终4 Tickets/5 Assignments（此前4），保留base4 Reports/7 Artifacts/4 confirmed effects，重开后仍无新的工具调用，SQL/audit/PWA视图的既有阶段继续valid。最新 `/tmp/loom-code-revocation-tested-wYGIiL/result.json` 为overall PASS。只覆盖这个 admitted source file boundary，不能外推其它Grant变化、任意进程/model/credential/多路任务中断。[CODE_TASK撤权章节](tests/harness/CODE_TASK.md#revoking-a-grant-during-an-admitted-edit-separate-from-cancel)记录精确状态/identity/lifecycle限制。
- `node tests/runner/grant-revocation-fence.mjs`：真Rust+真实registered Node/project root/Grant/current Assignment流内验证 acknowledged-before-revoke、expire old Lease、grant_status false但Ticket cancel_intent=false，未撤销前已 ACK 且未Report的 edit_file才有reconcile stop frame，未领取和其它类型不再开始。实际连续node HTTP Artifact及succeeded Report均被409，SQL无新增Artifact/Report/Effect。超过24条真实audit记录仍必须可读（当前 33/33由同server的Socket与production API 节点读取确认），并持久保留 `grant.revoked` 与正确 ID / old_leases_expired，不能说撤销无 audit 或用receipt回放偷渡权限。首笔真实ack与额外24个未领取Task都是显式模式，未发生native Agent/word output，也不触及一中心三 worker拓扑。

- `node tests/sources/browser.mjs`：真实生产Vue+独立Edge + 真Rust/LocalNode验证Source消息只有record0 Task，人工可选既有精确Grant/file/Node/Worker后另一层confirm才创建具体read_summary；两笔真实Source、各自immutable duplicate、outbox、SQL与Artifact hash对账，当前同原spec不创建新执行。另覆盖一次missing file real fail→明确retry第二Assignment成功，最终2 tickets/3 assignments/3 reports/2 artifacts/2 effects/2 specs且audit有效。帮助分支不被错误Source按钮挤入、中间父Confirm互斥、Content Clone Scope权时不丢失授权约束、390 desktop viewport的实际geometry。包含撤权race无新POST、错误scope拒签，不能把Source registration/message当作新的Grant或Authority。详细实言范围见[Source入口与proof](tests/sources/README.md)。**普通浏览器总回归** `node tests/browser/run.mjs --keep-evidence` 继续另证普通read/write作业、取消与凭据恢复，**真手机、真实多Worker、DSH完整Host、model provider和实际IM/OAuth仍未覆盖**。两Runner在真实Rust中心验证首达停止的原Assignment与cancel完成一同落盘。实际executor调用为0，消息/取消ack实际交付且无Artifact，reopen和错误Node、Grant、expiry保留正确拒绝。`node tests/runner/prestart-replay.mjs`另在自有Synthetic HTTP fixture验证已成功提交报告后丢失响应，等待真实backoff后重开client按同一digest重放，得到duplicate receipt；不是DSH证明。
- `node tests/browser/run.mjs`：原生Edge+生产Vue+真实Rust，执行真实Ticket、Grant及文件效果后，用owned SQLite替换`client_token_hash`模拟旧凭据失效，而不是伪造state。验证401循环输入、先前数据显示为过期、新ticket禁止产生、无效候选不覆盖localToken、受保护读取通过后再保存并恢复同一原cancelled Ticket与真实acknowledge；无新文件/Effect。后续如特指viewport仍注明只是模拟390x844桌面视口，而非真机。
- `node tests/browser/run.mjs --narrow-viewport --keep-evidence`：实际安装的桌面Edge上完成原生Work Space的注册、Grant、读写/效应、取消及窄视口检查。它不是手机、锁屏或iOS/Android真机验证。

此节只记录既有测试入口，不因命令存在自动认定成功，也不以此代替用户明确暂缓的1+3 Compose 拓扑。

## 3. 分层与模型成本

| 层级 | 要证明什么 | 模型来源 | 运行触发 | 外部模型调用 |
| --- | --- | --- | --- | --- |
| 单元 / Property | 状态机、Schema、权限与不变量 | 无模型 | 每次相关代码改动 | 无 |
| 协议 / Fixture Envelope | Rust ↔ JS / 多宿主字段、兼容与未知字段 | 固定版本 Envelope | 每次协议改动 | 无 |
| Deterministic Compose | 注册、路由、跨节点交接、故障与 Artifact | Scripted Worker | PR / 关键合并 | 无 |
| Harness Integration | 真实 DSH / Kimi Code 的生命周期与事件适配 | 可控工具 / Stub LLM / 原宿主支持的 Fake transport | 插件或宿主适配改动 | 默认无 |
| Recorded Replay | 真实请求 / 回复样本的确定性回放 | 审核后的录制 fixture | PR / 协议回归 | 无 |
| Live LLM E2E | 自然语言输入到真实多节点结果的质量 | 指定真实 LLM | 显式调用、带标签 PR、nightly、发布前 | **有 Token 消耗** |
| 平台 / UX | 桌面后台、系统凭据、移动恢复与敏感审批 | 真实设备 / 服务 | 平台改动、发布 | 可选 |

确定性层不能证明自然语言路由总是正确；Live LLM 也不应成为唯一回归网络。某一层的 PASS 只覆盖它对应的边界。

## 4. Deterministic Compose：1 + 3 的日常基线

本轮仅优先 `loom-concierge + 一个真实 outbound Local Node` 的垂直切片。不要通过下面 Design Topology 推断已经实现 Compose、三个节点、多 Harness 或跨机验收。

```text
                    ┌─────────────────────────┐
                    │ test driver / assertions│
                    └────────────┬────────────┘
                                 │
                Node Registration / Assignment / Report
                                 │
                        loom-concierge
                   （Rust · 测试数据库 · 测试审计）
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
    loom-node-a             loom-node-b             loom-node-c
  project-reader         document-summarizer        conflict/unavailable
  isolated git fixture   isolated documents         fault-injection endpoint
  only project A grant   only documents B grant     revoked/narrow grant
  scripted_worker_0      scripted_worker_0          scripted_worker_0
          │                      │                      │
          └──────────── 独立 Secret / 卷 / Node 密钥 ────┘
```

测试环境默认独立网络、无公网出网、独立数据卷与已结束的测试生命周期。Linux 容器覆盖 Linux Runner 路径；DSH / 其他宿主的桌面行为必须在实际宿主运行时验证。

### 4.1 Scripted Worker 是确定性行为源

Worker 在收到指定 Brief / Tool Request 后使用固定工具与响应，真实走协议，不绕过 Concierge 直接更新数据库：

```yaml
trigger: summarize-project-alpha
required_capability: project-reader
output:
  artifact_kind: project-summary
  project_code: ORBITAL-731
  summary_key_facts:
    - designated_fixture_fact
  citations:
    - fixture://project-alpha/README.md
```

可以在 fixture 中安排故意越权、模型残缺结果、重复回调、停顿和崩溃，验证 Concierge 是否保留安全与恢复语义。不能将预生成的“正确答案”直接写入中心结果并宣称 Worker 执行了它。

### 4.2 启动健康不等于就绪

Compose driver 确认后再发任务：

- Concierge 的持久化迁移已完成；
- 三个 Node 分别完成注册、配对、能力声明和心跳；
- 入库的能力与测试 fixture 一致；
- 测试开始前所需 Grants 是通过正式授权路径创建；
- Worker 的受控状态和独立 fixture 均已复位。

未完成以上状态的测试失败原因为 **test environment not ready**，不计为业务 PASS，更不会跳过权限 / 可靠性检查。

### 4.3 基本确定性场景集

| 场景 | 主要硬断言 |
| --- | --- |
| 编程任务到 Node A | 只在 A 的授权 fixture 内变更与测试；Artifact、Git 变更、Assignment / Host 一致 |
| 文档任务到 Node B | 只使用 B 的资料；简报可回查；不访问 A 的项目 / 密钥 |
| A ↔ B 交接 | 双方只收到所需最小 Brief；Artifact 引用与父级关系正确，不把本地绝对路径作为全局 URI |
| 选择 Node C 失败 | 能力不足 / 撤销时正确等待或询问；没有虚构完成或擅自选不相干节点 |
| 当前合法Assignment的ACK重放与响应丢失（真实Rust+generic LocalNode子集） | 认证Node及当前`valid_lease`先于旧回执读取。仅真正NULL+无审计可做首笔原子ACK，合法timestamp+恰一匹配audit才返回原记录，坏值/半历史均409且不补写。实际ACK HTTP 200被注入丢失后，Node持久ACK保持pending，经真实状态重开和原有backoff继续`ACK→ACK→artifact→report`；原timestamp与一条审计、一个实际Report/Artifact/Effect、一次executor、源bytes不变与真实下载hash均硬断言，而非再次执行。其它Node/旧epoch/真Grant撤权仍拒绝；真实字节、原授权和对方完成是不同事实。见`tests/runner/ack-replay.mjs`及[最终proof](/tmp/loom-ack-replay-final-Yc6Qcx/result.json)。不是真实DSH宿主恢复、第二物理机、全局exactly-once或通用取消幂等 |
| 独立vendored DSH bundle普通ACK恢复（真实隔离SDK子集） | 安装从实际`6b3bd71`存档的旧bundle后，读取HTTP 200 ACK再丢弃：原Admission已存在但没有ACK pending，原流程未执行`loom_fixture_write`，产生unknown/reconciling而非成功。修复bundle同一原始Assignment实际写一次HTML，持久ACK+Artifact+Report且此时中央三者均为0；重开真实Host、原注册身份后真实第二个ACK HTTP返回原timestamp、再交付真实Artifact/Report/confirmed Effect。必须实际一次工具effect、一个Session/原requestId/原始Node、恰一条准入audit和实际文件SHA，拒绝换会话、重执行或凭空duplicate。**不是任意mid-tool recovery、任意5xx已提交推断、另一Harness、付费provider、第二物理Host或延期的1+3拓扑**。入口`node tests/harness/ack-replay.mjs`，证据[result](/tmp/loom-dsh-ack-recovery-final-XEfDLI/result.json)和[manifest](/tmp/loom-dsh-ack-recovery-final-XEfDLI/manifest.json) |
| 共享LocalNode的direct stop不混入ordinary replay | 泛用ACK真实丢失并恢复原timestamp/1条原audit的组合driver保持不变，另有**新的合法Grant**及真实Controller取消意图下相同stop ACK必须是两次到中心的HTTP、各用新nonce与点明的legacy audit路径；不能因同参数二次调用命中普通cache就排除server评估。旧raw pending仍可合法投递，先前ordinary cache与quarantined pending不被清除。普通作业执行仍一次，停止子流Report/Artifact/Effect为零。停止回执不能自证SDK已取消或任务已结束。<br>命令`node tests/runner/ack-replay.mjs`与`pnpm --dir packages/node-client test`；结果[PASS](/tmp/loom-stop-ack-boundary-final-SgQ0Yq/result.json)，[manifest](/tmp/loom-stop-ack-boundary-final-SgQ0Yq/manifest.json)。只纠正共享client的分流，不宣称通用stop idempotence、DSH以外的Harness、跨物理主机/手机worker延迟/1+3拓扑 |
| Node State首笔once密集声明（两个真实副本各自） | 在首个pending尚未写出的窗口，以同Node State/同Assignment/同digest同时调用两次；修复前实际各产生A/B两个owned文件。现为每实例内存 in-flight声明，第二调用等原operation真实完成后返回duplicate，不重复调用、不会把unknown升格。不同digest拒绝且不运行，独立Assignment无需排在首个暂停操作之后。检查map清理、失败和unknown的结果重开，非跨进程锁/全局SDK exactly-once/ACK或取消完成的合并承诺。`pnpm --dir packages/node-client test` **39**，`pnpm --dir plugins/dsh-loom test` **109**；`coordinator-admission.mjs`另严格分开合法ACK receipt和零结果Artifact/Report交付，而非误把普通准入当SDK完成。真实隔离DSH生命周期等八事实[/tmp/loom-once-sdk-L5P1nB/result.json](/tmp/loom-once-sdk-L5P1nB/result.json) PASS |
| 原生outbox非法调度及永久保留 | 同一`cargo test --locked -p loom-node --test completed_replay -- --test-threads=1`（现3/3）。真实读取带来两条pending后，非hold非法字符串在任何发送前错误，原item/body/attempt/error与cursor保持，无Artifact/Report HTTP。合法future及`mark_delivery_error(false)`形成的精确hold不當Delivered、不额外发送；保留真正永久拒绝Rejected的优先级。仅字符串坏dates及legacy hold 范围，不改missing/non-string解码、不推导全局幂等或多Host。[RED](/tmp/loom-invalid-schedule-red.log)；[Rust记录](/tmp/loom-outbox-schedule-rust.log) |
| 原生Bare完成输入的重放围栏 | `cargo test --locked -p loom-node --test completed_replay -- --test-threads=1` **2/2**真实reader、StateStore、loopback Runner poll/deliver路径。改变kind/content+取消、epoch、非法Lease/Grant和缺digest不能借用old completion发证据，原Assignment/record/outbox/cursor/effect均不变；exact ordinary/pre-cancel replay只原body/原ID，不额外执行或再签cancel report。Synthetic Grant/transport不冒充真实中心签发，且原生真实bare集成另行验证正常center→node。[test](crates/node/tests/completed_replay.rs)；[RED](/tmp/loom-native-replay-red.log)；[Rust记录](/tmp/loom-native-replay-rust-regression.log) | `node tests/runner/node-installation-scope.mjs`：真实复用一把Ed25519公钥，分别注册两个不同Installation并获独立token，比较first/second写入前后另一条SQL行的所有字段。修正旧版本marker/status/worker/inventory均被另一安装覆盖的问题，现只允许当前身份+未撤销行受更新。错误token实际401；全部SQL原字段均独立保存。负fixture手动单独将首个row置revoked（不新增管理撤销API）后无法再被该 heartbeat改online，other surviving Installation可续更新，真实center restart后SQLite integrity与其原凭据保持。仅检验单process的组合身份存储，不代表物理第二台、独立DSH Profile、全局幂等或新增每Installation撤销模型；[scope proof](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-node-installation-scope-proof-fEdyqy/result.json) |
| 首次注册的交与凭据围栏（真实Rust/SQLite子集） | 命令`node tests/runner/registration-atomic.mjs`：以实际Ed25519身份、真实HTTP与owned SQLite，验证单个BEGIN IMMEDIATE事务内的正确challenge/signature、enrollment/challenge条件消耗、Node/token、audit同时成功或全不生效。错误签名不得烧掉好code；新合法签名恢复原code；服务器**持久触发器拒绝`node.registered` audit**后，code/challenge/Node/audit全部回滚，删唯一fixture trigger再正常恢复。另核验原proof无凭据重放401、错误身份、同公钥旧token rotation（新code不误用、旧token失效）、撤权后新code无复活，第二Node凭据不能复用，center重开后hash chain/Integrity/token不变。属于单process Storage可靠性，仍无Grant/Ticket执行、lost-HTTP全局幂等、远程TLS/OS凭据中心、真实手机/多Host或1+3部署。[实际proof](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-registration-atomic-proof-N4xHhw/result.json) |
| 同源PWA静态app-shell（仅公开壳） | 真实production build、Rust同源Root与独立Edge profile，首次在线注册及实际五份缓存：root/manifest/favicon/hash JS+CSS。manifest与sw MIME正确，逐项CacheStorage SHA等于dist，所有`/api`均不进入缓存。`setOffline(true)`后实际controller导航仍渲染Vue+CSS且390 viewport无overflow；受保护取数真实报错仍显示旧快照提示。fresh冷启动在未安装时真实网络失败，不伪造offline成功。恢复后整套bootstrap/projects/tickets/nodes/grants/memories/preferences读取完成并恢复connected状态。命令`node tests/browser/offline-shell.mjs`，更新证据也进行了真实`browser.close`与offline新进程：公开CDP核实本次browser PID为13794→13839，命令行指向同一owned profile；五项静态bytes/hash保持，原线程请求读取仍失败，不能称真手机/原生App进程生命周期。读取恢复仍逐步实读。 [最新result](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-shell-proof-N74xgk/result.json)、[manifest](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-shell-proof-N74xgk/manifest.json)。只是同源prepared shell跨进程回访，不是首访离线发现、业务缓存/离线Grant、后台worker、独立物理手机OS或HTTPS/多Host部署验证；本次明确的当前进程PID为13794→13839，不用旧例中的进程号重复冒充新证据 |
| 公共静态candidate/read-back与不可变release | `node --test --test-timeout=20000 tests/browser/shell-cache.test.mjs`：执行当前worker的公开候选与发布contract，检查同源/MIME/正确URL对应的MIME和完整body digest、错误root、非预期asset、缺失/篡改body、>2MiB、Authorization-bearing key，以及15秒stall真实收到AbortSignal。共10项（包括拒绝带query但对应路径仍像hash asset的资源身份）。**非同版本不同bytes必须换`SHELL_CACHE_VERSION`，pending不是已发布release；只能向空新桶逐项copy并完整read-back，非空桶若完全一致才接受。** 现有真实Rust/Edge原始offline与进程重启同类检查另见`offline-shell.mjs`，当前[实际结果与源码manifest](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-shell-proof-N74xgk/manifest.json)。另以`node tests/browser/offline-shell-update.mjs`对literal v2 worker做真实Edge旧→新→失败候选→offline验证：从经过明确同域fetch/body-read调度的`c833aa8` v1开始，实际publish exact五文件，再对非canonical root与受控root-write fault后的健康release逐字节/MIME复核并真实离线渲染。**两个独立owned profile**中，旧根写入异常使v1整体删除，而新候选失败只清pending并保留v2。**旧fixture的调度适配**与`DOMException(QuotaExceededError)`根写入故障，不能冒充任意历史版本的批量升级或物理配额耗尽。等待使用Node调用`page.evaluate`读取实际boolean；不可把当前Playwright`waitForFunction`异步谓词的Promise truthiness当已发布，也不能用`caches.open`为观察制造空cache。结果是[当前迁移proof](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-shell-update-proof-XkkpmI/result.json)，controller的出现/update resolve绝非满足上述条件的替代。此Node loopback静态fixture不等于Rust部署、无Grant/Artifact/Task/Effect/认证缓存；未证明签名更新、全原子rollback、真手机OS、跨机或1+3拓扑 |
| 节点失联 | Ticket 持久保留；离线、Worker 失联与失败分别呈现 |
| Lease 过期 | 迟到旧 Worker Report 不被接受为当前权威结果 |
| 重复事件 | 同一 Report / Effect 重放不会重复外部副作用 |
| 中心 / Node 重启 | 可从持久证据恢复；SessionRef / ArtifactRef 保持关联 |
| Unknown Outcome | 不可证明的成功进入对账或人工处理，不无条件重跑 |
| 仅失败重试（当前Rust+真实UI） | public retry仅failed且无停止意图，原Grant/digest/Node/worker/binding保持不变，产生新的Attempt；pending/running/cancelled/succeeded/reconciling均不新增作业或retry审计。审批首Attempt走独立审批校验。failed UI点明确重试后必须实际执行，旧失败的下载bytes/Report/Effect不能被覆盖；未知只提示先对账、不得提交确认框。人工审批首签另行要求当前waiting_approval、原Grant/Binding/root/worker与当前fresh heartbeat；实际reason必填且规范后最多1000UTF-8字节，AUDIT中须存储原文字/approval_id/真实Assignment/lease，拒绝只保留hold不创建作业。任何事务审计失败都不得遗留新Attempt，且`assignment.retried`必须与`ticket.retried`同属原子提交；审批ID不暗含幂等授权。证据：`tests/harness/real-code-task.mjs`、`tests/sources/authorized-ticket.mjs`、`tests/sources/browser.mjs` |
| 权限负例 | 越权路径、伪造 Node、错误 Grant digest、过期 Token 和跨 Profile 读取被拒绝并记录 |
| 重试确认框已打开、随后撤权（当前真实 Edge 子集） | 已形成的失败报告不能因打开过确认框而占用旧Grant。真正撤销原Grant后才点击确认，实际400 grant-revoked，原attempt/assignment/digest/Report和已交付bytes仍在。无新Assignment、Report、Artifact、Effect或后续Node执行；所有原Ticket ID仍存在，数量仅增加预期的失读Ticket。模态显示实际错误与返回检查，无另一个Grant被换成执行权限，也不是cancel_requested/native abort证明。见`tests/browser/README.md`与`run.mjs` |
| 撤权的普通未领取工作（当前真实 Edge 子集） | 用户 UI 确认同一Grant撤销，版本/revoked_at与权威资源刷新一致，而不是只看按钮消失。 Ticket保持reconciling且cancel_requested=false，Assignment尚未acknowledged，旧Lease不续、旧报告/字节仍在。连续两次Node poll均返回assignment:null，executor/outbox/Report/Artifact/Effect/目标文件均无新产生。旧Grant的合法形状复用必须403且不新增Ticket。快照刷新失败不能回收中心已确认撤权的语义或声称列表当前有效；见`tests/browser/run.mjs` |
| Memory来源与精确撤回（当前受限Rust+真实Edge子集） | `source_ticket_id`如果提供，只能是实际存在的Ticket；显式 project必须与原票据同项目。伪造关联、未知404、非文本拒绝均不得创建Memory或对应审计；无来源Memory仍允许。真实UI编辑后不伪造来源或候选创建，删除同一linkedMemory使原候选pending，又是新ID而不是恢复旧ID。原Ticket/Grant、原候选source_refs保持不变，schema14重启可用。普通显式编辑/删除有各自的原子审计、真实旧版本/出处和变更标记，写审计失败时SQL trigger实际证明Memory原值及全部audit不变；候选linked delete仍只有原本的withdrawal，不重复记ordinary delete。见`tests/observations/README.md` |
| 历史 Source → 已有任务回访（当前真实Edge子集） | 显式关闭并重开相同Source thread后，`task_ticket_id`可直接打开原Ticket。先显示关闭Source modal，再读取对应ID，不能让GET好的审批Ticket仍被浮层遮挡。待审批的“检查并决定”需真实可见且命中，不只是请求200；导航本身零Ticket/Approval POST、零新工作。继续拒绝→真实heartbeat→明确批准→原Artifact。详见`tests/sources/README.md`与[回归证据](/tmp/loom-source-navigation-final-JIhpMF/result.json)。 |
| 发送者filter及同Ticket同步（当前真实Edge子集） | per-Ticket选择真实worker及另一Node活动标签分别只显示当前过滤者，不能只取All。重置All必须为JSON null，两条恢复、原消息ID/Grant/Report/Artifact/effect不变。后端非法value（number/object/空白/control/超过160字节）拒绝并保留原有效值；非空global sender拒绝，当前global仅保存展开默认。同一Ticket的偏好GET更新后，local sender及实际消息同步，不靠切票/整页重载。附于合法Node身份的显式label仅用于字段匹配，不声称另一真实Principal或额外Grant。见 `tests/browser/README.md`、`tests/browser/run.mjs` 与 [结果](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-l4ZOBa/result.json)。 |
| 会话可见性 | 默认折叠、单任务展开不改变数据；消息可见性与 Artifact 访问权限各自成立 |
| 偏好作用域（当前真实 Edge 子集） | 没有 Task override 时继承 global；显式折叠和 absent row 不混淆。单任务 PUT 仅带该 Ticket ID，global PUT 不带；四类显示切换与恢复不重写 message/Ticket/Report/Artifact/Effect。偏好读取 401 应为认证失效，403 为该显示的降级而非伪造同步成功。**真实网络IO错误**在嵌套偏好读中也必须传给当前Ticket/workspace外层处理，不能因局部resolve变成最新数据已取得；直接读仍按原API resolve，不产生unhandled rejection。见 `tests/browser/README.md` 与 `apps/web/tests/display-preferences.test.ts` |
| Artifact身份、原始内容及失败读取（真实Rust/Node/Edge子集） | 既有纯文本下载须对应owner Ticket、单普通相对存储name与UUID固定文件名、常规文件与实际byte SHA；cross-ticket403，bad path/nonregular用409 `artifact_location`，缺bytes专报`artifact_storage_unavailable`，篡改/坏digtest为`artifact_integrity`，损坏metadata不panic。真实Node上传合法UUID/正确hash的non-UTF8，读取只可409 `artifact_encoding`，不能lossy替换成文本。纯文本正例须读回原bytes及identity（`encoding:utf8`、`truncated:false`、真byte size），interface缺数据、错误metadata、迟到跨票response均不得写入缓存；恢复原byte和SQL metadata后原Artifact仍能render，原Report/Effect/Assignment、Grant digest及新Ticket撤权/认斷事实不被置换。**看见**损坏/读取失败的Error不会冒充完整binary下载，**不是**generic Blob/Range/多principal支持。见 [13阶段 proof](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-Kfz5Xu/result.json)。 |
| 浏览器↔中心断网与恢复（真实Edge、客户端层） | `browserContext.setOffline(true)`隔离浏览器，保留已加载的原始Ticket/文件；实际触发`net::ERR_INTERNET_DISCONNECTED`。必须出现不明示Worker离线的旧快照警示和只读刷新入口。切Online本身不能清除警示；明确点击后真实GET取回同Ticket、Report/Artifact/Effect/Assignment、Grant/digest及原始文件SHA，原Grant仍有效、audit可验证，**该断网/恢复序列0次权变写请求**。见 [完整12阶段结果](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-VQbEx1/result.json)。**这不是**实际移动锁屏、杀进程、蜂窝/WiFi切换或PWA关闭后离线存储。 |

正是这些场景决定 Loom 的可靠性，因此不以“Live LLM 不在线”为理由跳过。

## 5. Harness 与 Recorded Replay

### 5.1 宿主适配测试

DSH / Kimi Code 各自使用原生扩展机制和独立测试宿主：

- 安装、启用和配置**真实插件**；
- 节点主动注册、身份映射和 Profile / Worker 隔离；
- 输入送达、任务提交、取消、宿主 Session 重开；
- SessionRef / ConversationSegment / MessageRef 映射；
- Structured Report、Artifact 和运行错误；
- 协议升级、宿主重启、插件禁用与撤销；
- 不支持的能力如实声明，不用静态状态或臆造 Transcript 补齐。

如果宿主提供可控模型接口，优先用 Stub LLM / 确定性工具保留真实调用链。若接入宿主本身必须消耗 Token，把这条链归入 Live 并记录成本，不把它当 Deterministic。

**容器里的逻辑 Node 通过，不等于 DSH / Kimi Code 插件在桌面真实宿主通过。**

### 5.2 录制回放

从开发者显式批准的 Live 场景中保存标准化交互样本：

```text
request context / protocol / model parameters
→ model or tool response
→ plugin events / report
→ expected structured effects and assertions
```

- 只录制合成 fixture，过滤或替换 Secret、真实隐私数据和绝对路径。
- 保存模型 / Provider / Plugin / Concierge / Protocol 的版本、时间、调用 hash 与采样参数。
- Replay 的请求语义指纹和协议关键字段必须匹配。核心请求格式或工具定义变化时，标明需重新录制，而不是强配旧响应。
- 录像记录可以帮助诊断，但默认设置保留期限；CI 凭证、用户数据和无限 Token Transcript 不能进入仓库。
- Replay 名称、环境和结果应写 `mode: replay`，**不与 `mode: live` 混称**。
- 在相关模型 / Prompt / 路由语义改动后，至少有一个抽样场景重新跑 Live，验证回放没有完全偏离现实。

## 6. Live LLM E2E：保留真实 Token 验收

Live 测试向 **loom-concierge** 发送自然语言，不预先替中心写 Ticket、Placement 或 Report。例如：

> 请整理项目 Alpha 的开发说明，保留两行摘要，并交给文档 Worker 校订。不要改动原始项目，交付一份带来源的报告。

测试 Driver 仅需提供目标、允许的输入和预算，然后让真实系统产生决策、授权流和协作。

### 6.1 三个 Live 基础场景

| 场景 | 作用 | 结果检查 |
| --- | --- | --- |
| 跨 Node 文档流水线 | 用户意图 → 项目读取 → 资料 / 文档协作 → Artifact | 内容、来源、路由、最小权限和 Artifact 均可验证 |
| 缺能力或临时离线的请求 | 规划是否诚实、是否懂得等待或询问 | 不假称成功，不错误替代 Host，状态可检查 |
| 输入中带有诱导越权命令 | 模型是否可以跟随用户目标而仍受系统策略约束 | 机密绝不交付，原任务安全完成或明确阻塞 |

这些是通用任务，不依赖固定 GPU 或游戏资产。可选媒体场景只在实有测试模型和显式预算时执行。初始每夜运行少量场景；路由、Policy、Prompt、模型、核心交付或习惯学习改动时增加相关场景，发布前跑完整支持范围。

### 6.2 硬断言是第一道门

每个 Live 场景独立检查：

1. Ticket、Assignment、Worker 和实际执行节点符合明确的路由约束；
2. 必要的 Grant 存在，没有替代授权与越权读取；
3. 实际 Artifact 存在、格式和内容满足 fixture 要求，含输入谱系 / Hash；
4. 响应引用实际 Ticket / Artifact，不声称未完成的阶段已完成；
5. 出现超时、离线或未知副作用时，最终状态与证据一致；
6. 非相关 Worker 未接收额外资料，中心及 Artifact 不出现测试 Secret；
7. 会话默认折叠及按需展开仍与同一任务关联。

硬断言失败时，即使最终答复“看起来不错”也为 FAIL。不得由 LLM Judge 裁定这类事实通过。

### 6.3 LLM Judge 是带 Rubric 的第二道门

只对难以用字符串精确断言的部分使用不同、可审查的评审器：

| 评审维度 | 证据 | 典型问题 |
| --- | --- | --- |
| 目标完成度 | 输入、Artifact、最终结果 | 是否回应真实目标、遗漏可验收要求？ |
| 不确定性诚实度 | Ticket / Effect / 评审摘录 | 是否掩盖了离线、未验证、待授权？ |
| 简报充分性 | Shared Brief / Artifact | 是否足够完成下一步、又未扩大信息范围？ |
| 澄清与打扰 | 实际消息序列 | 选择是否合理、是否重复追问已知偏好？ |
| Skill / Memory 候选 | 原始 fixture、候选及作用域 | 是否准确总结重复经验，是否包含隐私或推断授权？ |

Judge Prompt 固定版本、提供结构化 Rubric、指定证据位置并要求给出失败原因。Judge 也应设置 token 配额；超时或不可判是 `judge_error`，不是 PASS。对稳定的核心场景建立审核基线；不同模型或 Prompt 的结果作趋势观察，不将一次评审分数当成真实可靠性的唯一证明。

### 6.4 不做整段 Golden Chat 比较

即使温度设为 0，Provider、宿主或工具版本变化也可能让文本不同。不要用聊天原样相等作为通过条件。

- 关键字段、任务结果、外部效果和证据做精确断言；
- 必须稳定的结构做 Schema 校验；
- 自然语言用 Rubric 与小规模人工复核；
- 测试失败不能只改期望文本而绕过安全或真实故障。

## 7. Token 预算、凭证与触发规则

### 7.1 默认不触碰真实模型

- PR / 普通开发仅跑确定性、宿主 Fake 和 Replay；CI Live 为独立 Workflow。
- Live 的环境未显式提供测试 Provider / 测试 Budget 时，结果为 **NOT RUN**，不自动变为 Mock PASS。
- 没有 secrets 的 fork、离线环境或 nightly 订阅失效时明确标记 Missing Live Coverage。
- Live Secrets 放在托管 CI Secret / 测试 Broker 中，不进 Compose 文件、命令行日志、脚本、测试报告或 Git。
- 任何 Replay 不得在后台偷偷用 Live API 补齐遗漏；模型调用需要显式来源和报告。

### 7.2 每个场景的预算

```yaml
max_wall_clock: 300s
max_model_calls: 8
max_input_tokens_per_task: 12000
max_output_tokens_per_task: 4000
max_retries: 1
max_judge_calls: 1
max_cost_per_task: configured_by_test_budget
```

上面是**预算形状示例，非已校准阈值**。先在若干真实场景测量，再按模型、Provider、任务复杂度和 CI 频率定预算。达到上限时任务标为 `budget_exceeded`，保存已完成步骤和调用用途，不能反复自动重跑直到偶然成功。

同一 Live 场景可重跑用于观察非确定性，但必须有独立预算与频率限制；不因失败而无限追加 Tool Calls。

### 7.3 报告与环境

每份报告保留：

```text
run_id / git_commit / triggered_by / mode: deterministic | replay | live
scenario_version / protocol_version
concierge_version / plugin_versions / harness_versions
model_provider / model / parameters / prompt_and_rubric_version
per_scenario_and_aggregate tokens / estimated_cost / durations
hard_assertions / judge_evidence / errors / not_run_reason
artifact_refs / expiring_sensitive_evidence_policy
```

Provider 只返回估算用量时如实标记 estimated；不宣称 UI 估算等于实际账单。记录失败调用和 Judge 的 Token 成本，不能只统计成功完成的部分。

## 8. CI 和本地输出

当前已建立 Rust workspace 与 JS workspace。以下命令对应当前真实实现（稍后附录保留通用测试 driver 的目标语义）：

```text
# 协议 fixture、policy、recovery
cargo test -p loom-protocol --features fixture-signing

# 单进程确定性场景与 SQLite 恢复
cargo run -p loom-concierge --bin loom -- smoke

# TS Local Node / DSH Host bundle（不会安装插件或改 Profile）
pnpm --dir packages/node-client test
pnpm --dir plugins/dsh-loom test

# Vue 3 + TypeScript：SSR/API 约束、类型检查与生产构建
pnpm --dir apps/web test
pnpm run build

# 真实前台 Rust↔TypeScript 单节点、真实文件执行/负例
node scripts/real-integration.mjs

# 独立的 Synthetic 9 与真实单节点场景，顶层 result 必须全部 PASS
node scripts/verify-baseline.mjs
```

当前没有 Compose fixture、CI workflow 或 Live LLM 结果；无 iOS/Android/Windows/Linux 目标设备验证。真实 DSH 插件仅离线宿主源与 mock adapter 验证，禁止把其标为已安装/已通过实际 Session 层。

以下是目标 driver 参数的接口形式，尚未提供统一命令行包装：

```text
测试驱动参数：
--mode=deterministic|harness|replay|live
--scenario=<id>
--keep-artifacts
--live-budget-profile=<approved-profile>
```

产物按场景提供机读 `result.json` 与人类可读 `summary.md`，并附必要 Event / Artifact 引用。失败时保留责任归属：`environment / protocol / policy / harness / model_behavior / budget / judge_error / flaky/infrastructure`，不把环境错误包装为业务成功。

### 8.1 通过门槛

- **代码合并**：相关单元、协议、Deterministic Compose 通过；相关宿主有 Harness / Replay 覆盖。
- **宿主打包发布**：该宿主的真实安装、任务、取消、Session 恢复和权限负例通过，不能只依赖容器服务。
- **Live 重要语义改动**：至少一个相关 Live 场景，硬断言通过且 Judge 没有实质退化。
- **里程碑完成**：Roadmap 的场景覆盖矩阵、故障测试、目标平台与 Live 抽样有证据，未执行项被明确列为缺测。
- **已知不稳定用例**：隔离、说明原因、有跟踪与到期复核；不以 quarantine 名义长期删掉核心负例。

## 9. 新增测试时需要回答的问题

1. 它验证的是协议、宿主适配、模型行为还是 UX？哪一层最便宜且最真实？
2. 哪个外部事实能证明它通过，而不只依靠一句文本？
3. 如果失败，是环境、协议、Policy、宿主、模型、预算还是基础设施？
4. 它是否需要 Live 模型？若不需要，如何保证测试默认零 Token？
5. 它是否可能在用户私有目录、真实宿主 Profile 或生产服务上写数据？
6. 超时、断线、权限撤销、重试和重放后会发生什么？
7. 失败后留下的证据足够排查吗，又不包含 Secret 或无限保留的 Transcript？
8. 这条场景被 Mock 伪造覆盖了吗？是否需要记录在兼容性与发行验证矩阵中？

测试的价值不是不断证明 Loom 总能跑通，而是尽快证明哪些条件让它**不能安全、诚实、可恢复地完成任务**。
