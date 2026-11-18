# SourceInstance / Thread / Trigger — 当前受限入口

**入口：** `node tests/sources/events.mjs`（接收/幂等/恢复）与 `node tests/sources/authorized-ticket.mjs`（显式授权工作/原子关联），实际 Rust Concierge + SQLite + 真 HTTP 与真实 Local Node，`LOCAL` ephemeral server/root only。

这是M0 **Source / Trigger / Thread 基础设施**，不是完整的意图解析、Agent 运行、真实联网消息接线或一个自动任务系统。

## 当前实现的协议边界

- `GET /sources` 也是**有界的**：`loom.source-list.v1` 默认50、最大100，按稳定的内部source ID排序。通过owner-scoped真实source ID作为`source_cursor`，只有该款锚点位于本client namespace时才继续，未知cursor显式拒绝；只有确有下一页时返回`next_cursor`，显式 `has_more`。不会返回无限source catalog或将partial page 假装成没有任何剩余。
- `POST /sources`：由当前已认证客户端登记 `loom.source-instance.v1`。`source_key` 为这个客户端命名空间内的opaque ID，默认/接受 kind `web`；不接受调用方指定 owner、角色、Grant、Agent、URI 或policy。`owner_key` 取自已认证客户端，不信任请求内身份标签。相同 `(owner, source_key)` 的规范注册是幂等并返回原记录；语义不同的kind或label是冲突。
- `POST /source-events`：接受**只** `loom.source-event.v1` 与 `kind:'user_message'` 的 typed JSON。必需 source_id、一个该Source下的`client_thread_id`、受限 external event ID 以及最多16,000字节的非空content。可选 `ticket_id` 只能实际存在、可在此当前用户工作空间引用的既有Ticket，**不会创建任务、新的 Assignment、授权、Agent 或 Artifact/Effect**。若给定 `occurred_at`，要求严格 RFC3339 有显式offset，解析并转UTC规范时间；它只算canonical payload，不决定权威顺序。未知字段、重复JSON key、owner型输入改标、错时间或类型都拒绝（格式一致JSON错误）。
- 事件的 `(source_id, external_event_id)` 唯一；子串/thread名只是namespace内的opaque ID，从属Source已先认证校验，外部event ID跨Source可以合理复用。同一key完全不同正文、时间、ticket或Thread重新绑定都是409，不能替换原immutable event。
- canonical payload由服务器校验和规范化后的字段计算，包含schema/kind/source/thread/external id、原content、optional ticket 与规范化occurrence time。不包含服务器签发的新Event UUID、接收时间或sequence/order/cursor。正确重复返回**原事件 ID、原始接收时间、digest、source/thread sequence与ticket引用**，并标 `duplicate:true`。相同但时区表示不同的实际时刻可规范成同一 canonical时间。输入的原始文本不会被无意拔字 或Unicode滑动。
- `source_threads`的 `(source_id, client_thread_id)` 唯一；内部`thread_id`是独立关联键而不是外面的名字。response/events 同时返回 `thread_id` 和真实 `client_thread_id`，不能把跨Source的两个 同样外部名字当作同一实体，或把外部thread变量当全局唯一字段。Failed validations、unknown Ticket、forbidden owner、冲突与 rollback 都不新建线程/事件或递增游标。
- Thread creation、Trigger record、SQLseq/cursor allocation和该事件一条 `messages` 记录在**同一个transaction**中。`messages.source_event_id`对Source新建消息关联该Trigger；Legacy message的该字段为NULL，原et连 grant/dedup semantics不得以旧数据冒充Source。 Registration & Source uniqueness受DB constraints保护。重复事件与重复Source不会多余插入message或回放历史请求。碰到insert失败，读取真实已提交原件，只有同一摘要才称idempotent，不把一切constraint errors当重复醟利。
- **范围内的并发/恢复**：真实 `tests/sources/events.mjs` 以当前单写者mutex/transaction 验证并发首建、exact编辑、clock/normalized UTC、冲突前后原记录与重开。不会生成分布式的跨进程Leader锁、网页source discovery或exactly-once承诺。
- **预览：** `GET /source-events` 要求明确 `source_id` 与 `thread_id`，设有缺省只读50、最大200。按source/server sequence而不是提供的发生时间做keyset读取，并返回 internal/client thread 信息。没有跨线程“自动展开所有”或星号 wildcard。
- `next_cursor` 是 服务保存的opaque cursor (`loom.source-page.v1`)，绑定owner、actual source、actual thread、schema及sequence，存进 `source_event_cursors`。使用后必须只传它（可加限 页数)；不能再替换source/thread/order，也不能跨过另一Source继续翻页。未知cursor、跨namespace cursor和过界 limit显式拒绝。Last item sourceServer seq才知道下一offset；不存在更多记录时没有铸造新cursor。分页读写仍在当前store事务中，保留并发后续插入的连续排序，不是把内存响应位置当成唯一事实。

