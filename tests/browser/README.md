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
7. **先验证浏览器↔Concierge断网/恢复，再继续偏好测试。** 前一步的原写Ticket
   已实际完成并持有真实Assignment/Artifact/Effect/file SHA。用真实Edge的
   `browserContext.setOffline(true)`隔离**这个浏览器**，不停止Node或中心，点顶栏
   “重新读取工作空间”实际触发读取；必须由`data-testid=client-read-stale`提示
   **原先读取的快照不是最新**，并说明客户端断连不等同于Worker离线/任务停止。
   原错误分类为`network_error`，**不是**401凭据失效，top pill显示`未连接`。
   表达式“有`connected`即已经取回快照”不能掩盖内嵌偏好的局部resolve：
   `loadTicket` 内层组合读取对真实status0传播网络失败；直接偏好读仍按原
   resolve和本scope错误处理，避免新增未处理promise或将`has_override`造出。
   恢复Online**仅**表示网络hint；警示**不会**因`navigator.onLine`自动撤销。
   用户实际点“重新读取最新状态”后，必须等真实ticket GET 200、原ID/状态读出，
   状态警示才可隐藏。完成恢复时逐项比较原Report/Artifact/Effect/Assignment、
   原Grant ID与digest（原Grant仍有效）、原始文件SHA，并验证audit chain。
   这整个断网/恢复sequence中，浏览器POST/PUT/PATCH/DELETE为空。
   这里没有另开模型调用、创建任务或停止任务，不能将其当作真手机或物理设备验收。
   它**只证明已打开desktop工作区的客户端网络恢复**，不证明实际OS锁屏、
   杀进程、WiFi/蜂窝切换、Web离线存储或另一个物理Host恢复。
8. 在已归属的 write Ticket/Assignment 上，通过现有 `node.client.event` 发送一条
   真实 Node-authored `session_link` 过程消息，并经实际 Rust 中心化保存与读取。
   在 Activity 的协作页验证初态折叠、单任务展开→收起→再展开、单独全局
   默认不串值、刷新恢复；每次动作等待精确 Ticket/Global scope 的 PUT 响应。
   SQL、Ticket/Report/Artifact/Effect ID 集合与真实文件 hash 在折叠后不变。
   这里的消息是用于验证展示协议的普通本地 Node记录，**不是**伪造的
   DSH transcript，也不代表完整 Harness 交流均已接入。

   **同段还实际验收了sender filtering，而不止sender_filter:null字段。**
   现在另外通过同一个Node身份发一条具有独立request/session ID及`client`
   display label的受控Node-authored进程事件，不另造用户/Agent/Host/Grant。
   用户选择worker后只见原记录。服务端通过精确ticket PUT把sender改为`client`，
   然后在**不换Ticket ID也不整页reload**的activity导航中，读取正在返回的真实
   偏好；下拉框必须出现已验证的三个选项并停在新`client`值，只见对应label
   的另一条记录，旧worker不得残留。再选worker只见原文，选“全部发送者”则
   wire明确为`sender_filter:null`，两条均恢复，原SessionID/message identity不变。
   因此这里的`client`仅是筛选标签演示，**不是开启新主体/第二物理用户**。
   原生验证涵盖ticket内`sender_filter:worker/null`的已知记录：共7次ticket PUT
   （四次expanded控制加三次sender选择）及两次独立global PUT，SQL里两条
   collaboration records仍在，Report/Artifact/Effect/真实文件hash与Grant no变化。
   新watcher会因当前Ticket的accepted sender偏好同步，同票读取不再卡旧值。
   SQL guard通过`parse_sender_filter`拒绝number/object/空白/超160 UTF-8字节、
   控制字符或非空global sender，不能把非文本吞成一个All，合法global只有展开默认。
   `activity` notice不计入sender-filter的session_link子集，总计数另行说明。
   原`assertMessageCount`也改为聚合读取，见到两个不同sender时不再错误使用单条innerText。
   每次仍先精确等待Ticket详情及合作记录就绪，不把loading中的空select误判为同步生效。
