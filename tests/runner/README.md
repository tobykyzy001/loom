# Durable LocalNode admission and replay verification

这些入口分别检验**节点本地的入场围栏、取消、持久完成和外发回执**，不是另一个中心权威，也不是完整 M0、数据库或多机验收。不会读取当前 desktop/DSH Profile、系统 Credential Store、真实用户项目、生产 token 或收费模型。

## 首次注册的一次性交涉及失败恢复

```sh
node tests/runner/registration-atomic.mjs
```

此driver使用真实Rust Concierge、shared `NodeIdentity`的Ed25519密钥与合法客户端心跳、实际HTTP以及本测试拥有的SQLite，检验**首次code、精确identity-bound nonce、Node/token-hash和 `node.registered` audit**在同一`BEGIN IMMEDIATE` Store连接中的成交。它不以生成UUID、token或“有事务”当完成。无效签名和错误/缺失旧token等拒绝必须保持可重试且不可发行新凭据，已撤销Node不能借新code复活。

修订前真实RED显示：错误signature返回400，但合法enrollment已被`used_at`标记，导致正确签名的重试返回403。当前文件先记录该差异；修后bad request的code/challenge都仍unused，同一个code配合新的正确signable challenge才能恢复注册。`node.registered`的audit还通过在服务器**同一持久数据库**里命名创建`reject_node_registration_audit`触发器注入**本例特的 audit write rejection**，随后hard-assert code/challenge/Node/audit全部没有留下。删除这一唯一测试trigger后用相同code恢复到新正确challenge；server-side audit chain仍验证通过。

另覆盖同public-key原token合法rotation：不等同普通重复注册，fresh code也不会被错误额外消费，但原token必须停止接受；bad identity、原始proof without credential、跨Node凭据以及被撤销Node各有真实拒绝。SQL integrity/hash chain/token身份在真实center stop→restart后继续有效，且整个注册测试保持`grants=0,tickets=0`，**不是Product Grant或任务实际执行**。

[当前回归结果](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-registration-atomic-proof-N4xHhw/result.json)记录status、code/challenge usage、Node/audit counts、第二次恢复/rotation/revocation/restart事实与profile cleanup；不包含secret token、私钥、Authorization或原始challenge签名。限制仍是**单进程单写者 + Immediate transaction**，非lost-HTTP reliability、任意并发/全球exact-once、远程TLS、OS凭据库、真手机/多Host或延迟的1+3拓扑。`scripts/bare-integration.mjs`另保留正常signed registration→读写→取消→重开的正向链路。

## 确定性文件与状态场景

```sh
node --test packages/node-client/test/*.test.js
node --test plugins/dsh-loom/test/*.test.js
node tests/runner/durable-fence.mjs
node tests/runner/cancel-active-fence.mjs
node tests/runner/coordinator-admission.mjs
```

- `durable-fence` 对主 TypeScript 与 vendored runner 创建各自的私有 temporary root，实际注册、读取项目并上传 Artifact；随后用真正的 `NodeIdentity.open`、`NodeState.open` 读回文件。重开后的合法重复、旧 epoch、变化的 Grant digest、409 核销隔离和原始有效证据恢复均逐项断言，执行器仍仅调用一次。
- `cancel-active-fence` 覆盖正在运行/已完成的作业，包括伪造 digest、路径、内容、旧 epoch、未知本地 Assignment、取消期间历史分叉和撤销 Grant 后停止已认领的工作。非法停止不会 abort controller、覆盖历史或创建普通 Report；本来已接受的工作仍可停止。实际效果已完成而停止请求才到达时，结果必须保持 unknown/reconcilable，不能冒充从未发生过。
- `coordinator-admission` 使用 **SyntheticCoordinator**（不是 Rust Concierge 或 SDK 证明），验证 LocalFileDispatcher、DshDispatcher 及 CoordinatorLoop 的同一入场边界和重启后不回发的核销记录。它还检查一个 fixed producer 返回的完整 Artifact/unknown-effect 结构已在 `once()` 的完成提交时持久化，再重新打开后不需要第二次 producer 才能上报。该 producer 并不是 DSH Agent/Tool。

这些场景使用临时 owned inputs、真实本地文件读写和受限返回数据。新进程/新 runner 重开同一 Native State 不等于 `kill -9` 发生在 DSH Tool 投入外部效果的精确时刻，也不是一中心三工作者 Compose。

### 同一Node Key的逐Installation heartbeat隔离

```sh
node tests/runner/node-installation-scope.mjs
```

真实在同一Node public key下生成两份不同Installation身份，并取得各自签名注册/token。初始分别发送self-report markers，旧实现先使两行都被first marker覆盖，随后两行又都被second marker覆盖；根因是`UPDATE nodes ... WHERE id`忽略该表的`PRIMARY KEY(id,installation_id)`，而认证已经包含这对身份。现只有`id AND installation_id AND revoked_at IS NULL`恰好命中一行才接受心跳。

driver比较first写入前后的**完整SQL行结构**：first更新为busy及自有marker后，second整行不变；再second写入自己的profile/workers/inventory，first仍保留其marker与state，未串改。另一实例token实际得到401。随后在这个owned表里**手动将first row标记revoked（只是negative fixture，不是宣称有独立撤销API）**，它的身份和符合条件的查询都不能把状态恢复成online，另一仍合法的Installation照常更新。真实center stop/restart还证实SQLite integrity、该other instance的凭证与记录持续存在。

这里只current self-reported观察数据，**不是两个物理Host、DSH profile实质认证、Grant/Assignment变更、全局 exactly-once或新的逐Installation撤销模型**。最终结果[scope proof](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-node-installation-scope-proof-fEdyqy/result.json)只包含counts/status/diff/bool，不含token/私钥/Authorization。Rust workspace **205 passed**及原生`node scripts/bare-integration.mjs`也保留正常注册、文件作用、取消与重开证据；没有改动Model Catalog或任务协议。

## Bare Rust：已完成工作的输入关联与重放保留

```sh
cargo test --locked -p loom-node --test completed_replay -- --test-threads=1
```

这不是TypeScript/DSH测试，而是直接调用原生 `LocalNodeRunner.once()`、实际读取受控project文件，并持久化Artifact/Report/取消完成状态及Node credential root。受控Axum loopback仅提供poll/delivery响应；构造的Grant/binding也经过实际`Assignment::decode`和digest重建，**不是已授权真实Concierge签发恶意变体或接受上传**。

