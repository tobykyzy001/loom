# DSH isolated harness evidence

此目录是受控的真实 DSH Host runner，不使用 agent Mock Host、私有 Session Event 或 Live LLM，也不把 DSH plugin 安装到运行中的 Desktop Profile。

## 已执行的真实场景

Authoritative 命令（在 Loom 仓库根目录、继承经过核验的 Desktop runtime）：

```sh
LOOM_TEST_OUTPUT=/tmp/loom-dsh-lifecycle-result.json node scripts/dsh-fixture-runner/run.mjs
```

**实际退出码：0**。`run.mjs` 对应安装 **DSH `@deepseek-ai/dsh@0.2.2-rc.3`**。私有结果位于 `/tmp/loom-dsh-lifecycle-result.json`，本次 owned root 为 `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-dsh-jRoFkD`。Host 两次生命周期均以 `code: 0, signal: null` 结束（`private/host-lifecycle.jsonl`）。

- 安装：在 fixture-owned `DSH_HOME` 内、Profile `loom-local-fixture` 中安装 `@loom/dsh-loom` 和测试 Provider，目录权限 0700。没有调用 `plugin_manager`，没有访问或改变既有 desktop Profile。
- 注册：实际 `ctx.agents` + Cordis inject 启动。Node id `ff4bc4f2113392e25836fbcc110c7f31c335d1861eda62637100bcc804cfbf3a`，default Worker，`harness_kind: dsh-host`，Host 声明的 synthetic project root 通过 heartbeat inventory 参与中心 ProjectBinding 校验。
- 真实任务：Ticket `tkt_b181e3d8515b492a836d27f951c55f48`，Assignment `asg_8f80ab613e39414886a6758c3d734b30`，Session `9be0df45-fe9b-43c5-8f6f-b004980ae26e`。真实 LlmAdapter 产生 `loom_fixture_inspect` tool-call，公开 tool registry 执行后形成 committed assistant/message，再由不可变 Artifact `2b122c56-3f7d-44ee-be45-7c20770c7700` 交付 SHA 校验的文本证据；不是指令性文件 helper 代替 Agent。
- 取消：另一个独立 Ticket `tkt_4e477c59f09d430698aecbc88e63f87e` / Session `02d4fe3d-19b2-4159-82cd-cef39299364c`。正在运行的 Agent 通过公开 `agent.cancel({kind:'user'})` 结束为 `turn/end.reason.kind === 'aborted'`；中心 Report 为 cancelled，且 `cancel_acknowledged` 为持久化的真值。
- 恢复：实际关闭 Host 后以相同 fixture `DSH_HOME` 启动，执行 `session/resume`，随后发送新的 Ticket。实际 Stub 收到的 resumed request 包含此前的 tool-call，且新 followup 成功。识别失败的根因曾经正是缺少 `UserMessage.id`，因此当前公开 followup 消息包含显式 `id`、role、source、content；没有改写历史来取得恢复 PASS。
- 机读结果：`overall: PASS`，install/register/task/cancellation/resume 全为 PASS；`live_llm: NOT RUN (zero network Stub)`。

本 runner 也包含这类**非可通过预生成 transcript 证明**的硬断言：center 接受 Artifact 的 UUID/lineage、导出本地 state 文件 mode 0600、DSH 构建的 SessionRef map 可跨进程保留、真实 ToolEvent、真结束原因以及多个 Assignment 各自 Session correlation。

## 实际 bounded file effect（后续专项验收）

以下 real run 继续覆盖真实文件效果，不只 assistant text：

```sh
LOOM_TEST_OUTPUT=/tmp/loom-dsh-file-effect-result.json node scripts/dsh-fixture-runner/run.mjs
```

实际 `MAPPED_EFFECT_TRAVERSAL_EXIT=0`，`overall: PASS`，owned root `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-dsh-GR1BiV`，`live_llm` 为 NOT RUN。两个 Host 都是 `code:0, signal:null` 退出，OAuth/真实用户 credentials 没有被读取。

