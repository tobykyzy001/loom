# DSH isolated harness evidence

此目录是受控的真实 DSH Host runner，不使用 agent Mock Host、私有 Session Event 或 Live LLM，也不把 DSH plugin 安装到运行中的 Desktop Profile。

## 已执行的真实场景

Authoritative 命令（在 Loom 仓库根目录、继承经过核验的 Desktop runtime）：

```sh
LOOM_TEST_OUTPUT=/tmp/loom-dsh-lifecycle-result.json node scripts/dsh-fixture-runner/run.mjs
```

**实际退出码：0**。`run.mjs` 对应安装 **DSH `@deepseek-ai/dsh@0.2.2-rc.3`**。私有结果位于 `/tmp/loom-dsh-lifecycle-result.json`，本次 owned root 为 `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-dsh-MppzxV`。Host 两次生命周期均以 `code: 0, signal: null` 结束（`private/host-lifecycle.jsonl`）。

- 安装：在 fixture-owned `DSH_HOME` 内、Profile `loom-local-fixture` 中安装 `@loom/dsh-loom` 和测试 Provider，目录权限 0700。没有调用 `plugin_manager`，没有访问或改变既有 desktop Profile。
- 注册：实际 `ctx.agents` + Cordis inject 启动。Node id `7ff071afa4eac058d5530a7d0b41b6452d7638bc43abcfed50b68ad4440d81de`，default Worker，`harness_kind: dsh-host`，Host 声明的 synthetic project root 通过 heartbeat inventory 参与中心 ProjectBinding 校验。
- 真实任务：Ticket `tkt_07436b5065ae4f4097faf9bb2d8e6592`，Assignment `asg_160fafd425354be0bb835ecd8b58aa65`，Session `f376a11b-331d-4a63-a8b0-1b9d2c6a5193`。真实 LlmAdapter 产生 `loom_fixture_inspect` tool-call，公开 tool registry 执行后形成 committed assistant/message，再由不可变 Artifact `31366500-2355-4787-ae96-e7e3b7a33c43` 交付 SHA 校验的文本证据；不是指令性文件 helper 代替 Agent。
- 取消：另一个独立 Ticket `tkt_834444ea87b04ed09ff1cf4fc298824e` / Session `7b8ca855-5ff3-4c1f-9180-37a715d1705a`。正在运行的 Agent 通过公开 `agent.cancel({kind:'user'})` 结束为 `turn/end.reason.kind === 'aborted'`；中心 Report 为 cancelled，且 `cancel_acknowledged` 为持久化的真值。
- 恢复：实际关闭 Host 后以相同 fixture `DSH_HOME` 启动，执行 `session/resume`，随后发送新的 Ticket。实际 Stub 收到的 resumed request 包含此前的 tool-call，且新 followup 成功。识别失败的根因曾经正是缺少 `UserMessage.id`，因此当前公开 followup 消息包含显式 `id`、role、source、content；没有改写历史来取得恢复 PASS。
- 机读结果：`overall: PASS`，install/register/task/cancellation/resume 全为 PASS；`live_llm: NOT RUN (zero network Stub)`。

本 runner 也包含这类**非可通过预生成 transcript 证明**的硬断言：center 接受 Artifact 的 UUID/lineage、导出本地 state 文件 mode 0600、DSH 构建的 SessionRef map 可跨进程保留、真实 ToolEvent、真结束原因以及多个 Assignment 各自 Session correlation。

## 公开 API 与隔离边界

- CLI：`dsh --help`、`dsh --profile loom-local-fixture --from-default-profile sdk-minimal --dump-config`（仅首次 owned 初始化）、`dsh plugin --profile loom-local-fixture add file:<fixture> --ignore-scripts --store-dir <fixture>`、普通 `--profile ... --patch <fixture-patch>` 启动与配置 dump。
- Host：`export const inject = ['agents','sessionPersistence']`；`ctx.llm.registerAdapter([provider], LlmAdapter)`；`ctx.tools.register({...})`；`ctx.agents.create/get/resume`；`agent.followup({id,role:'user',content,source:{kind:'loom'}})`；`agent.cancel({kind:'user'})`；公开 `session/event` 的 `assistant/message` 和 `turn/end`。
- 观察/控制：公开 SDK `initialize`, `session/prompt`, `session/wait`, `session/resume`, `shutdown`。由于 session/event 推送结构是实测字段 `data.message.content`，Artifact 从该真实结构提取，而非从预设 Mock 结果填表。
- Profile：只使用专有的 `loom-local-fixture`。创建后绝不再使用替换式的 `--from-default-profile` 启动或 dump（官方机制会替换整个 custom Profile，包括已安装 bundles）。
- 环境：独立 `HOME`、`DSH_AGENTS_HOME`、loose `ENV`（不继承 API credentials/proxy），零出网 Provider；persistent shell 禁用，文件权限 workspace-write 受合成根约束。Case 不需要 system Credential Store 或真实密钥。
- 依赖：本安装未解析到 `dsh-llm-mock-server`/`dsh-llm-replay`/Agent-loop testkit，因此直接使用实际 `LlmAdapter` 接口合成 zero-network Provider。新 Profile 的 Schemastery 依赖由同版本 shipped package 的 test-owned forwarding shim 提供（不复制其实现，不下载与生产无关依赖）。安装使用 shallow test copies，避免通过链接递归扫描工作区 scope。打入运行包的来源与 startup 都从实际 `package.json`/manifest 验证，不用 dump 名字替代已激活事实。

## 仍未由此证明的范围

这不是 M0、产品级或多平台整体验收：没有移动设备、GUI、真实 LLM、已部署/OS Credential Store、平台签名、网络隔离稳定性、完整编程 Agent 验证、最终文件写入 Effect、跨 Profile/Worker 越权和旧 Lease 负例，亦没有多 Harness 测试。

此场景受控工具是 read-only，没有声称 `edit_file` 已经发生实际写盘效果；先到的 cancel/completion race 的案例也未扩展为通用 exactly-once 承诺。中心采用 at-least-once 与 reconciliation，Runner 对同 Assignment 的普通重复 poll 去重，取消只通过独有的停止分支进入真实 Agent，最终从单一原 Assignment 的 outbox chain 上报。

其他 Rust/应用改动由 concurrent owner 完成，本目录的 runner 的默认来源仍是项目的真实 `scripts/fixtures/rust-server.mjs`，不替换为 SyntheticCoordinator。以往失败 probe 不作为本次 PASS 证据；不可复现的环境 blocker 必须单独报告，不能换为 mock 假装执行过。

Enrollment code 仅 child environment 传输；重启没有新 code，使用真正的本地持久 Node credentials。不合规 Patch 没有 literal Token，输出不含 node token/private-key/raw session transcript。原始日记仅在 fixture private/state 以 0600 留存，绝不包含用户私有目录信息；`private/host-lifecycle.jsonl` 只留 argv 名义、协议初始化和实际退出状态。