## v13、现有消息、独立授权规格与旧任务

**additive源schema12** 添加 `source_instances`、`source_threads`、`source_events` 、 `source_event_cursors`，以及 nullable `messages.source_event_id`。现有 `source_ticket_id` 是任务证据引用，而这里 SourceInstance/Trigger/Thread 是**入口身份**，二者不混淆。

**schema13 再分开历史关系与授权建造：** 接收时可选的 `source_events.ticket_id` 永远是 `unverified_intake_reference`，不能用来申请或重放新工作。用户明确另外提交 `source_event_id + project + read_summary + 实际文件 + grant + 物理 Node/Worker` 之后，才从真实 Grant 派生它的 ProjectBinding/Node/Installation/root，重新校验 read operation 与全部 identity 才能创建一张新 Ticket。`loom.source-work-spec.v1` 持久保存及 canonically 固定这些字段、事件 ID/original digest 和新 Ticket ID；`task_ticket_id`、非空 `creation_kind=explicit_task_created_after_intake`、`task_digest/task_spec_json` 与不可变 `source_work_specs` 只表示这一新建工作关系，不会增加 Grant。

历史 Ticket 若有合法来源 spec，以同一输入再次提交只返回原 Ticket 与原始 digest，不新增 Assignment 或 Artifact；这是单写者 Source→Ticket 创建去重，不是“旧 Ticket 自动持续获准再次执行”、Agent 意图解释或跨机 exactly-once。后续 Grant 撤销不抹掉这段历史，但第一次新工作仍要求当时有效 grant 与 binding，旧 ticket reference 即便指向已完成普通 Task 也不能绕过。与 task 绑定后的 Source 原始身份/payload/thread/time/task spec 都禁止 SQL 改写、退绑或删掉来重新受理；内部路径不只依赖 Vue 隐藏按钮。

独立 spec+Ticket+Assignment+activity+Audit 使用同一 SQLite savepoint。**先真正校验**当前原 Grant/Binding/root/Worker/Installation，Node 离线时只可形成 `waiting_approval`，没有 Assignment；明确 `/approval` 和实际 poll 前都重新验这些范围及原 Node 可用情况，不能靠一个还未撤销的 Grant 而从另一根启动。

**明确人工决定的真实理由也有持久事实，而不只留在textarea。** 每次 `/approval` 的 `decision` 必须有对应的 `approval_id≤160` 与非空、trim后的 `reason≤1000 UTF-8字节`。Approve在同一当前Store事务中重新查询Ticket、冻结原Scope及实际 Grant/Binding/worker 可用性并发出0→1 的Assignment/Lease，随后同时写入`assignment.retried`（真实ID/epoch）和 `task.approval_granted`（实际approval_id、reason、assignment/lease、原始Grant/digest、无新Grant）。reject则只写 `task.approval_rejected` 带同一规范后的理由，**保持等待、零Assignment、没有取消/失败归因**；后续用户重新检查后可以另做一次新的approve，原hold记录不被覆盖。所有决定与审计、Task状态和新Lease必须在同一个事务中COMMIT，COMMIT只在写闭包完全成功后发生。任一授权校验、插入或audit失败均走回滚，不会先留下无记录的首次执行。普通failed retry的 `assignment.retried` 和 `ticket.retried` 也纳入相同原子边界。