第一次正常读取保留原Artifact及Report pending；随后原实现会仅凭同ID重发旧证据。当前修复要求先重新验证binding、Grant/root、Lease及完整输入，并由`StateStore::start`比对原始logical digest（ID、lease ID/epoch、grant digest、kind、path与content）。变更kind/content并附cancel flag、epoch改变、撤销Grant、非法Lease和缺失digest的负例均拒绝，**原Assignment/completion/outbox/cursor与effect文件数保持，根本不发新的ack/report/artifact或取消报告**。普通resolve后的正确packet只重放原outbox，不额外执行；已经取消的工作不会因新变体或正常replay再次制造cancel ACK/report。

证据从首次真实执行、负例保留，到到期重放时逐一行比对原body、artifact/effect/request IDs。已为这个`completed_replay` **2/2**运行，且已验证移除了自有临时baseline worktree/target；`1d834eb`的临时离 线worktree中同一测试[真实RED](/tmp/loom-native-replay-red.log)。当前[Rust workspace执行](/tmp/loom-native-replay-rust-regression.log)按target汇总为**186通过/0失败/1 opt-in硬件probe忽略**（不把Node/Vue等其它套件混入Rust数量）。另外实际`node scripts/bare-integration.mjs`仍完成真实Concierge签署注册、注册Binding/Grant、原子文件写入、取消及重开；这不是真实中心发出恶意poll、OS crash或任意unknown/running等其它回放的证明，也不推导全局精确一次。

入口文件为 [completed_replay.rs](../../crates/node/tests/completed_replay.rs)。所有生成的身份、目录及临时端口专属测试，没有使用现有DSH profile。



`maintenance::retry` 不再让 pending/running/cancelled/succeeded/等待审批等状态借用原Grant新增Assignment或生成no-op成功校验日志；public retry仅接受已完成 `failed` 且没有停止意图的Ticket，沿原Grant/digest、Node/worker/binding生成独立下一Attempt（epoch递增，原历史不改）。已与reconciling、revoke Grant等拒绝场景逐状态比较原Assignment/Report/Artifact/Effect及审计不变。`retry_after_approval` 仅保留库内generic兼容及自身测试，不是HTTP绕开人工理由的授权旁路。真实 `/approval` 改走携带规范化 `reason≤1000 UTF-8字节` 的 `approve_ticket`，并验证同票Source/current Grant/root/worker。批准理由与实际Assignment/Lease/epoch、原Grant/digest与审批事件在同一个BEGIN IMMEDIATE内写入，拒绝仅记录理由而保持waiting/零工作。公共retry的assignment.retried与ticket.retried已经收进该相同事务，TTL里任一DML/audit失败都回滚ticket和lease。实际HTTP仍保持scope非法403和非pending409，SQL trigger拒绝后零变更，并有真实heartbeat恢复和artifact证据。具体见 [tests/sources/README.md](../sources/README.md) 的当前三源审批闭环，和刚重跑的[真实DSH重试证明](/tmp/loom-approval-dsh-final-wvhkGI/result.json)。Node自身的 `validateAssignment`/admission仍需逐项核对当前作用域，这不是让UI拥有更强的执行权。

正向源码编程样例进一步通过真实Vue点击failed retry后由真实DSH完成下一Attempt，旧失败的diff/test在前后下载保持bytes/hash不变；reconciling在普通Edge的按钮已不可提交，force-click零retry POST，直接后端仍拒绝。整体证据见[真实代码 worker](../../../tmp/loom-failed-retry-evidence-Z3FLpO/result.json)与[普通浏览器证明](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-z9Mzwf/result.json)，而不是把mock状态/禁止按钮当作后端权限保证。

## Bare Rust：损坏调度时间与hold不可再误报已交付

仍用 `cargo test --locked -p loom-node --test completed_replay -- --test-threads=1`，当前**3/3**。由真正本机读取实际生成Artifact/Report，在确认其持久pending后将两条`next_attempt_at`改成同一不可解析字符串。原代码只跳过无法parse的字符串，最终`TickStatus::Delivered`：见[pre-fix RED](/tmp/loom-invalid-schedule-red.log)。修复在**整个queue的任何投递尝试前**拒绝非哨兵的非法字符串，报告`invalid durable outbox schedule`；item/body/attempt/error及Assignment/completion/cursor均保持，没有新的Artifact/Report HTTP或file effect。坏项会让你明确核对并停止本次dispatch，而不是把它直接当作立即允许上传。

StateStore两个既有写入路径统一使用同一个未变serialized permanent-hold哨兵；它并非新权限位。真实`mark_delivery_error(false)`形成的hold保留原正文、错误和cursor，不向上传端点再次发送。60秒合法future也为Deferred。原有优先级保留：可重试失败→Deferred；本轮真正的不可重试拒绝→Rejected；仅剩future/hold而非空的queue →Deferred，只有空队列才Delivered。一个非法调度字符串可能阻止该轮其余投递，不宣称后续无阻塞自动修复。

本变更只针对**字符串形式的非法调度值**；legacy decode中缺失或非字符串时间默认now的行为未改写，也未被宣称已完整验证。真实loopback执行/存储不冒充中央签发，真实Rust bare集成另行保留。当前[Cargo记录](/tmp/loom-outbox-schedule-rust.log)逐target汇总为**187通过/0失败/1 opt-in probe忽略**；Node39/Vue155 + `vue-tsc`均通过。private Node root与listener均为fixture并回收，无production Dsh Profile改动。

## 用户 UI 撤权 + 两次未领取空poll的补充证据

在普通生产浏览器驱动 `tests/browser/run.mjs --keep-evidence` 内，用户通过权限页精确Grant的确认按钮撤回授权，做的是现有Concierge的真实 `POST /grants/{id}/revoke`，而不是 Node 直接访问管理路由。此 Ticket 已签发 Assignment，却从未被 Node acknowledged；撤权后不调用executor，连续两次原LocalNodeRunner的正常poll通过同一注册身份拿到真实 `assignment:null`。对待原响应只做只读记录、保留认证上下文和返回形状，不把缺轮询或短路包装为空poll当作通过。

