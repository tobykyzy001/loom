# Main TicketComposer real lifecycle fixture

此驱动的唯一范围是把**生产 Vue 的普通主 TicketComposer objective** 与现有隔离 DSH Ticket/Agent/Tool/Artifact/取消/恢复链连起来做一次连续验证。它使用已有 `environment.mjs` 和 `FixtureHost` 的真实 rc.5 stdio 安装与 SDK，而不是把旧 `real-lifecycle.mjs` 或 `source-intent.mjs` 的 PASS 改写成 Composer PASS。

**变更范围**只有 `composer-lifecycle.mjs` 与本文件；不改生产 UI/插件/Stub、不改中心 schema/任务类型/Grant 解释，也不使用 desktop Profile、真实用户目录、Credential Store 或 Live Provider。

## 运行

在仓库根目录，先构建生产 Vue；然后从已经核验过 `DSH_NODE_EXECUTABLE` / `DSH_INSTALL_DIR` 的运行环境执行：

```sh
pnpm --dir apps/web build
LOOM_TEST_OUTPUT=/tmp/loom-composer-lifecycle-proof.json \
LOOM_TEST_KEEP_EVIDENCE=true \
node tests/harness/composer-lifecycle.mjs
```

脚本检查 rc.5 的实际 manifest 和 Electron/Node/Playwright/Edge 版本。默认只要求根目录已有生产 `apps/web/dist`；这是另一条真实生产 Vue/Rust 同源 Edge 链，不是 `tests/browser/run.mjs` 的替换或基线全回归。无需设置 enrollment/session 的额外外部配置：一次性 registration code 仅由 admin API 自得并置于**owned** initial env；resume 所需的真实 Session ID 只能来自本票的实际 assignment mapping，后续自动设置到 `LOOM_FIXTURE_AGENT_SESSION_ID` 的**子进程环境**，随后实际 `session/resume`。

一个 `mkdtemp('/tmp/loom-dsh-*')` fixture 连续持有独立 HOME/DSH_HOME/Profile/Project/Node state/center DB/browser profile。安装的是现场 bundle 副本；逐文件 SHA 将现场插件源与安装副本核对，不把旧 package/cache 作为证据。可换 `LOOM_TEST_ROOT`/`LOOM_BROWSER_EXECUTABLE`，但必须是专用 fixture 而不是用户 profile。`LOOM_TEST_KEEP_EVIDENCE=true` 时有 pinned 路径的 JSON 与随机目录下的截图/私有日志；脚本关闭 real Edge、DSH Host、Rust center，实际验证退出，不保留 real Desktop Profile。

## 连续动作与外部硬证据

1. 使用 **main TicketComposer**，不调用 `/source-events` 或产生 Source Spec。管理员外置通过 API 的建立 immutable ProjectBinding 与显式 Grant，ticket 内文字不创造这些节点/Grant。
   - `LOOM_FIXTURE_READ composer literal input.txt ...`：检查浏览器发包的 literal objective/path/kind/Project 对应关系，真实 DSH SDK `loom_fixture_inspect` 一次 ToolCall/Result、succeeded、公开 read proof 的实际 SHA/size/call/session；源文件 byte 与 artifact proof 核对但 source 原文/助手转录不能出现在公共报告、proof、UI或 JSON 输出。中心 Artifact storage 字节与文本下载也一致。
   - `LOOM_FIXTURE_TRAVERSAL ...`：实际 `loom_fixture_write` ToolResult `isError:true`，Summary 含真实工具错误、Ticket failed、无 Artifact/Effect，项目外 `escape.html` 明确不存在，而不是检查提示文案。
   - `LOOM_FIXTURE_CANCEL ...`：先看见真实 Provider hold，再从 UI cancel 及父确认。HTTP 200 中 **cancel_requested** 与持久 cancel intent 分开验证；实际 adapter 记录 `sent-to-running-agent`、原 Session `turn/end(aborted,user)`、最终 cancelled Report 与 `cancel_acknowledged`，而 cancel 票零 Artifact/Effect。396px 只是桌面 Edge viewport，未声称手机、移动 OS 或后台恢复。