理由按用户明确的选择以可读文字保存，不能把它解释成长期偏好、模型授权或信任凭据库。前端仍然选择当前同一 waiting Ticket并检查没有stop intent，延迟确认时若选择改变/状态改变/理由非法则不发起；界面明确说明理由进入可读审计而不应填Secret。`approval_id`是当前决定的相关ID，**不是一个服务端持久化审批实体或去掉重复执行的去重键**，更不能声称client失去重试响应后重放同一ID就自动幂等成功。typed错误仍保持原`403 grant_scope`及`409 approval_not_pending`，这也不把所有异常混成普通bad request，或让unknown outcome自动重发。实际owned SQL故障注入验证 grant/assignment与public retry的有关audit失败时Ticket原始Attempt、原Assignment及历史保持不变。

`crates/concierge/src/source_events.rs` 的迁移测试涵盖实际 populated v11：存在Project、Grant、Ticket、Assignment、Artifact、Message，所有原ID/内容/grant digest/status 保持，Legacy message新 field是 null；schema 经12增量到13后还能**再次打开同一store**而不被未来版本误拒绝。更早快照即使原本没有messages table，也会**只创建符合既有消息结构的空表**（含可空 `source_event_id`），让后续Source ingestion真的有位置记录一条新message，而不虚构历史消息。已有表则保留原始内容和NULL relation，绝不把旧消息伪造成新Source；这种补DDL和现在可接收/重开场景也都有覆盖。未改变中央原任务权限、Grant/Artifact模型或DSH版本。不会额外写DSH Session/log或访问私有源提供方。

## 已执行与尚存边界

真实 driver 验证未认证拒绝、 同Source首建競争、读回与冲突、边界按钮uint duplicate、原Ticket状态/message与Artifact/grant不变化、另一个Source同eventId 同thread名独立、实际分页cursor、raw wildcard 拒绝、Source重新加入与重开一致、owned SQL行计数及audit verify。

它**尚未完成**：
- `Source user message → 自动授予任务/意图识别/新的 Grant`；接收记录只记载输入。只有在下方显式业务规格再次提交时，work才独立核验已有Grant与project/root/worker。
- approval 作为安全命令的解释/代理/调度/OAuth；没有将 `source_key` 用作远端URI执行路径。
- 多 principal 的强度隔离 ；本切片面向当前已认证的单用户 client，不称通用多租户治理。查询/创建拥有current client来源，并将此映射再次带入一切ingest与preview。
- 真实 iOS/Android、锁屏/杀进程、多Host、TLS、physical inbox、真实计费模型 和多平台worker。
- 此 driver 的 restart 是 **Concierge重开**，不是 LocalNode/outbox重开；只有一个真实 Node / Installation，没有覆盖第二 Installation、真实多端Grant或Node身份隔离。未知请求有综合负例，但不称任意恶意JSON corpus、天然泛化source授权或安全多租户已经完成。
- 全自动或跨进程 aggressive exactly-once claims.`database error after persistence ⇒ receipt delivery unsure`时需看原event以及后续receipt，而不是宣 称未发生。

新增生产 Vue `SourceWorkPanel`：同一个受认证Source/thread的读取与历史展示，不把其中`visibility=private`的接收消息混入已过滤的Ticket Activity。打开/thread/记录均不发Ticket；回执显示真实event_id、`delivery_stage=recorded`和`task_created=false/permission_granted=false`。仍需用户对消息点选`基于此消息创建摘要`，再**人工选择**已有 read Grant、实际文件以及其绑定的物理Node/Worker安装，经过独立父ConfirmDialog确认才能提交 `source_event_id + exact objective + read_summary + 文件`。表单不是新Grant或自动意图解释；没有默认 path/Node/worker或root绑定。旧event的legacy ticket ID不能当 authority或替代选择。