同时验证原Assignment/lease_epoch/digest与旧Lease窗口不续、`cancel_requested=false`、reconciling而非自动cancelled、原节点Assignments/completions与outbox不变；全局 `grant.revoked` audit与`action`属于该Grant，不能误制造本Ticket的cancel/report；SQL/HTTP现有 `/audit/verify`链检查成立。临时fail-on-call executor证明任何意外执行不能变成静默通过，随后恢复原来的executor。复用旧Grant的**合法**Ticket请求到达服务器后确实以403 `grant_scope`拒绝，没有增加任务或目标文件。该新增Proof不是代替以下已受理旧source edit停止测试，也不宣称多Grant/multi-host等。原协议、runner与命令分列仍在下面，不应拿这些正常运行结果的围栏混同真正已经在执行的native Agent撤权停止。

此入口现在验证**同一ID重复撤权保留第一次发生的撤销事实**。正常首次Grant v1→v2、lease失效、running→reconciling及audit同属一个事务，任何audit写失败都回滚Grant/ticket/lease且无幽灵revoke。重复HTTP在已经撤销后只读真实 `duplicate:true`、`grant_version`、`revoked_at`，不增加版本、不续租或改写时间、不追加audit，也不复活旧Grant/newwork。对已受理的旧edit_file Assignment，原先在v2便可领取的原ID/lease/epoch与digest在第二发后仍能实际收到 `purpose=reconcile`、`grant_status=false`、`grant_version=1`、当前Grant v2的停止帧，期限不变；不是仅期待`duplicate`标志。此前旧Bug真实返回v3和assignment null，已用同一LocalNode fixture在修改前复现，故本回归针对跨界遗漏而不是虚构“v3也能放行”。当前非标准v7仍保持，未批量扩为 `version>=2`。

同样的Node revoke也不会因重复请求第二次写入首次时间或租约，也不增加 `node.revoked` audit。节点管理路由用既有实际admin client身份，不通过 `LoomHttpClient` 的Node transport放client-token fallback；Admin与Node的认证边界不同，原SDK拒绝规则保留。已经受理的旧artifact/非法success Report仍然被真实 `409 outcome_unknown` 拒绝，没有新 مرکزی report/artifact/effect，旧Grant再>CreateTicket为`403 grant_scope`。

Node的`status`与timestamp不一致或timestamp非法形式则是 `409 revocation_state_inconsistent`，不会在本该不做或不能完成首次状态变更时，仅更新lease、增加虚假审计再假称第一次revoke。缺少timestamp与已有timestamp但status不匹配/非string分别覆盖。原子operator与unknown effect边界以当前完整HTTP/SQLite及真正的注册Node worker contract validates，不冒充DSH、第二物Host或所有副作用的global exactly-once。

[当前十阶段完整真实Edge数据](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-browser-evidence-Q86Qf1/result.json)。

## 原子Acknowledgement及受理来源审计

```sh
node tests/runner/ack-audit-atomic.mjs
```

`/nodes/acknowledge` 原先先单独写入`acknowledged_at`，随后再写入 `assignment.acknowledged` 审计。若审计步骤失败，Node可能看到一个错误，却留下被认为已经受理的履历，后续撤权停补门也会读取这一字段，却找不到与之匹配的来源审计。现在该项Assignment更新和审计在同一Store事务提交，字段与时间戳必须共同成立，否则一起回滚；没有将`acknowledged_at`标到assignment却不存在审计记录的状态。仍由真实Node identity/current ticket/assignment/lease/epoch以及当前authorization控制，不是冲空节点调用`accepted`也一律总能执行。

这一acknowledgement保持 **`delivered_is_not_read`**：它不等于读到了Artifact bytes、模型调用、普通执行或取消 acknowledgement，亦不创造Report/Artifact/Effect或新Grant/Worker。此证据以**当前Grant与ProjectBinding**内那一笔实际assignment说明Node被正确Accept；不把原生accept代码当作exampleoperator批准。客户端在lost/unknown response时需仍以当前Ticket/assignment/audit核验结果，不能从这一次原子重放推出全体命令全局exactly-once或被复制的代码编辑已结束。

验证分两部分互不混淆：router/同connection SQL TRIGGER fault验证原子回滚与后续合法ack；外层真实registered Node +真实HTTP契约由这一driver以同一临时数据库上的**持久 trigger**制造只在服务器写入connection可见的audit失败，要求`acknowledged_at`仍为NULL且匹配audit=0，禁止“审计拒绝結果テーブル却被 accept写入” 的结果。结束仅这个 fixture trigger被DROP，随后同一ack命中 `delivered_is_not_read=true`、正确assignment/timestamp和审计链路。前一脚本漏objective曾先被合法API拒绝；外部`TEMP TRIGGER`在不同SQLite connection中看不到server自己的连接，触发失败预期曾被issue归因为转录遗漏，未误作产品证明。没有grants/capability license/private身分架构扩展、其他DSH Provider/插件安装或第二物理机的执行证明，仅本节点的审批入口与审计可靠性。

## 合法ACK原始回执与Node响应丢失恢复

```sh
node tests/runner/ack-replay.mjs
```

原server重复接收一个合法的普通ACK时会更新`acknowledged_at`并追加第二条audit；旧`client.acknowledge()`又完全绕过outbox。这两个问题不能只靠“首写入事务原子”解决。现在服务端仍然先认证Node、核验当前Assignment/epoch/Grant/Lease，再仅对原Assignment的**合法timestamp + 恰一个匹配Node admission audit**返回首次timestamp和`duplicate:true`，不改原值或追加审计。真正`NULL + 无匹配audit`才是首写；有效时间戳无audit、NULL有audit、非法非空字符串/类型或多个审计都返回409 `acknowledgement_inconsistent`，保留原历史而不补造一份准入。独立review发现的`as_str().filter(parse_time)`把坏值误归为空的首写漏洞，也由实际SQL负例和同一矩阵检查封闭。取消/unknown effect的其它协议和fence没有被这一普通ACK replay替换。

LocalNode客户端把ACK先写入既有NodeState v1 outbox，再进行真实`nodes/acknowledge` HTTP。相同逻辑body的in-flight合并/待投nonce保留不是授权，request_id也不是Server identity。持久pending是打算投递，不是中心接受；在实际HTTP回执具有`accepted:true`、有效非空timestamp及正确布尔duplicate（若提供）之后才可清队列。损坏body/request_id、坏timestamp及布尔形状错误的缓存不能伪装接受，必须重新联网核实；本地`duplicate:true` view不会将持久原始回执中的`duplicate:false`改写。未知的transport/5xx保留pending，不再丢弃实际生成的Artifact/Report；这些出箱项只在同ticket/assignment/epoch有未决ACK时等待，独立合法工作仍可交付。NodeState已有deliveries字段缺失维持旧版读取，非数组坏账本拒绝，不要求额外数据库迁移。

