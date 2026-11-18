# Isolated real desktop-browser E2E

## 范围与启动

这个测试驱动本项目的 Vue 页面、Rust Concierge 与现有 TypeScript
`LocalNodeRunner`。它不是静态 HTML/curl/快照，不接触当前 DSH GUI、DSH
Desktop Profile/Session 或个人浏览器 profile。普通页面验证不属于 DSH 插件
GUI Review，不能由此延伸为 DSH host plugin 的平台验收。

安装唯一的小型、私有精确版本驱动；不会下载 Playwright 浏览器、全局安装或改变
workspace lockfile：

```sh
npm install --prefix tests/browser --no-package-lock --ignore-scripts \
  --no-audit --no-fund --save-dev --save-exact playwright-core@1.65.1 \
  --registry=https://registry.npmjs.org

node tests/browser/run.mjs
node tests/browser/run.mjs --narrow-viewport --keep-evidence
# 备用而非 DSH GUI：app 自己的、明确随机 localhost Vite 服务
node tests/browser/run.mjs --vite --keep-evidence
```

本机使用已安装 Microsoft Edge `154.0.4258.53`，仅通过 Playwright 标准
`chromium.launchPersistentContext(newTemporaryProfile, options)` 派生独立 headless
浏览器。默认值为本机 executable 路径；最大可 life cycle 默认 175 秒。
可指定 `LOOM_BROWSER_EXECUTABLE`，但仅支持已有 Chromium executable，
不指定 remote profile/远程 endpoint。
不支持时如实失败，不尝试裸运行 DSH electron wrapper 下载随机浏览器。
`--headed` 只在实际 Desktop 使用 headful window。

**不要改为直接 `spawn(Edge executable)` 的自定义 driver。** 那种支线调试曾
触发 Edge 自带 updater 的 LaunchAgents 和公网更新请求（不是 Loom 功能或安装），
已永久弃用。该支线错误在 `loom-browser-evidence-aK3gYa` 的日志留证；此任务未
尝试修复/删除厂商 updater 或用户全局数据，也不把厂商自己 updater 当作 owned
Loom child 来清理。标准 Playwright path 不执行这段支线。

## 真实任务步骤

1. 构建现有 Vue。`scripts/fixtures/rust-server.mjs` 编译并启动独立 Rust。
   测试临时入口只附加真实 CLI 参数 `--web-dir apps/web/dist`。JS asset 200、
   MIME 为 JavaScript、内容不是 HTML、`.loom-app` 真正 mount。
2. `prepareProject` 创建完全 synthetic root。`LocalNodeRunner` 一次性 enrollment
   注册并 heartbeat，创建精确 Binding + explicit read/write Grant。第二次用同一
   code 创建独立身份会被拒绝。无硬编码真实用户 Project、Profile 或 API secret。
3. 浏览器创建 **新** temporary profile 与一个 `about:blank`，无已有 tab。
   只向浏览器传明确 `PATH/HOME/XDG_CONFIG_HOME/TMPDIR`；不导出外部 API/proxy
   secrets。只允许 test 决定的 loopback app/API origins，其他请求 abort + FAIL。
4. 在密码框输入本次 synthetic client token，随后用真实项目、用户 identity DOM
   证明登录；首次未登录的一次 401 记录为未认证初始访问，不当通过。
5. UI 提交读任务，由现有 Node poll 一次并执行。展开真正 Artifact/Report。
6. 查权限页 Grant 操作和 Node scope，UI 再提交写任务、Node 实际写文件。
   断言 Artifact JSON、正文落盘、SHA-256、confirmed Effect（API evidence 是 JSON
   字符串，显式 parse）及 Assignment/Lease/Grant 关系展开。
7. 在已归属的 write Ticket/Assignment 上，通过现有 `node.client.event` 发送一条
   真实 Node-authored `session_link` 过程消息，并经实际 Rust 中心化保存与读取。
   在 Activity 的协作页验证初态折叠、单任务展开→收起→再展开、单独全局
   默认不串值、刷新恢复；每次动作等待精确 Ticket/Global scope 的 PUT 响应。
   SQL、Ticket/Report/Artifact/Effect ID 集合与真实文件 hash 在折叠后不变。
   这里的消息是用于验证展示协议的普通本地 Node记录，**不是**伪造的
   DSH transcript，也不代表完整 Harness 交流均已接入。
8. 新建 write ticket，不轮询之前点真实“取消任务”和确认按钮，必须看到
   “取消意图已记录”。随后 Node 承认取消，并断言 `cancelled`、无 Artifact、
   无目标文件。Center 将 ack 映射为 `true` 或 `1` 均是已有真实表现。