Browser driver `node tests/sources/browser.mjs` 使用真实生产Vue、bundled static assets、独立Edge临时profile、Rust Concierge与真实LocalNode。它验证两个不同Source事件各自POST Ticket和独立原spec duplicate（均200），不会再次产生相关执行；其中第一Source故意失读→真实failed Report/outbox→用户显式retry→第二个Assignment成功。这个公共 retry 现在只允许真正failed且不带stop intent的原Ticket，沿原Grant与digest创建下一Attempt；旧Grant不可替换，reconciling/未开始/已停止或已成功的任意直接retry都不能利用同一分享签发逻辑另建Assignment或制造no-op成功审计。合法waiting_approval则独立经过现有source/human首批准路径后才首签。正常失败历史保留原failed Report，Artifact内容Sha与原input SHA分别计算而非复用一个字符串；后续workspace watcher不再有Producer副作用。现在还有第三张独立Source：先用owned离线fixture创建真实waiting_ticket（不签发Assignment），UI上填写**拒绝理由**并在父ConfirmDialog确认，等待态/零Effect/原始记录保留；然后由真实Node提交原ProjectRoot inventory的heartbeat恢复fresh placement，重新选择同意并填写**不同的批准理由**、再次确认，才出现只一个首Assignment/Lease，由真实Executor交付。两个不同opaque审批ID及理由都从真实审计逐项读出，而非从表单假装审计已保存。下载查看真实Artifact并验证input SHA、其Artifact/assignment元数据、原始source spec和Report一致，当前frontend的动作正文不再误以UID或顶层`assignment_id`字段取代真实展现层。

**历史 Source 消息的返回链路现已真实验收。** 曾出现已有 Source event 的“打开独立任务”确实读取了那张Ticket，但Source浮层仍然一直遮住它，等待审批的用户还必须自己首先关闭另一个modal才能查看或作决定。这是UI路由缺口，不是由同源Grant/Binding权限造成。新 `openSourceTicketId()` 沿用创建完成的同一条 close-then-selectTicket 路径，供历史 `task_ticket_id` 和完成的Ticket对象共同使用；历史链接仍只针对中心已持久化的 task ticket，不把未验证 legacy ticket ID当作关系或授权。Driver先正常创建第三张待审批Ticket，再显式关闭并重开同一个Source thread，像用户回看历史那样点击它的打开按钮，之后才验证modal消失、确切Ticket已加载且**审批按钮可见且实际hit-test通过**。在此期间`/tickets`创建POST与`/approval`决定POST均为零。随后才继续那两次已有明确reason的实际拒绝和新批准，不引入静默执行或替代Grant。之前的未修补Frontend在这个位置会因modal连续可见而超时，修复后的完整三源链已重新全部通过。实际的待审批历史入口也已通过严格浏览器idom检查，而非仅以一个读取回执说明用户看到了工作按钮。

最终是 **3 Tickets、4 Assignments、4 Reports（一次原failed及三次成功）、3 Artifacts、3 Effects、3 Source specs**（first失败→retry2票，second正常1票，第三次明确审批1票），audit链有效。两个既有Completed Ticket与批准的第三票随后撤权后仍只fencing Lease，不能新增第四票或改写旧hash/history；确认中替换当前Grant的负例同样无新Ticket。[真实三源与审批结果](/tmp/loom-approval-browser-result.json)。 backend实际HTTP与回滚另有[approved/rejected、reason及公共retry证明](/tmp/loom-approval-http-final-jrwOGs/result.json)。最初两个仅测试用字段accessor的问题（Project name与真实 project UUID、下载envelope中的`artifact.assignment_id`）已纠正后完整重跑退出0，没有以弱化比较去绕过它们。`owned_cleanup:true`移除了临时Profile、runtime root和相应的截图，因此引用的是JSON结果，不声称这些清理后的截图仍可读取。

另以当前桌面1280窗口和窄390**视口**验证详情、Artifact正文、Activity各有适当空间且没有横向overflow；这是**真实Edge桌面 viewport**，不是手机真机锁屏/杀进程/切网实验。两Error-free边界的Source screenshots随当然owned root清理删除；常规浏览器 `node tests/browser/run.mjs --keep-evidence` 的PASS证据（5图与result JSON）单独留下，不在仓库提交临时报告。票据生命周期统一先由真实受控结果/凭据和完整分数结束，源消息/收到 HTTP200不负责证明已完成。