**停止传输与普通回执缓存的分流也在本题开展实际对照。** 在调用本段函数前，已经在真实Rust/已注册Node上观测到：两个同参数、带stop flags的ACK，`delivered_is_not_read`的原Admission已落定，但第二次HTTP被普通缓存替代并返回本地`duplicate:true`，实际ACK数为1。这不是取消完成或root撤销停止帧的幂等承诺。共享client现于 `cancelRequested || cancellation` 下直接走原HTTP，不进入ordinary logical-digest/回放cache/in-flight去重。`cancellation`仅是既存客户端路由别名，服务器还是要按当前`cancel_requested`和现有Fence作判断；flags自身不构造中心取消意图，stop receipt亦不是SDK cancelled Report。两次相同direct stop实际分别得到服务端response，不再由此伪造普通replay的duplicate视图，且不新增ordinary outbox/delivery增长。原先legacy raw ACK pending仍走普通至少一次dispatch与错误持久化，不作同样的新shortcut，避免抹掉真实待发历史。abort不开始fetch，denied也不制造普通`acknowledgement_pending`。

`ack-replay.mjs` 保留主理那一笔恢复的原始timestamp 与一条准入审计，再用同一个注册Node/Binding上的新建合法Grant与真实controller cancel intent启动一轮停止ACK：它实际**两次HTTP并使用不同nonce**，SQLite相应产生**停止路径的两笔legacy ACK audit**，没有普通缓存替代第二次server evaluation；同时主工作仍只执行一次，停止任务无Report、Artifact或Effect。已有普通delivery以及先验撤权留下的两个quarantined deferred意图保持不变。这里刻意 不把“两个停止audit”称为比“一个 replay audit”更好的实现，也不推导它们已经终止了Agent；它们仅证明direct传输在此期间按legacy server路径被真正访问，而不是ordinary replay管辖。新的[whole-case结果](/tmp/loom-stop-ack-boundary-final-SgQ0Yq/result.json)和[源码绑定manifest](/tmp/loom-stop-ack-boundary-final-SgQ0Yq/manifest.json)同时记录之前实际一次HTTP被吞与本次两次server回执的边界，driver SHA `f5d46286cdfa985a411ab56c5a9fb7590cca88cab8abb12ea1ddcd7e507d41bc`，结果 SHA `329faa264b36f0b83a50dae0a8d9037c6893178007755e06ec784d540b94e3ed`。

另在 `node --test packages/node-client/test/*.test.js` 中，**37**个客户端用例覆盖两个alias各自的重复stop与Node token/flags、abort零HTTP、真实HTTP 403拒绝不生产普通pending、以及legacy raw pending的先交付再比较保持原历史。无接入生产主机或live provider，not broad stop idempotence。

真实driver：使用当前Rust Concierge、真实注册Node、项目/Binding/Grant和实际`ControlledFileExecutor`输入文件。第一次实际ACK HTTP 200被读取以后，adapter有意抛出“响应丢失”，但本地executor仍只运行一次。此时中心有第一笔ACK，没有Report/Artifact/Effect；本地ACK/Artifact/Report仍持久待发。driver重开同Node身份与状态，尊重原有backoff（不是把时间戳强置为过去），再取回**第一次timestamp**，记录实际HTTP顺序 **`ACK → ACK → artifact → report`**，最后得到一份 succeeded Report、一份Artifact和一份Effect。回头poll不再执行。真实下载通过原始Ticket Detail的`artifact.id`取回，并重新校验`downloaded.artifact.sha256`与`downloaded.size_bytes`，不是预先假定`metadata.*`包装或`artifact_id`列名。原输入bytes在前后完全一致，生成Artifact的341 bytes独立SHA校验后为`94811ec47d3a7326cc3f693387a93d60379f1198322c364ebc6aa56a02c7492e`。

另一个在本机真实注册的逻辑Node对该Assignment仍403，错误`lease_epoch +1`也拒绝。随后真正撤销授权，再按旧ACK body/digest重新入队，它保持deferred而非accepted，原timestamp和单审计不变，撤权后的`audit/verify`仍有效。这个第二Node只用于owner负例，不意味着物理第二台机器。central SQLite仍为schema15，整轮为deterministic LocalNode loopback，**不是**无条件的取消幂等、全局exactly-once或真实provider服务。**这是共享`packages/node-client`的证明，不能代替实际DSH bundle的独立副本/执行顺序**：`plugins/dsh-loom`在first SDK effect之前ACK，其真实Profile与tool/Host重开恢复由 [tests/harness/ack-replay.mjs](../harness/ack-replay.mjs) 单独验证，详见[真实DSH ACK回放](../harness/ACK_REPLAY.md)，都不是任意工具中途崩溃的全局幂等。

本段落上文的[实际最终结果](/tmp/loom-ack-replay-final-Yc6Qcx/result.json)和[manifest](/tmp/loom-ack-replay-final-Yc6Qcx/manifest.json)属于该generic LocalNode验证；不要拿它取代真实bundle复制安装后的[真实bundle复制安装后的Host ACK replay结果](/tmp/loom-dsh-ack-recovery-final-XEfDLI/result.json)。

[实际最终结果](/tmp/loom-ack-replay-final-Yc6Qcx/result.json)和[manifest](/tmp/loom-ack-replay-final-Yc6Qcx/manifest.json)保存了原始timestamp、owned fixture root、复现源码的hash、实际341-byte Artifact、单执行/单审计，以及真实Report、Artifact与Effect彼此分离的事实。manifest的result SHA为`1baeee9f066125d52412aa9d11dbbe595933abbfa39d06d1b38c2d8963e6b0f0`。仍以LocalNode ACK回执、实际report与外部effect的分离为限。

此前的`node tests/runner/ack-audit-atomic.mjs`仍是独立首笔事务回归：持久audit fault发生时，当下Node返回`acknowledgement_pending:true`和`response:null`且ACK真实留存，但SQL直接确认timestamp为NULL、匹配audit为0，且不会生成Report/Artifact/Effect；解除自有trigger后真正成功应答才清pending并留下恰一份audit。**不是把不明5xx臆断为已提交才通过，也不要求按旧接口必然抛出异常。** 内里如此处ACK均没有创造终止或effect proof；完整原策略、priority、首达预取消、direct revocation fence和generic event replay也分别重跑通过。