9. **验证Artifact的owner/content/path/text完整性。** 仍以真实write产生的原Ticket/Assignment/Artifact为锚。正常GET必须核对原生`artifact.id`、owner、origin Node、assignment、actual bytes SHA、固定`{id}.artifact`与真实byte size，并返回`encoding:'utf8'`、`truncated:false`；换成另一真实Ticket要403 `artifact_scope`。
   只在owned Rust runtime做**及恢复原值的故障注入**：写坏byte要409 `artifact_integrity`，随后把持久name临时变成`../outside-owned-{uuid}.txt`。一个限定的owner-runtime兄弟目录文件放**同样正确的原始bytes**，所以旧简单join确实能够读到内容；现在必须为409 `artifact_location`，不得输出该body。恢复SQL filename和原始bytes后再取健康200。
   用现有Node token和**同一个已授权的Assignment/lease_epoch**真实上传一份3 bytes `[ff,fe,00]`，UUID/base64/sha/size与真实存储都核对，不是伪造一次意外或新Agent/Task。读取这份bytes需409 `artifact_encoding`，不会沿用旧`from_utf8_lossy`打印替换字符。它不是一个合格binary transport承诺，也不是生产者accomplish状态被改写；缺bytes另有`artifact_storage_unavailable`，metadata/nil/hash问题均不报panic。
   刷新Ticket后，卡片在缺type时也能以真实name明确选择`bounded-non-utf8.bin`；实际对应viewer明确报错且不展示`.artifact-content`，随后选回原healthy card即能看到原文中的`target_hash`。前端由当前verified snapshot限制只读请求的id/tkt/node/assignment/hash/size；切换另一ticket后过期response不会落到新票缓存。原始Report/Assignment/Effect和Grant ID/digest不变，原Report只有一份。
   新增byte-backed附件属于同一个原Assignment，属实新增**一份Artifact**而非一次执行。后续撤权case因此明确校验原工单恰有**2个**immutable Artifact，新增附件的ID/assignment/hash/size，且原Report及confirmed Effect只有一份，**不是**随意改写全局聚合数或容许未知执行。
10. 新建 write ticket，不轮询之前点真实“取消任务”和确认按钮，必须看到
   “取消意图已记录”。随后 Node 承认取消，并断言 `cancelled`、无 Artifact、
   无目标文件。Center 将 ack 映射为 `true` 或 `1` 均是已有真实表现。
11. 浏览器 UI 再创建一个**尚未领取**的 write Ticket/Assignment，先不在 Node 上
   poll。进入权限页，选择目标 Grant，真正点「确认撤销授权」，等待该精确 Grant
   的200回执、版本递增、`revoked_at` 与新资源列表。Ticket虽在此时已转为
   `reconciling`，但 `cancel_requested=false`，尚未acknowledged，原
   Assignment/Lease epoch/digest 保留，未产生 Report/Artifact/Effect。
   针对同一已注册 Node，以不透改响应的包装观察两次真实 poll，都得到
   `assignment:null`。临时 fail-on-call executor与Node outbox/history证明实现
   未执行，目标文件不存在，旧Artifact/Effect不变；随后用合法字段显式复用
   旧Grant实际得到403 `grant_scope`，没有新增 Ticket。再运行现有
   `/audit/verify`，保存完整审计链；这里的 Grant.revoked 属全局审计而非该
   Ticket的取消回执。此阶段不是正在执行的Agent撤权取消或多Grant清场。
   同一未知状态在 UI 中给的是真正禁用的「先处理对账」而非可确认重试，force-click
   不产生确认框或 `/retry` 请求；直接调用该 URL 仍为400，原Assignment/Attempt
   和零Effects不变。保存的凭证明确包含这三项，而不是在汇总赋值时覆盖。
   恢复时回到对话页，并显式选定最初被取消的另一张Ticket，完成原401/
   认证恢复路径，避免把“当前最新 的reconciling”当成先前的取消。
