# SourceInstance / Thread / Trigger — 当前受限入口

**入口：** `node tests/sources/events.mjs`，实际 Rust Concierge + SQLite + 真 HTTP，`LOCAL` ephemeral server/root only。

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

## v12、现有消息与旧任务

本次采用**additive源schema12**：添加 `source_instances`、`source_threads`、`source_events` 、 `source_event_cursors`，以及 nullable `messages.source_event_id`。现有 `source_ticket_id` 是任务证据 引用，而这里 SourceInstance/Trigger/Thread 是**入口身份**，二者不混淆。

`crates/concierge/src/source_events.rs` 的迁移测试涵盖实际 populated v11：存在Project、Grant、Ticket、Assignment、Artifact、Message，所有原ID/内容/grant digest/status 保持，Legacy message新 field是 null；schema 切到12后还能**再次打开同一store**而不被未来版本 误拒绝。更早快照即使原本没有messages table，也会**只创建符合既有消息结构的空表**（含可空 `source_event_id`），让后续Source ingestion真的有位置记录一条新message，而不虚构历史消息。已有表则保留原始内容和NULL relation，绝不把旧消息伪造成新Source；这种补DDL和现在可接收/重开场景也都有覆盖。未改变中央原任务权限、Grant/Artifact模型或DSH版本。不会额外写DSH Session/log或访问私有源提供方。

## 已执行与尚存边界

真实 driver 验证未认证拒绝、 同Source首建競争、读回与冲突、边界按钮uint duplicate、原Ticket状态/message与Artifact/grant不变化、另一个Source同eventId 同thread名独立、实际分页cursor、raw wildcard 拒绝、Source重新加入与重开一致、owned SQL行计数及audit verify。

它**尚未完成**：
- `Source user message → 授予任务的自动收款/意图识别`；当前明确 `task_created:false`，work必须独立核验现有Grant与project/root/worker。
- approval 作为安全命令的解释/代理/调度/OAuth；没有将 `source_key` 用作远端URI执行路径。
- 多 principal 的强度隔离 ；本切片面向当前已认证的单用户 client，不称通用多租户治理。查询/创建拥有current client来源，并将此映射再次带入一切ingest与preview。
- 真实 iOS/Android、锁屏/杀进程、多Host、TLS、physical inbox、真实计费模型 和多平台worker。
- 全自动或跨进程 aggressive exactly-once claims.`database error after persistence ⇒ receipt delivery unsure`时需看原event以及后续receipt，而不是宣 称未发生。

本轮不添加新UI 来源面板或消耗这一入口的自动执行驱动。需要实际把`source_event_id` 用显式用户提供工作与Grant去提交Ticket时，要保留这一不可变身份/核算关连并再次经过完整Ticket auth flow，不能借Source一条value把Grant做进 `content`。