## Node State首笔once竞争与真实owned效果

`pnpm --dir packages/node-client test` 现在是 **39** 项通过；`pnpm --dir plugins/dsh-loom test` 为 **109** 项通过。两者各自引入 `state-once-race.test.js`，用同Assignment/同digest的两个首个立即调用检查底层首次声明，而不是只看上层active guard。原实现确实会各自写A/B两个owned文件：共享before根目录 `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-once-before-CNDcmq`，vendored为 `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-once-before-irObyP`。首次`mutate`前并非已存在的completion缓存，也不是所有runner的普通重复投递都失去保护。

新实现于同一Node State实例同步记录in-flight `{digest,promise}`，第二调用等原操作完成并以duplicate取得真实结果，且不能再次创建callback。两个case各自验证同逻辑工作的一个具体文件、Unknown不升格、一个失败效果不因缓存回收再执行；同key的改input digest拒绝、operation不运行，另外一个独立Assignment在holder未放gate时也能真正写另一个文件并结束。身份匹配的finally清理已被实际验证，完成或失败后缓存仍有同Digest完成记录。

该保证不扩展到跨进程、同类不同Host、报告/ACK/取消或所有SDK的恰好一次。只是同实例的`once(key,digest)`开始题及其本地完成投影。外部fileDispatcher仍可在原操作之后按真实竞态置unknown。恢复亦为unknown,不从中再次执行。真正同一工作 callbacks不应自我await同一 once作为执行路径。真实Lifecycle `node tests/harness/real-lifecycle.mjs`的原始结果见 [/tmp/loom-once-sdk-L5P1nB/result.json](/tmp/loom-once-sdk-L5P1nB/result.json)，其install/register/task/programming_write/traversal/cancel/session resume全部PASS，外部模型标注NOT RUN。

`node tests/runner/coordinator-admission.mjs` 还有相邻Synthetic回归的具体fixture修正。原始未修改HEAD的存档同样已发生旧断言失败，相关一个delivery其实正是合法`kind:ack`（accepted真实回执及 timestamp），并非提前Artifact/Report；这不能怪罪上方map修复。现行断言要求那一个pre-effect正常ACK与ticket、epoch、cancel标记、时间戳相符，同时仍要求任何0份Artifact/Report delivery，直到完整unknown/normalize durable完成。这是更严格地分开准入与结果证据，而不是通过删除约束或冒用真实SDK通过。执行报告仍以`synthetic_control_plane_only`为界。

## Node事件回执一致性、跨语言digest与真实重放

```sh
node tests/runner/node-event-receipt.mjs
```

这条driver在独立root创建真正注册的LocalNode、Binding、Grant与**实际poll得到的Assignment**，用 `client.event` 和持久outbox发送一条process消息，再通过实际Rust HTTP和SQLite核对message、receipt、时间戳及logical digest。第一笔送货之后使用同一Node凭据重新提交原body，仅改变outer/inner Session对象键顺序，须返回原message的`duplicate:true`，不是新增一条记录。停启同一Concierge root后再重放，明确这是lost-response retry的**模拟**，并没有给真实TCP丢包或物理网络故障包装成PASS。

正文、kind/sender/session和带自报`source_verified`的parent字段都不能在同一request_id下改写事件。使用同一Node的另一笔**显式预先授权**Ticket/Assignment也会冲突，两笔Ticket/Assignment是测试特意建立的work，不是replay所在节点中新偷偷生成。stale epoch仍走原`stale_lease`，null、非字符串和超长requestID仍是400。driver不运行executor，硬断言零Report/Artifact/Effect、零cancel_intent，各Ticket仍running。不是API按钮或包装json讲完成结果。

这是一个与Report/Artifact有不同namespace的event回执：**`SHA256(canonical({logical_fields:body去掉顶层request_id}))`**；对象键递归sort而array顺序保留，**这一层logical_fields不能省**。事件request_id是opaque UUID，不要求等于该digest、也不是权限凭证。另一Node合法地具有独立opaque ID namespace，不能因原表`(ticket_id,request_id)`与全表查找同名ID而把两个原消息误当作同一份缺失的receipt。

实际开发中，Native driver发现内层单测只能通过**稳定hash**却漏了一层wrapper：Rust与真正Node outbox/logical digest并不一致。现在Rust按 [client.js 的实际逻辑](packages/node-client/src/client.js)计算，且固定Client.js生成的golden进restart测试。真实driver的[结果](/tmp/loom-node-event-receipt-final-Mqsph1/result.json)和[manifest](/tmp/loom-node-event-receipt-final-Mqsph1/manifest.json)保留两者的相等SHA、不相等的opaque ID及第一条immutable message；不调用DSH资料或修改用户profile，也没有让管理client token回退成Node身份。

附加的Rust `api::tests::event`共有**六个**focused cases，覆盖实际认证Router/HTTP+SQLite的两份数据原子写入、restart回放、array/key排序差异、冲突保持不变、独立Node命名空间、跨另一合法Task/Assignment以及legacy兼容。最窄的一组旧行只是在**同ticket/request_id**的content/sender/kind和原始session均严格匹配时才允许duplicate，不回填对整条所谓旧body的新认证。`source_event_id`关联消息不被纳入这一普通Node事件receipt判定。

另有**scripted source fixture**（严格分别选择的parent/child Grant、真实byte-backedArtifact、UUID、document graph和受限Parent Session）首先真实通过`validated_delegation_relation`，才存储server-derived normalized session及规范的`source_verified`/`validated_by`，而非信任raw flag。private receipt把它保存为内部`stored_session_ref`，与首次实际message一致，HTTP首次和duplicate都不返回这个字段。删除fixture中的父Session之后，**完全同一个原始事件**仍按已捕获的关系返回duplicate、原message/requestID配对不变，不重造parent proof或生成新工作。拒绝通过把receipt.message_id改成一份**请求ID不同但文本相似的消息**来冒充duplicate，response损坏/缺message也保持`receipt_corrupt`而不是fallback insert。

原生Native Driver是事实交付的代表，受限document fixture则仅证明模型内source关系的保存与读取；**均不是实际DSH Provider/Agent/多Host或全球exactly-once承诺**。当前Lease始终先于读回执，过期、撤权或取消仍按既有规则，不能在receipt层复权。本次未启动用户明确暂缓的1+3 Compose。最终测试的总数以主控实际完整workspace日志为准，不把写脚本时的稳定性估算当成正式结果。