12. 对已明确 failed 的读任务，先打开重试确认框，再使**同一Grant**真正失效，之后才确认。
    这是同一Project/Node/Binding上的独立测试授权，不是借用/复活先前被撤票
    的Grant。实际结果为 `/tickets/{id}/retry` 返回400 `Grant revoked`，模态
    中展示真实错误、允许“返回检查”；它仍不表示获得新Grant。原失败状态、
    attempt=1、Assignment/lease epoch、原始digest/Report和零新Artifact/Effect
    不变，Node之后也没有执行，outbox为空。最终前端Permission卡显示
    已撤销、cancel_requested仍false、完整历史ID集合不变且仅多本失读任务。
    再核对 `/audit/verify`。
13. 原 client token确实失效时，不会让固有缓存冒充新读取。owned SQLite只改变本测试中client token hash；旧token遇401后原有Task显示为expired snapshot，不能通过发起新任务绕过认证。错误candidate未经protected-read不得覆盖已验证token。之后只有真实当前replacement凭据真正成功重读才保存，最终再选定**同一张已实际取消**的原Ticket，读取真实ack，不把最新的reconciling记录误当原取消；不创建新Artifact/Effect。401与普通的client network outage层不混同。

### 额外的显示/几何检查（不并入主阶段编号）
- `--narrow-viewport` 只改变真实 Chromium viewport 到 390x844，检查无横向 overflow。不是手机、锁屏、触屏、换网或 accessibility 验收。
- 桌面还检查实际 Ticket 宽度和非活动 Help 不可见，防止“DOM 有文字但是布局已不可用”的错误绿灯。

初始heartbeat之后，普通read/write/cancel、两次revoked-before-poll、一次真实失读和一次确认后撤权idle各有一次显式heartbeat：共 **8次heartbeat、7次有界Node poll**。新 revoked unclaimed Assignment 的 executor调用为 0；失读被拒重试后也没有 worker 最后执行。没有自动付费模型调用或长期loop。
[完整11阶段PASS报告（确认框打开后撤权及其不可用重试证明）](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-OMClbB/result.json)。另附 [打开后撤权的实际模态错误](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-OMClbB/07-late-grant-revocation-in-retry-confirm.png) 与 [权威权限卡已撤销](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-OMClbB/08-revoked-grant-after-confirm-refusal.png)，两图各不相同。

## 当前整体本地验收入口

`node tests/browser/run.mjs --keep-evidence` 仍会构建真正生产Vue并运行独立 Rust 与 Node、独立安装的 Edge、某个当前受控项目的原始读写作业，而不是单独的 read fixture 客户端。当前完整13阶段依次覆盖初始真实read/write、浏览器断网重读、偏好、这里新增的Artifact完整性、正常取消、未领取撤权、确认后撤权不能再重试及真实认证恢复。

见 [13阶段完整报告](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-Kfz5Xu/result.json)。其 `artifact_read_verification` 明确列出原owner/content/sha、跨票403、篡改409、同bytes危险path、真实Node byte-driven attachment及严格UTF-8；`.same_node_valid_byte_upload_preserved`中的UUID与真实3-byte有效上传、assignment对应。原healthy card继续可读，原Report/confirmed Effect与Grant不被读取失败改写。该报告还包含先前网络及偏好回归；配套的Rust109 unit+2 integration、展开workspace clippy、Vue19 files/137 tests、Node24皆已实际运行通过。独立focused review ACCEPT，附真实Node凭据与持久bytes，**不是 seed rows 直接声称Agent执行**。

临时损坏了哪些byte/file和storage_name均会明确恢复原状；outside sibling对照的原始bytes 也仅来自owned fixture固定runtime，不是当前用户其它目录或凭据。保留的7张真实截图仍是原职掌各阶段的截图，**不要**把没专门捕获的新byte错误卡截图说成随报告保存。非UTF-8的精确HTTP code、真实payload和native Vue正文空断言在result.json而不是靠“看截图是否像UTF-8”验证。

最终实际身份与namespace属于**center权威**；浏览器只按当前工单快照校验下载响应，不制造permission、Grant 或 Assignment。当前reader只处理实际UTF-8纯文本，非UTF-8拒绝可保留原byte记录而没有所谓“failed text completion”。通用binary传输、跨Principal授权服务、Windows/TOCTOU或真实手机依然均未验证。

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
