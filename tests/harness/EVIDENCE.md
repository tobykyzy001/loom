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