## 有界Ticket priority与pending stop的真实调度

```sh
node tests/runner/task-priority.mjs
```

普通认证客户端创建Ticket时可以明确指定 **[-100,100]的整数priority**，当前Node的合法**未ack普通execute候选**按较大值优先；省略为0，显null、布尔、字符串、小数、越界数字都400且不新建工作。同一默认0仍保持原来的 `assignment.created_at DESC`，不是改成FIFO。failed retry沿用原票的preference，Source event/frozen Spec不能自行提级，Node自报也不能修改中心排程。priority**没有放在Node assignment或operation中，不进入工作digest**。

**停止/对账先于数字比较。** poll先以同一Node/epoch/current Grant和这些租约状态的基本CTE查找当前待处理 `cancel_requested`或 `reconciling`；包括合法首次发放且尚未ack的预取消，keep original created_at order。找到则交出待处理对象，不拾取另一个高priority普通ticket。没有这种待处理时才按 `priority DESC, assignment_created_at DESC` 取一个普通execute。当前不会因此抢占已经开始执行的SDK Agent，也不会因为紧急tag就授权另一physical Node/binding root。 Acknowledge仍不是完成结果，报告与实际工作效果各自成立。

此driver仅以**一个真实enrolled LocalNode +own临时Project/Binding/root**展示：旧80先于新0，未ack重投不消失，ack之后才取另一个真实Assignment；两个同为0的候选以真实创建时间验证**近者先**。无效六个输入均实际400且SQL没有新票据。对未ack的低值 `pending`作业真正发出cancel后，先收到该停止意图；未报告前重复stop不自动消失，随后只有当前assignment的合法`cancelled+cancel_acknowledged:true` outbox report被接受，才把urgent推进。这里的取消是这一支未启动执行的事实链，**不是SDK active-job abort**。

使用对自有中心数据库的owned SQL把Node改offline创建waiting task，priority 47仍在`waiting_approval`存下；用该Node的真正heartbeat恢复后，人工approval**只发一次**Assignment，client poll才收到作业。普通非Source的waiting ticket果然可能延用旧空`installation_id`和`grant_digest`，driver不伪造这些字段的backfill；它单独核实真实poll的Node SQL installation、wrapped Grant、原binding/root与作业ID。此步仅证明主机可用性选择与审批持久，不是物理离线/手机切网验证。

另有priority40的真实missing-file **failed** 后，用户显式retry且在同一owned project创建retry.txt，新Assignment读取真实bytes成功，保留原失败report、原权限、原priority，还带实际Artifact/Effect及其SHA。最终计数是节点1、Project/Binding各1、Grant 2（一份独立撤权）、Ticket 9、Assignment 10、Report 3（cancelled/failed/succeeded各一）、Artifact与Effect各1。撤销另一个priority100 Grant后，current Node poll不再给出该Assignment，未知Node仍是403，不被高值绕过。

当前Storage为**schema15**，仅添加 `tickets.priority INTEGER DEFAULT 0 CHECK(-100..100)`，旧行默认0，Grant、TaskDigest、scope及所有Source迁移不重置。原Node event/acknowledge/revoke、memory/schema14code-evidence、Source/安装计划/Skill和documentflow保持原scope；本轮仅把**当前版本断言**更新到15，另在真实运行中抓获两处document/install断言和多处evidence标签遗留旧号均修正。后续未知>15仍拒绝。此proof是**候选领取偏向**，不承诺排队公平性、避免饿死、跨Node全局排序、真实SDK中止、general DAG/Graph、live provider或用户暂缓的1+3 Compose。最新主控实际证据：[report](/tmp/loom-task-priority-final-vCwQDQ/result.json)，[manifest](/tmp/loom-task-priority-final-vCwQDQ/manifest.json)。形式化执行止于owned proof，不能把潜在未知效果重新说成成功完成。

## 实际中心的撤权停止帧、旧证据围栏与审计

```sh
node tests/runner/grant-revocation-fence.mjs
```

此入口在真正的 Rust Concierge 上建立注册的 Node、ProjectBinding、Grant与 current Assignment。它先完成实际领取确认（`acknowledged_at`），随后撤销该 Grant，并另外创建24个未领取 Ticket 以超过24条审计记录。严格选择器只向那笔已经 ACK 且尚未 Report 的旧 `edit_file` 提供 `purpose=reconcile` 的停止帧：原始 `grant_version=1`、当前 Grant version=2/revoked_at、精确身份/root/digest及字段完整，不把 `grant_status=false` 当作用户取消。未领取、其他工作类型或不同 immutable work 不得借此开始执行。

- 撤权帧只指导旧的原作业停止/对账，不延长已过期 Lease，不把新 Ticket 视为已执行。中心将 running Ticket 转为 reconciling，`cancel_requested=false` 始终独立持久存在；没有新Grant、Permission、分布新Session或私自Session event。
- 使用真实 HTTP 客户端对原 epoch 的普通 Artifact 与 succeeded Report **实际发出**上传，二者都得到 **409 `outcome_unknown`** 并被隔离。SQL/Artifact/Report/Effect新增数为0；第二笔未领取任务未发生本地或Agent执行。这里的围栏不是检查某个`accepted:true`布尔值。
- 实际 `grant.revoked` 持久审计在 SQL 和 `/api/v1/audit` 都存在，其外层 `evidence` JSON字符串解码后的 `evidence.grant_id` 与该Grant一致，并使用 `old_leases_expired` 表示旧Lease失效。`ticket_id=NULL` 的全局撤权记录不得被误当 ticket.cancel_requested 或 accepted Report。共同的内置Node HTTP读路径还检查33行实际数据与原始 socket响应完全相同，含最 新撤权行，不以假定的24条截断计为完整世界。
- 复核真实grant/revoke**之后**发生的上传拒收，**没有** `report.accepted` 或 `artifact.indexed` 新审计中的另一种历史；旧有权产生的 evidence 不受回溯性销毁。审计链 `valid:true` 与SQLite `integrity_check:ok`也被实测。