2. 将三票完整 detail、Grant、audit-valid、SQL schema/关系、Provider/工具/Session map 计数保存在内存，真实关停 Host、Edge 和 center。同一 DB、token、port 与 Host root 再启；显式 resume 环境选择原读取 Session 后调用真实 `session/resume({sessionId})`，在 UI 重载之前先证明未多 model/tool 请求。重开 old selected 票，立即展开原 Artifact，核对原 read evidence/text 路径、原始 SHA/size、完整下载 bytes、完整 protected snapshot，且该 reload **0 写操作、0 新 ticket/Grant/tool/provider/execution**。普通工作的 admission timestamp与恰一`assignment.acknowledged`证据按 Assignment 关联；direct stop 的 legacy 双历史 current decision分开，不把第二次停止与普通准入重放混为一类。
3. 再用普通 Composer 输入 `LOOM_FIXTURE_RESUME ...` 形成一张新票，要求新 Assignment 仍绑定第一读取票的真实 Session；最后 stub request 的真实 reconstructed history 含原 `loom_fixture_inspect`、call_count 增加，仅多一个预期 Stub 调用，不重复读，运行结果包含其保留 inspect 历史的证据。Session 不由 SQL 插入或伪造 succession。
4. 只读回访原票，有 4 tickets / 4 assignments / 4 reports / 2 artifacts / 0 effects / 1 Grant；Source 只有零预期关系。同时每票 host session link 通过持久 requests receipt 绑定 session，与 assignment、report、artifact、node/Installation/worker/grant 对照。检查 quick_check/schema16 与 chain、此前和此刻完整 detail/Grant 关系，以及真实文件 byte 不变。

所有 waits 都有上限，整 driver 也有160秒主 watchdog（最新真实复跑52秒）；失败仍尽力 bounded cleanup 并写无凭据的 diagnostic。其 secret/source marker 检查拒绝输出私有字串，截图前若 token 输入框存在就不截图。

## 边界

仅一个真实隔离 rc.5 + Rust Concierge + production Vue + standalone Edge + 零网络确定性 Stub 的连续本机垂直验证。Grant authorization 来源明确在管理员 setup 而不是对话自动授权；这些 marker 是既有 compose objective fixture，绝非 NLP 概括或新 Source 引擎。

无真实 LLM/Live token、成本或模型质量论证；无全量 DSH transcript DLP/通用 filesystem/通用 Tool 支持论证；无完整 M0 或其 rest baseline、移动设备、多 Host/物理第二机、TLS、OS CredentialStore、生产 desktop profile 安装或 global exactly-once 结论。此测试没有验证 Source fixed phrase 能力；那个能力与 `real-lifecycle`、确定性 baseline 各有其他真实入口，不能相互冒称。源 marker 检查只拒绝这些公开路径出现当前合成私有原文字串，不是OCR/通用混洗报告审计，不保证 assistant 文本不含相似普通词。

## 本次 driver PASS 证据（2026-11-22）

```text
node --check tests/harness/composer-lifecycle.mjs
LOOM_TEST_OUTPUT=/tmp/loom-composer-lifecycle-proof.json \
LOOM_TEST_KEEP_EVIDENCE=true \
node tests/harness/composer-lifecycle.mjs

stage checks: 7 PASS
exit: 0
```

实际结果为 [proof JSON](/tmp/loom-composer-lifecycle-proof.json)，保留证据的 [fixture root](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-dsh-BeNUcW)（复跑时应取各自的实际随机路径）；同目录 `01-read-public-proof.png` 至 `07-final-public-history.png` 与 `private/host-lifecycle.jsonl` 列出实际 bounded exit（两个 Host 都是 `code:0, signal:null`）。快速 tool 错误或取消时 transitional DOM 状态变化由中央真实状态/Report 证明，而不是模拟不消失的文字。主调度最终以 `LOOM_TEST_OUTPUT=/tmp/loom-composer-lifecycle-reviewed.json` 完整复跑，也获得 7 PASS/exit0，并进一步严格核对 Assignment/SQL relations、每份 Admission audit、三笔票面创建和原 Artifact 即读，记录测试真实时间戳与停止历史而非将两类秒戳误当同一事实。

早期 driver 语法、ASAR 读法、非首次存在 mapping、UI 切票/状态 wait 和 SQL 量具失败均保留旧 FAIL JSON，作为调试记录，不用于当完成证据。