- Task `tkt_fbdbcddd7aed4ef6b20ff1c50203fc29` / Assignment `asg_4a6c89f22241472d9b827928a28367ac` / Session `4d8d13f1-9e0f-4bfb-8509-36dc361c8337`。
- DSH  public `tool/call.name='loom_fixture_write'`，actual call id `loom-fixture-write-loom-stub-3`，由 `loom_fixture_write` 这个测试 Profile 内注册的公开工具执行。
- 工具只接受显式约束的 `demo.html` 和 synthetic title，生成 231 bytes 原子新文件，模式 0600。工具guard 包括固定授权项目真实路径、只有 demo.html 通过的路径模板、title/size limits、临时文件及执行 signal；不存在通用 shell / 任意根写入或 DOM/browser 操作。
- actual public ToolResult id `9ad4aee0-77c2-4319-82e7-896b37a70358`，created=true、isError=false，路径/title与 ToolCall 一致；随后真正 `realpath()`、回读文件与 SHA256 校验一致，得到 `ac4b958b8a1f516cdb14a0c659f0cb69391b42f2e1a8b7323c86d4631f2736b3`。
- 中心 Effect `92b0a6bd-66fa-4338-aebc-d9035696c4f2` 为 confirmed，evidence 只含白名单 ToolCall/ToolResult ids、seq、path/title，关联真实 Session log。中心 HTML Artifact `20496057-8d34-4db8-9981-9754a58e51a8` 支持 `text/html` 下载，内容与原始磁盘 bytes 完全相同。由同一事件数据给出 Effect 和 Artifact，不从“写完啦”一句对话推导。
- 2.2 秒后重复查询仍只有一个 Report/Effect/Artifact；实际 `loom_fixture_write` 执行仅一次。没有重复副作用或第二个文件 Effect。
- Traversal Ticket `tkt_d7e5748a8d3a4977b6a2d4c4b3e47497` 为 failed，公开 ToolResult `isError=true`：真实 Loom tool registry 拒绝 `../escape.html`。没有 `escape.html`，先前 HTML bytes/hash 未变，未声称错误路径产生 Artifact 或 confirmed Effect。
- 同一 authority flow 再次完成实际 in-flight cancel (`turn/end` aborted +中心 ack）和 Host 重开的 Session resume；这是本轮所有 fields 均 PASS 的完整流，而非只写文件标签。

### Fixture-only flag 与剩余边界

生产默认 `bounded_fixture_effects=false`。仅这个测试 Profile patch 将它设为 true；此时 DshAdapter 也只采集匹配的 fixture tools，不从其它 agent/provider/tool text claim effects。普通 Host session / 用户根路径不会被解释为样板 demo 授权。即使测试 profile 开启，以准确 Grant root `realpath` 和 public output schema 之外的输入都不能通过文件校验。开启该功能不是文件权限或产品占位 Tool 支持。

受限 `loom_fixture_write` 只验证 **DSH Agent + 原生工具注册 + scoped file effect + Effect/Artifact 血缘**，并不证明 general Programming/自然语言模型能力、任意编程工具就绪、跨进程 exactly-once、Live LLM 质量或 Agent对现实项目无副作用。单元测试还覆盖默认关闭和实字节 SHA 校验，但那些不是实际 Host验收证据。

- CLI：`dsh --help`、`dsh --profile loom-local-fixture --from-default-profile sdk-minimal --dump-config`（仅首次 owned 初始化）、`dsh plugin --profile loom-local-fixture add file:<fixture> --ignore-scripts --store-dir <fixture>`、普通 `--profile ... --patch <fixture-patch>` 启动与配置 dump。
- Host：`export const inject = ['agents','sessionPersistence']`；`ctx.llm.registerAdapter([provider], LlmAdapter)`；`ctx.tools.register({...})`；`ctx.agents.create/get/resume`；`agent.followup({id,role:'user',content,source:{kind:'loom'}})`；`agent.cancel({kind:'user'})`；公开 `session/event` 的 `assistant/message` 和 `turn/end`。
- 观察/控制：公开 SDK `initialize`, `session/prompt`, `session/wait`, `session/resume`, `shutdown`。由于 session/event 推送结构是实测字段 `data.message.content`，Artifact 从该真实结构提取，而非从预设 Mock 结果填表。
- Profile：只使用专有的 `loom-local-fixture`。创建后绝不再使用替换式的 `--from-default-profile` 启动或 dump（官方机制会替换整个 custom Profile，包括已安装 bundles）。
- 环境：独立 `HOME`、`DSH_AGENTS_HOME`、restricted `ENV`（不继承 API credentials/proxy），零出网 Provider；persistent shell 禁用，文件权限 workspace-write 受合成根约束。Case 不需要 system Credential Store 或真实密钥。
- 依赖：本安装未解析到 `dsh-llm-mock-server`/`dsh-llm-replay`/Agent-loop testkit，因此直接使用实际 `LlmAdapter` 接口合成 zero-network Provider。新 Profile 的 Schemastery 依赖由同版本 shipped package 的 test-owned forwarding shim 提供（不复制其实现，不下载与生产无关依赖）。安装使用 shallow test copies，避免通过链接递归扫描工作区 scope。打入运行包的来源与 startup 都从实际 `package.json`/manifest 验证，不用 dump 名字替代已激活事实。

## 仍未由此证明的范围

这不是 M0、产品级或多平台整体验收：没有移动设备、GUI、真实 LLM、已部署/OS Credential Store、平台签名、网络隔离稳定性、通用编程 Agent 支持、通用文件工具/任意副作用、跨 Profile/Worker 越权和旧 Lease 负例，亦没有多 Harness 测试。

只读的 `loom_fixture_inspect` 与 opt-in、严格受限的 `loom_fixture_write` 是两条明确分界的受控 Tool 链，后者已经真正写入 demo.html 并提交其 Effect；仍不将它扩大解释为通用编辑能力。先到的 cancel/completion race 的案例也未扩展为通用 exactly-once 承诺。中心采用 at-least-once 与 reconciliation，Runner 对同 Assignment 的普通重复 poll 去重，取消只通过独有的停止分支进入真实 Agent，取消意图本身不会改写 running completion 或制造 ack；实际 `turn/end`/operation result 最终由单一原 Assignment 的 outbox chain 上报。

其他 Rust/应用改动由 concurrent owner 完成，本目录的 runner 的默认来源仍是项目的真实 `scripts/fixtures/rust-server.mjs`，不替换为 SyntheticCoordinator。以往失败 probe 不作为本次 PASS 证据；不可复现的环境 blocker 必须单独报告，不能换为 mock 假装执行过。

## HTTP/Node transport 边界专项

```sh
pnpm --dir packages/node-client test
pnpm --dir plugins/dsh-loom test
```

本专项验证 `packages/node-client` 及 vendored plugin 自己的 HTTP/NodeState 实现，不用受信方拒绝来掩盖客户端先泄露凭据：

- `/nodes/*` 除了明确的 `nodes/challenge` 和 `nodes/register` 匿名路径外，必须带非空、非空白的 Node credential；缺少或用 whitespace 时**根本不构造fetch并抛出注册/授权错误**，不能拿同实例的 client/admin token 回退。重复注册可以带合法旧 Node token，后续心跳仍使用注册获得的 Node token。挑战匿名请求本身无 Authorization，admin 调用自己独立路由时才可以用 admin credential。
- 已有abort在fetch之前停止；fetch之后/读取body之前再次检查，避免返回一个 `{}` 或 `assignment:null` 把取消误当成没有任务。Configurable timeout仍按普通可以延迟的网络错误处理，不是停止宿主或已经取消外部副作用的代名词。
- 调用者给 `dispatchOutbox` 的自身signal触发时，立即传播取消原因：不调用下一条entry、不改attempts/backoff，不把shutdown改写成`deferred`的普通网络错误，不把entry标为已交付。持久pending与原始request ID/unknown summary需要保留，后续另一次普通可达dispatch才能交付。这一步不保证已发出的远端副作用被取消，也不允许伪造 exactly-once。
- Normal offline / network timeout保留相同原文body和logical digest，并把next attempt手动推到due以确定测试可重试语义，不必真实等待退避或准许远端执行。旧`401/403/409/410/422`隔离行为与normal backoff 保留，不因局部 caller stop全局静默放弃正在解决的工作。
- Whitespace enrollment result先在临时变量验证，在写入候选前不改变活动身份。有效 candidate 用原子文件更新后才更新 `this.data`；非法输入或文件替换失败都不会提前丢掉旧、合格token或其可用后续请求。公共 Node client与 vendored plugin均断言**内存中的旧 token还能发出后续有效的heartbeat**，不只读磁盘。另有body消费中取消承载非空Assignment的硬负例，不能把一次可作业响应加入活跃任务。测试只对比预期fixture值/用法，不把任何真实token或身份私钥纳入证据、HTML或 System Credential Store。
- DSH plugin test 直接导入 vendored源码，有两个 HTTP/Caller-Signal case，避免只claim形状相同的副本文档被验证。实际 isolated DSH install/register/task/cancel/resume 和Credential（未知结果、真实delete/restart）也再次 PASS；这不能代替多个平台、多客户端、通用幂等或任意外部Failure proof。HTTP 与 NodeIdentity 两份公共 helper 逐字同版；plugin 原有 Worker 默认策略未被这项 transport 边界修改。

运行入口只使用合成/owned 临时文件和内存 transport，无网络发现、生产 directory、OS Credential Store、真实用户身份、收费模型或修改现有桌面/DSH Profile。从公钥签名和authorization隔离到outbox持久恢复均看实际 NodeClient代码行为，而不只是断言 Rust会拒绝最后错误。

Enrollment code 仅 child environment 传输；重启没有新 code，使用真正的本地持久 Node credentials。不合规 Patch 没有 literal Token，输出不含 node token/private-key/raw session transcript。原始日记仅在 fixture private/state 以 0600 留存，绝不包含用户私有目录信息；`private/host-lifecycle.jsonl` 只留 argv 名义、协议初始化和实际退出状态。

## Durable Assignment admission 与回执恢复专项

入口、命令和精确边界见 [tests/runner/README.md](../runner/README.md)。本轮先以真实文件状态找出 TypeScript/vendored runner 重启后丢失的 Grant fencing，再覆盖同一 dispatcher/Coordinator active promise、合法与伪造取消、无 input digest 的旧 completion 和 DSH result completion-before-report。所有结果来自真实 `NodeIdentity.open`、`NodeState.open`、actual file operation 和实际控制面，不只由语法编译或 HTTP 200推断。

- 非取消执行在持久化前完成 Node/Grant/root/work Content 验证。Controller 每轮 poll 的当前 `status/purpose/operation/grants/grant_status/resource`、Lease 时间窗与有效 Grant 状态和不可变的工作输入分开。`model_binding`同时保持不可变 content 含义与 poll 表示的一致，当前Grants在每轮权限路径重验，不得刷新出另一份placement。撤销可以阻止新的执行，却不会让先前已认领工作的停止意图凭空丢失。
- 私有 `rejections` 只保存本地拒绝/核销，不并入中心SQLite，也不从HTTP认可推出Ticket完成或permission。相同指纹不会在真实重开后反复进行已确定的拒绝核销。正常输入的活跃promise和controller相互关联；missing or mismatched completion digest 不再被通过 `duplicate_active` 或快捷branch接受。
- Report/Artifact 的逻辑内容生成稳定的64-hex receipt identity，改变 bytes/state/evidence不得共用。实际 Rust Concierge 的 HTTP 200 已知提交却从客户端隐藏的响应，在等待真实的持久化重试退避 后，按原request body、digest与immutable bytes回放。事前和事后的中心API、owned SQLite request/receipt、Artifact/report/effect/audit数量及其关联都查看；执行器仍恰好一次，文件hash/inode/time不变，central audit chain 為 true。
- 对真正的 pending file operation，stop 会匹配并触发该 entry，而不是只查找无关系的 runner Map。真实 gated write 随后产生所指文件、byte-backed confirmed Effect，但任务结果保持 unknown 和其无confirmed cancel acknowledgement，不冒充已取消或已成功回滚。这证明局部文件停止竞赛，不存在“generic file abort exactly-once”保证。
- 真实 DSH 生命周期额外验证取消 acknowledgement：公开 Agent cancel 确实到达、真实 `turn/end` reason aborted、last report cancel_acknowledged=true，并在 owned centre SQLite 同一 Assignment 上看到非空 `acknowledged_at` 与 `last_report_at`。Host再次启动可以真正resume原Session。`cancel_requested` 与兼容 `cancellation` 均只在同一stop intent下设置，不编造Task完成。Live model继续 NOT RUN (zero-network Stub)。
- 相关当前状态：Node client 22、vendored plugin 55、Vue 44 + typecheck/build；Rust workspace/严格clippy、真实scoped Credential inspect/revoke/unseeded missing、固定SDK model binding、Skill replay和原生Bare flow都分别验证。它们各自有边界，不能覆盖生产模型/provider注册激活、其他host凭证、TLS远程两机、移动锁屏/杀进程或不相关pipeline。1+3 Compose按用户明确方向继续推迟。

严格保存 failed candidates 的原始原因：当首版错误对当前poll整张view做canonical比较时，实际取消使用 lease窗口变化及当前状态投影，停止发生之前就会被拒绝。已依据真实Host纠错，而非把校验删掉或者生成假的"未知effect"报告。还存在两处易判错的量具：第一层计数 spy 外又包等待用的spy会重复点算，Artifact序列化 container hash 不等于目标文件hash；均已单独修正，不把相同工具调用解释为两次工具副作用。

## 启动取消与已注册凭据的恢复

公共和vendored startup均已验证：预检检查已有身份，存在损坏身份不会因少token变成fresh key或重新授权，显式中止不创建额外identity；每阶段已知取消后不继续register/heartbeat/poll。真正注册之后但若已保存token，取消不擦除该事实。两个owned真实Rust中央各接受一个签名可验证节点注册，取消后直接查询该Node仍存在，重启同一Node/Installation并由中心heartbeat变为online；这不等于撤销、unregister或新的Grant。

可选startup AbortSignal贯穿 `LocalNodeRunner.start/create`、Coordinator `createClient`及`runLocalDshPlugin`的显式生命周期参数。普通插件activate不带signal仍保持原有路径，Zodconfig不含AbortSignal，未宣称Cordis全部启动effect 能来自未知API自动停止。catalog等待使用既有5秒超时，在自有约5003ms观测中将超时的expiry状态和后续caller abort区分，取消不启动Coordinator。 underlying SDK pending operation 不称已被取消或回滚。

完整场景入口[`tests/runner/startup-cancellation.mjs`](../runner/startup-cancellation.mjs)，覆盖各自owned NodeIdentity/NodeState、分阶段中断、空/错身份、注册过程取消、token已持久取消、工厂布点、固定deadline与同Node重连。不改变正在执行的tool effect、SDK会话、中心Schema/Grant/Lease。此前的真实DSH安装/工作/文件效果/cancel确认/resume和全部单元仍分别执行验证，而不是采用启动小探测代替整个生命周期。

## HTTP流式读取与可挂断输入专项

[`tests/runner/http-stream.mjs`](../runner/http-stream.mjs) 与 [`tests/runner/http-socket-stream.mjs`](../runner/http-socket-stream.mjs) 在一主一副的真实 `LoomHttpClient` 上分别执行，不散布于桌面Profile、全局Agent或真实用户凭据。主/vendored helper现已逐字一致，原Node 22/插件55个单测及实际SDK、模型、凭据、文件效应、replay 回归均分别通过。

- 对标准stream 使用 `getReader()` 按实际chunk bytes限额，非依赖`Content-Length`。不追加首个超限chunk，随即取消本次reader；接口不为不支持的fallback shape 承诺提前分配限制。空响应、老arrayBuffer fixture与409结构status分别被验证。
- caller stop 是最终取消原因；reader.read与既有内部AbortController竞争，所以pending Promise 不自行发结果也能在总超时挂断。微任务等待不被读取取消拖成下一轮清理死锁；cleanup cancellation error 不会覆盖原read/abort错误。这不能证明物理远端任务已取消或server Rollback。连续零字节帧还必须允许total timeout被调度。
- 真正`127.0.0.1` 临时HTTP server 分成独立 owned 场景：合法JSON、逐块超限、partial JSON + caller cancel、partial JSON + deadline。数据不包含真实token/prompt。日志显示oversize时还剩16个未发送片段，partial JSON始终无效；不会把普通HTTP响应当成任务终态。各探测等待真实response close，而非仅等到 Assertion 返回true。
- 曾经因为probe每次覆盖全局server引用，最早的listener没有被close，打印PASS而进程不退。改为**启动新server前先await关闭旧实例**，关闭所有自行持续跟踪的 sockets，最后逐一断言`server.listening===false`、sockets为空；现在CLI可自然退出。这是discovery of resource ownership，而不是把普通client limit判读误写成网络类型支持或服务端取消证明。
- 两个NodeFamily构造器各自接收对应的NodeIdentity/NodeState及HTTP实例；主`NodeClient`的instanceof屏障不被绕过。对于测试自创reader、总deadline和错误原因保持各有独立断言，不因为错误显示HTTP200、partial chunk或cancelled而说完整工作成功。构建网络读写没有使用真实远程路由、外网服务、收费provider或任意数据发现。