这个proof仅覆盖 current active assignment 的中心撤权围栏，**不证明**任意工具/版本的多路执行、真实 Agent 的Cancellation/Harness introspection、移动真机或1 Concierge+3 Worker组合。真实DSH held-verifier的停止、原字节local outbox隔离及重开的对应driver在[CODE_TASK的撤权章节](../harness/CODE_TASK.md#revoking-a-grant-during-an-admitted-edit-separate-from-cancel)分别验证。

## 边界与持久格式

- Assignment 的 ID、Ticket 关联、kind、path/content 等**工作输入**保持冻结；epoch 不可倒退，Grant digest 必须精确匹配。尚未写入合法 assignment 前，不能借 `duplicate_active` 和进程内空白 map 接受任务。`sameAuthorizedAssignment` 比较所保存的 JSON 形状，显式允许的本地派生 Grant ID/version 不会制造漂移。
- `lease_expires_at` 是**当前授权时间窗**，不是 work content。Controller 可停止旧交付并改变它；普通执行仍要求当前 Lease 未过期，停止已确认工作的取消请求不因此消失。撤销当前 Grant 不允许开始新执行，但可停止先前已接受的任务。不能将取消信号当作新的 Grant。
- 取消需要匹配的已接受 Assignment；未知/foreign assignment 不会被添进历史。不通过一次拒绝 ack，给 Task 写入 failed/succeeded/ignored 的报告。控制权核销是独立的 receipt 事实，不等于批准新 Grant、任务终态或 Effect。
- 私有 NodeState 增加可选的 keyed-object `rejections`，包括 `loom.local-rejection.v1`、按 assignment ID/epoch/grant digest 得出的 fingerprint 与核销结果。它不属于中央 Ticket/Grant/Artifact 权限。2xx 且明确接受的确认与 quarantined HTTP 拒绝、pending retry、未尝试分别记录；永不伪造缺失 Ticket 的 UUID。相同持久指纹不会反复发送已确定终止的核销。
- `once()` 在 callback 之前拒绝缺失/不同的 input digest。本次工作形成的 pending digest 和 assignment id 也合并到正常完成、异常完成及 pre-start cancellation 中；不清楚的外部效果仍为 unknown。旧文件里缺这些证据的记录不会被当作可验证回放或擅自重新执行。
- Report/Artifact 的 `request_id` 由其**排除 request_id 后的完整逻辑内容**决定，等于保存的 logical digest（64-hex receipt ID）。同一 immutable payload 在丢失 HTTP 响应后仍可复用原 receipt；改变 payload、字节、metadata、case 或状态不能冒充同一个 receipt。原 Artifact UUID、bytes、SHA、Effect ID/lineage 都是独立事实，不以 receipt 哈希代替。
- DSH dispatcher 在真实 operation 返回后、完成提交**内部**归一化 Artifact ID/metadata/effects，避免先落到不完整的完成记录再补水。JSON 文件的逐一重开和 Reports 的空壳重建不等同对所有历史版本的具体效果自动恢复，也不等同精确 crashpoint 验收。

## 有界 HTTP 响应流与停止唤醒

```sh
node tests/runner/http-stream.mjs
node tests/runner/http-socket-stream.mjs
```

公共与 vendored `LoomHttpClient` 使用标准的 `response.body.getReader()` 做分块读取，在合并还原 JSON 之前按**实际收到的字节**限制响应体积（默认 1 MiB，允许显式非负安全整数）。超限所在 chunk 不被 append，reader 随即被 cancel：`Content-Length` 不参与安全判定，低报 headers 不能豁免。也涵盖恰好达到上限的消息、逐字节拆开的 UTF-8、非法 chunk，以及没有 stream 的旧 `arrayBuffer` fixture 的兼容路径。后带兜底路径仍需先取得整段再拒绝超限，不是所有响应类型都可由该 helper 提前分配限额。

- **唤醒而非仅发取消信号**：每个挂起的 `reader.read()` 都与既有 AbortController 竞争，分别处理 caller stop 和总 timeout，不把 body read 的恒 pending Promise 变成永活请求。外部取消原因统一优先；普通网络/JSON/status error不被错转成取消或未知副作用。没有每个 chunk 重置 deadline。
- `reader.cancel()` 失败或永不完成时，不能覆盖主要错误或再次永久挂住 cleanup。内部 Abort 亦向底层 fetch 传播，但没有将已经产生的网络请求/副作用说成取消完成或回滚。每个失败尝试只发起一次 reader cancel，绝不宣称全局 exactly-once delivery。
- 连续零字节 chunk 不计入 JSON payload，但步骤会让出事件循环，避免总 timeout 的微任务饥饿。前置中止不会把整段文档再读出来；多字节字符只在受限合并后统一 UTF-8 decode。
- **实例范围的 socket 证明**：`http-socket-stream` 在 owned 的 `127.0.0.1` 随机端口上，实际接收 Node fetch 的 HTTP response。起点缺失的 JSON 与多次分叉的partial payload不会被接收；正常 JSON、cap 拒绝、caller cancel 和超时均分别等待真正 server close，而不仅观察一个返回 error。该 fixture 独占各自 server 并在换用下一个 probe 前清理旧 listener；`server.listening` 必须为 false，自有 sockets 必须清空，CLI 应自然退出。

这些测试不证明远端有序取消得到保证，也不证明对所有上游都有绝对最大分配或停机保证、物理远程、TLS、多 Host 或 Live LLM。真实 Agent 调用、取消和恢复、receipt replay 与固定 SDK 模型测试仍分别实测，不由本地 synthetic socket 证明替代。

## 节点启动中止与凭据恢复

```sh
node tests/runner/startup-cancellation.mjs
```

- 两层 `LocalNodeRunner.start/create` 将可选 `AbortSignal` 延续至既有 enroll 和首次 heartbeat。主包的 `create` 还补齐 `fetch` 传递；vendored 的创建路径同样保留自身 profile/timeout 注入，不能因 mock 未透传而不慎回落到全局 fetch。
- `NodeIdentity.readEnrollment` 在读取已持久 token 前，共用于原 `open` 的 public hash/PKCS#8 验证；损坏的身份不再简化为“缺少enrollment code”。如果本就不存在身份或已预先取消，启动不会擅自生成新私钥/身份文件。中途观察到取消后，阻止后续 state、注册、heartbeat 和 Coordinator；已经开始的原子文件写入不能被假装回滚。
- 真正的注册token若已被中心接受并保存，取消只中止尚未进行的后续启动，不删除或冒称撤销该事实。原生 test 在实际 `setToken` 保存之后取消；在两个 owned Rust Concierge 上都查到其真实注册，重新启动使用相同的 Node/Installation 与凭据并成为在线 Node，不新增注册或工作。
- vendored `createClient` 和 `runLocalDshPlugin` 的**可选 lifecycle 参数**仅用于显式 caller 的启动中止。pending model catalog 不必须支持底层取消；等待可结束但不得继续启动轮询，且真正五个第二超时仍是对应的 observation-expiry，不对任意错误统一贴取消标签。非正在启动的现成 Coordinator 仍通过 `loop.dispose()`。
- 该可选 signal **没有**塞入配置 schema，也不伪造 DSH `ctx.effect` 的全局取消契约。完整 DS Host 的常规 install、worker task/cancel/resume仍由 [real-lifecycle 入口](../harness/real-lifecycle.mjs)独立验证。无新 Grant、Artifact、Report或主管端“注册撤销”被发明。

此专项还覆盖预检/identity/state 的真实中点等待，以及 timeout和后续caller stop的区分。多次计时误导（漏传signal/fetch、raw public key缺 SPKI包装、5秒未ref定时器退出）均作为量具问题修正，不以撤销断言或删除负例试出PASS；只由自然退出与每个实际的中央响应/保存形态认证证据。

## 首次预取消与完成回放

```sh
node tests/runner/cancel-before-admission.mjs
node tests/runner/prestart-replay.mjs
```

- 真实Rust中心的 `cancel-before-admission` 直接验证：对合法、还没来过Node的预取消Assignment，先通过具体Grant /node/worker/project root /kind/stop intent核验，然后形成**原assignment与取消完成一起保存**的事实。现在 `execution_started:false`、取消ack和digest在state中可重开恢复，不把先存running误当成实际执行。
- 目前只覆盖受控的 `read_summary`、`edit_file`、`model_descriptor` 文件类工作，root/realpath及worker身份不豁免。dsh不再调用一个假想的`assertApprovedRoot()`；它实际比配`registration.project_roots`。`model_text`、`credential_ref`等仍有各自的placement、binding和scope要求，不在这笔首次预取消支持声明里，也不冒用'未启动SDK调用'创造更强的取消能力。
- 普通执行的过期lease与撤销Grant仍严格拒绝；stop-only分支仅延缓这项允许性判断到取消时，**不延长lease或给未启动Grant新执行权**。无效 expiry格式仍需拒绝。非过去的授权或另一个node/digest/worker的错误不能从取消通道成为允许事项。
- 如果已经有completion或当前promise 数据，则不能冠以新的 never-started；活跃worker 进入真实executor.cancel与Report。Controller 中 active/diverged snapshot 的匹配只在相同授权视角下进行，Grant撤销是停止原先被受理作业的分开投影，不是对新执行的复活。正常执行效果和unknown effect继续保留实际来源。
- `prestart-replay`另以 owned SyntheticCoordinator + LocalFileDispatcher/CoordinatorLoop（**并非DSH Host**）验证，真实center提交首份cancel report后，**再丢弃客户端的响应**，让持久outbox及确实到期后的交付得以复现。同一个取消完成、稳定request/receipt ID在重开后重新交付，中心确实报告 `duplicate:true`，未重新执行file effect，没有自动生成假Artifact。
- 本地rejections按每个assignment/epoch/grant fingerprint保持源幂等性，并在route内部记录work input/context digest。scope/reason/input不匹配时，不允许旧quarantine遮蔽本次真正非法的node、Grant或expiry。terminal去重必须**reason与input_digest全匹配**；旧缺digest的记录不能被用来证明新的scope完全成立，只保留历史并返回`current_context_unverified`，不重发新ack。不扩大Grant，不写中心Schema或伪造Ticket状态。
- 协调器已有pending与adapter.active均为可追踪的在途语境，但不是一个任意Grant赦免。停止前仍需同durable immutable frame；普通任务允许先有preflight.active，之后再做durable admission，不能误用停止分支的history-loss守卫拦住它。已有model binding cancellation恢复为一个producer/cancel/report，与真SDK寄宿验证同时保留。
- **live vs durable**  Check：先读取active，不因durable缺失而让实际上已运行状态获得never-started完成。`durable缺失 + active存在` 必须保留missing-previous隔离。`cancel-active-fence.mjs`与`coordinator-admission.mjs`都在原blocked work里删除durable/recovery，保证零伪造完成，原controller/effect继续按真实历史，不允许仅凭pending Promise 缺失就把已有work说成没执行。
- 合法的never-started回放始终先过完整 `cancellationFence` 和原始work比较，main与vendored都按 `assignment_id/lease_epoch/grant_version`形成和应用恢复摘要。具有相同ID/epoch但修改Grant、内容或path的取消不能越过这条围栏。
- 这些场景不称未知作业取消成立，也不声称已运行操作总能被撤回、SDK callback一定被取消、异常 effects 为零或全局 exactly-once。真实 DSH、Rust/Credential 等由各自独立harness验证。

## 实际 Rust 中心的丢失响应回放

```sh
node tests/runner/real-receipt-replay.mjs
```

本入口使用 **真正的 Rust Concierge** 与一个实际注册的 Node、项目绑定、Grant 和 Assignment，产生一次真实 controlled file effect。尚未修改 transport 实现；仅 driver 的注入 fetch 在收到真实 HTTP 200 之后隐藏响应。它随后：

1. 独立从中心 API 和 owned SQLite 验证第一次 Artifact/Report commit 与原始 receipt 确实发生；
2. 等真实持久 retry backoff，读回真实 NodeState、identity 和原始 pending outbox；
3. 以相同 request ID、logical digest、body、bytes 和 SHA 重放；中心分别返回 Artifact `duplicate:true` 与带原 receipt 的 Report `duplicate:true`；
4. 确认执行器仍仅调用一次，目标文件 hash、大小、inode 和时间戳保持；
5. 确认中心仍仅有一条 Artifact、Report、Effect、对应 request receipt/验收 audit，且 audit chain 验证通过。

这是本机单节点 **at-least-once + 对账** 的具体证据，不是物理远程、TLS、DSH SDK、Compose 或跨平台 exactly-once。实际 DSH 宿主的 install/register/Agent Tool/cancel/resume 与 scoped credential broker 仍各自通过 [../harness/EVIDENCE.md](../harness/EVIDENCE.md) 中的独立真实验收。
