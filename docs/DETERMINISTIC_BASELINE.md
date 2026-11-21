# Deterministic single-host baseline

本入口只复跑首版本机、确定性验证；不使用 `SyntheticCoordinator` 当作任务权威，不安装或修改真实 DSH Profile。它验证一台 macOS 上真实 Rust Concierge、TypeScript Local Node、独立 Rust Bare 进程与已选单元测试。它不是 Compose 1+3、第二物理 Host、Live LLM、移动设备、Linux/Windows、生产安装器或 DSH 真实生命周期验收。

## 精确命令

在仓库根目录执行：

```sh
node scripts/verify-baseline.mjs
```

等价显式选择：`--full`。开发定位可分别执行：

```sh
node scripts/verify-baseline.mjs --integration-only
node scripts/verify-baseline.mjs --suites-only
```

scripts 的 runner catalog 内以下条目完全展开执行，不经 shell 拼接：

| Suite | 实际命令 | 覆盖与边界 |
| --- | --- | --- |
| `rust-completed-replay` | `cargo test -p loom-node --test completed_replay --locked` | 独立确定性 Native replay/准入/取消/失败围栏目标。 |
| `rust-completed-security` | `cargo test -p loom-node --test security --locked` | 独立确定性 Native 文件/授权安全目标，不是其它 OS 验收。 |
| `rust-workspace` | `cargo test --workspace --locked` | 当前 dirty 工作树的全 Rust 单元/集成测试；`inventory_probe_actual_macos_once` 的 opt-in hardware probe 保持 ignored/NOT RUN。 |
| `rust-ts-bare` | `node scripts/bare-integration.mjs` | Rust 中心进程 + 独立 Rust Bare CLI；签名注册、文件读/原子写、预执行取消、重开。 |
| `ts-node-client` | `pnpm --dir packages/node-client test` | 共享 Node 单测，不模拟真实 DSH。 |
| `dsh-loom-source-tests` | `pnpm --dir plugins/dsh-loom test` | 插件源和 mock-adapter 单测；不启动、安装、激活或修改 DSH Profile。 |
| `web-unit` | `pnpm --dir apps/web test` | Vitest 单测；不是生产 build、Edge 浏览器或真实手机。 |

各自命令按 catalog 顺序串行，5 分钟上限；完整子进程 stdout/stderr 各保存在报告目录 `logs/<suite>.stdout.log` 与 `.stderr.log`。stdout 仅输出关键 PASS/FAIL、真实退出码和报告位置；失败输出也保存在文件，不把一次 HTTP 200 或历史 result.json 当作成功。`--integration-only` 的各 suite 明确为 `NOT_RUN/exit_code:null`；`--suites-only` 不假装集成已跑。

## 真实 HTTP 闭环

`runRealDeterministicFlow` 在报告目录下 `scenario/` 逐次创建真实临时 SQLite 和独立 Node state，经由真实认证 HTTP 完成：

1. Rust health、Ed25519/单次 Enrollment、注册/heartbeat；新身份重放已消费 Code 必须 **403 `enrollment_denied`**。
2. Client token 不得用于 Node transport，错误 Project root 拒绝绑定；正确 Binding 与显式 Grant 后才允许工作。
3. 实际文件读取生成数据依赖的 Artifact，原子文件编辑写入真实临时文件；中心 Report、Effect、Artifact 内容必须匹配。
4. 缺文件真实执行为 failed，不是 succeeded；取消在 executor 启动前完成 cancel_acknowledged，文件不存在。
5. 原 Report/Artifact 重放返回 duplicate，保持原 request ID，不增加 Report/Artifact/Effect；改请求体反例和 Artifact UUID 改 bytes 冲突均拒绝。
6. 用一个独立 Grant 的旧 Assignment 进行真实撤权：Grant v1→v2 已持久，显式同 Grant 的新票被 403 `grant_scope` 拒绝；旧 Artifact/Report 保留 outbox deferred 且中心仍 0 Report/Artifact/Effect，文件不创建。这里不将已创建 Ticket 的 `reconciling` 改写为全局失败/成功。
7. 本地 ProjectId root mapping 和 executor/Grant 不一致负例无执行；Node token/identity 重开后保持，Rust 同一 DB/loopback URL 重开，历史快照、audit chain 与 outbox 匹配。

