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

- `node tests/harness/real-lifecycle.mjs`：隔离profile中真实安装、注册、Agent工具任务、取消与恢复；具体按脚本最后报告判断。
- `node tests/harness/real-delegation.mjs`：同一隔离 DSH Host 的实际父/子 Session、current Assignment Source 验证、原父产物到新 scoped Tool/File/Artifact 与实际父子关系、错误来源拒绝、重开无重复效果。详见 [harness/DELEGATION.md](harness/DELEGATION.md)。默认生产`unsupported`，此例零网络 Stub，不代表自然语言模型质量、物理第二机或任意 Harness。
- `node tests/direct/loopback-handoff.mjs`：两台同机逻辑 Node之间的真实direct Artifact取源/签名/Grant与nonce不可复用。比较字节hash和父节点谱系，加入取消/stale grant/offline等负例，实测14个断言。见[direct/README.md](direct/README.md)。是同机回环的基础传输证明，不是物理第二机、任意路由、公网/TLS或大文件对账保证。
- `node scripts/document-pipeline.mjs`：受限原授权两阶段文件转换、`/run`、幂等和中心恢复；不是 M3 通用长图/大规模 Artifact 转运。
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
| 节点失联 | Ticket 持久保留；离线、Worker 失联与失败分别呈现 |
| Lease 过期 | 迟到旧 Worker Report 不被接受为当前权威结果 |
| 重复事件 | 同一 Report / Effect 重放不会重复外部副作用 |
| 中心 / Node 重启 | 可从持久证据恢复；SessionRef / ArtifactRef 保持关联 |
| Unknown Outcome | 不可证明的成功进入对账或人工处理，不无条件重跑 |
| 权限负例 | 越权路径、伪造 Node、错误 Grant digest、过期 Token 和跨 Profile 读取被拒绝并记录 |
| 会话可见性 | 默认折叠、单任务展开不改变数据；消息可见性与 Artifact 访问权限各自成立 |

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