9. `--narrow-viewport` 只改变真实 Chromium viewport 到 390x844，检查无横向
   overflow。不是手机、锁屏、触屏、换网或 accessibility 验收。
10. 桌面还检查实际 Ticket 宽度和非活动 Help 不可见，防止“DOM 有文字但是布局
    已不可用”的错误绿灯。

除初始 Heartbeat 外，读取/写入/取消前各显式 heartbeat + poll：共 4 次 heartbeat、
3 个确定性执行。不存在自动付费模型调用或长期主 loop。

## 截图、日志、进程回收

- `--keep-evidence` 保存完全 synthetic UI 截图和 `result.json`。捕获前 DOM
  不得出现 Token 输入框、配对码或任何测试凭据。不会因要展示而暴露 execution
  hashes；它们可在 DOM 断言后折叠，不需要存成 test secret。
- 新运行使用单独 `loom-browser-evidence-*`，不把 browser profile、私钥、
  Client/Node token、localStorage 或真实用户路径存入 evidence。无 keep flag
  成功时连 evidence 一起清理；失败的脱敏 evidence 会保留用于调试。
- context 由 Playwright 关闭；可选 Vite 新 child 明确 detached，driver 仅通过
  本次记录的 PID/PGID 结束和验证，不按 app/profile 名称扫杀；Rust 用原 fixture
  的 stop 处理。LocalNode 是 driver 内有界函数调用，不抚育 worker 子进程。
- Browser process API 对 persistent context 不总提供 `process()`，不得用这个
  假命题改走/raw executable 的 updater 路线；context 正常关闭playwright 子进程并
  删除 test-owned root 而非全局 State。凭据、临时文件与 cleanup evidence 各自隔离。

## 已发现产品问题与限制

- 之前 Rust web dir 把 JS assets 回退为 `index.html`，导致真实 mount timeout。
  lead 修复 secure webroot/static asset handling；本测试现在回验真实 JS MIME。
- 之前窄屏完整 Node ID 有 466>390 的 overflow，lead 修复 narrow CSS；测试只
  将其视作 viewport 检查，不声称真机。
- 旧截图产生中央 Ticket 82px + 928px Help sibling 的严重桌面异常。进一步发现
  `App.vue` devices 的独立 `<p v-if=…>` 打断后续 `v-else-if` 链，从而 Help 在
  Conversation 也被渲染；owner 修复 Device 的模板分组恢复条件链后已重新验收。
- 没有 live LLM、真实手机、多机恢复、Tauri、DSH 插件完整宿主/session 结论。
  当前 DSH executable 实际尝试时为 `--remote-debugging-port=0: bad option`；
  默认 inner entry 另报 `desktop backend is closed`，故而不是本题中使用的浏览器。
- 任务没有 commit、没有修改 apps/crates/脚本产品文件；对应修复与各自单元测试
  由产品作者所有。目录内工具/测试代码不等价于全局 updater 安全证明。

## 当前实测结果（2026-11-17）

命令：`node tests/browser/run.mjs --narrow-viewport --keep-evidence`。
八个阶段与整体 PASS：production build、独立 Rust/Node/Binding/Grant、native
production DOM、ActiveAuth/read、Grant/Node、实际 write/Artifact/Effect、stop
intent/cancel ack、390x844 viewport。产物：
`/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-M2y45A/result.json`，
同目录有五张真实截图。CSS 修复后桌面 Ticket `1010/1357px`，HelpView 不可见。
原生模块 `/assets/index-nkNJLxNe.js` 是 200 `text/javascript` 非 HTML。
写入 84 bytes，DOM file effect hash 与实际文件一致；confirmed Effect/Lease 展开断言。
初始未登录一次预期 401 debug log 仍在，后续 Authenticated project/DOM 成功；
没有失败资源 URL 或外部浏览器 URL。临时 browser context 由 Playwright 关闭、
Rust stop 和 Test root（含 profile 和 Node secret state）删除。
这不是个人进程表/系统全局 updater 证明，不会借此清理用户全局内容。

未执行 `--vite` GUI 备用分支、--headed 窗口、live LLM、移动端真实设备、锁屏/网络切换、
Accessibility、多机或 Tauri。中间的 raw Edge child helper 线属于失败且被弃用，
它触发的 vendor updater/外部 behavior 不归属这次 canonical E2E PASS，也不被此
PASS 假设“没有全局影响”或“用户全 profile 原样得到审计”。