`/scenario` 内含本机测试 SQLite、Node identity 和原始短生命周期测试凭据，仅用于当前隔离 fixture。顶层 `result.json`、`summary.md`、`logs/*` 与抽取的 `observed-read-artifact.json` 只含白名单断言、错误摘录/日志、无 Token/Enrollment/private key 的机读证据；它们不复制身份私钥、准入凭据或中心数据库到发布目录。Artifact 只复制真实读取生成的公开文本摘要。

## 报告与复跑

默认唯一系统临时目录：`$TMPDIR/loom-baseline-verification-*`。需要仓库自有证据目录时，使用**新的**空隔离目录（不要指向真实 DSH Profile/用户数据目录），例如：

```sh
mkdir -p tmp
out="$(mktemp -d "$(pwd)/tmp/loom-deterministic-baseline-XXXXXX")"
LOOM_VERIFY_OUTPUT_DIR="$out" node scripts/verify-baseline.mjs
```

`LOOM_VERIFY_OUTPUT_DIR` 已有内容（特别是 `.baseline-owned` 或旧 logs）会被拒绝，不复用/改写历史成功报告。退出码为 0 只在实际选中的 scenario 和 suite 全 PASS 时产生；失败为 1。`--help` 退出 0，不代表基线 PASS。报告 schema 固定为 `loom.deterministic-baseline.v2`：

```text
schema / mode / overall / started_at / finished_at
repository.commit / repository.dirty_worktree
environment.platform / arch / node / cargo / pnpm
scenarios[].status / exit_code / checks[].id,kind,status,duration_ms,evidence
suites[].command / exit_code / signal / duration_ms / status / artifacts
synthetic_coordinator.status = NOT_RUN
artifacts[].path / sha256
not_run.* = reason
```

Rust tests 的 opt-in 忽略用例也在 JSON suite scope 里明示，不计当次 PASS。fixture 自身由真实 Rust `startRustConcierge` 创建 ephemeral loopback 和合成 short-lived client Token；runner 从环境中去除 `LOOM_BASE_URL`、`LOOM_CLIENT_TOKEN`、`LOOM_SERVER_CMD`、`LOOM_TARGET_BINARY`、`DSH_HOME`、可选硬件/native fixture 开关，避免将既有中心/Profile/生产路径误纳入本轮。

## 本机实测（2026-11-22，Asia/Shanghai）

旧入口曾将 SyntheticCoordinator 与真实中心的历史行为混合，并把预取消应保留的第四项本地事实误判为失败。新入口只用真实 Rust 权威，取消、撤权、重放、错误原因和重开均检查外部事实。多智能体协作期间独立发现过失败场景、编译错误、错误 UUID 和量具时序；这些中途结果不算 PASS，最终以主调度复跑的退出码为准。

当前权威命令 `node scripts/verify-baseline.mjs` 在 macOS arm64 实际退出 **0**：12 个真实场景全部 PASS，七个套件全部退出 **0**（包含 Rust workspace、本地 Bare、Node、插件源测试与 Web 单测）。`--integration-only` 的实际运行亦退出 **0**，其他未选suite明确 NOT_RUN。证据：

- [全量结果](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-baseline-verification-ht6dSh/result.json)
- [全量摘要](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-baseline-verification-ht6dSh/summary.md)
- [场景结果](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-baseline-verification-hHUkou/result.json)

报告封存当时的 HEAD 与 dirty_worktree 标记；该标记不代表已提交或所有增量均完成。直接 Artifact 交接、真实 DSH 生命周期与生产聊天链是各自独立入口，不通过此处 PASS 递补。

## 未验证项目

- **真实 DSH Host、取消/Session 恢复与 Profile 生命周期**：本脚本未安装或运行 DSH；只有前述源/mock 单测。
- **Live LLM 质量/调用、Provider、真实凭据、付费 Token**：零网络 Model、零 Token 支出，不伪造真实模型通过。
- **Compose 1+3、第二个物理 Host、跨机 TLS/direct relay、公网部署**。
- **移动真机/PWA**：锁屏、杀进程、网络切换、iOS/Android。
- **Linux/Windows Host 和 signed installer/OS Credential Store**：仅在当前 macOS arm64 获得证据。
- **真实浏览器 UI 与 production Web build**：当前明确为 Vitest，不含实际 Edge、点选或 build。
- **direct feature 独立专项与全局 exactly-once**：本 runner 不是其它 agent 开发中的 direct 分支决策器；未知副作用仍须局部对账，不声称全系统恰好一次。

PASS 只描述本次明确命令和选中的单机确定性证据；未运行项四时保持 `NOT_RUN`，不会由同进程 fixture、历史报告或在另一机器上的既有 proof 补写。
