# Loom Web

M0 Vue 3 + TypeScript + Vite 的响应式 Web 客户端。只消费 `/api/v1`，不连接数据库、DSH Profile 或本机目录。

## 运行与验证

需 Node.js 20.19+ / 22.12+ 和 pnpm。仓库根目录：

```sh
corepack pnpm install
corepack pnpm --dir apps/web dev
# Vite 将 /api 代理到 http://127.0.0.1:8787

corepack pnpm --dir apps/web typecheck
corepack pnpm --dir apps/web test
corepack pnpm --dir apps/web build
```

服务端实现按 `../../IMPLEMENTATION_PLAN.md` 启动后，在界面设置中输入已签发的 Client Token。令牌仅在用户手工保存时写入当前浏览器的 `loom.client-token` localStorage；项目不含默认 token。页面和选中 Ticket 的 ID 存于 `loom.selected-page`、`loom.selected-ticket`，展开偏好的短期回退为 `loom.preferences:*`。清除浏览器数据即可移除它们。

验证用 Vite 代理仅保证 HTTP 路径，**没有启动过真实 Concierge**，不能视作协议集成或真实 DSH 执行验证。无模拟 Worker、预置项目、假审批或假 Artifact。

## 使用方式

- **对话**：先通过管理对话框添加已存在目录，选择 `read_summary` / `edit_file`；安全相对路径用于读取（可选）/ 写入（必需）。从真实任务列表打开 Ticket，查看状态、证据、报告、Artifact、取消、重试、非敏感审批。
- **Activity**：只有明确展开过程才展示协作消息；发送者过滤与全局/单 Ticket 偏好走 `/preferences`。
- **设备**：节点、最后心跳、能力与信任缺口的只读展示；陈旧心跳不能当作在线。一次性配对码只用于注册。
- **项目**：授权目录注册与全局显示偏好；注册不等于 Grant。已有项目可通过「绑定本地节点资源」明确选择 Node、Worker，并原样提交项目根目录到 `POST /project-bindings`。绑定前节点必须在 `inventory.project_roots` 声明相同 Project ID → root 映射；缺节点、缺根目录或映射不一致均不假装注册成功。绑定确认成功后可前往权限页单独创建 Grant。
- **记忆**：手动新增、编辑、删除、按范围筛选，用户级作用域提交 `user`，永不创建 Grant。
- **权限**：创建 / 撤销 Grant 都有明确影响确认；读写通过 normalized array `operations: ["read_write"]` 明确包含读取和写入，只读为 `['read_summary']`。发现项目或绑定位置均不等于取得读取权限，没有自动管理员权限写入。
- **帮助**：M0 使用说明，认证过期、断网、手机作为客户端的边界。

## API 集成假设

严格遵循的根接口、状态与安全约束：`/projects` 的 `name/root/mode`；`/tickets` 的 `project_id/objective/kind/relative_path/content`；统一 `waiting_approval` 而非 `waiting`；`PATCH /memories/{id}` 提交更新后的完整 `content/project_id/scope`；`/grants/{id}/revoke`、ticket cancellation / response 不推定完成状态；`/preferences` 用相同 `ticket_id` query 对 GET / PUT。Artifact 可以通过已知 `artifact_id` 调取，内容在 `<pre>` 中插值，不渲染 HTML / 脚本。

下列对象字段在实现计划中未完全固定，因此有本地 TS interface，不应当视为 Rust 已冻结的 JSON protocol：

1. 列表接受裸数组或 `{projects|tickets|nodes|memories|grants|audit|entries|items|data: []}`。单对象创建 endpoint 返回直接对象。需以服务端 HttpResponse 实现为准。
2. `Bootstrap`: `protocol_version | version`、`principal` (`id/name/display_name`) 和 `default_ticket_id`。提供兼容读取后应固定为确切字段。
3. `Node`: `id/name/status/last_heartbeat/capabilities/trusted`。陈旧是 UI 的 90 秒提醒，不是权威调度结论。
4. `ApprovalRequest`: `summary/operation/reason`，POST 请求 `{id: crypto.randomUUID(), decision, reason}`。`approval` 内容需要后端补齐。
5. TNode/Report/Message `created_at`、Artifact `metadata.content.encoding.truncated`：按最朴素的对象形状解析；后端需要定义严格 schema。
6. `POST /enrollment-codes` 期望返回 `{code, expires_at}`，也允许 `enrollment_code`。若短时间配对的明文本身敏感，应只在成功注册响应中存储于组件内存，**非 localStorage**。
7. `Grant` 本地创建 body 为 `project_id,node_id?,operations`，`operations` 用数组；服务端当前也接受字符串 `read_write` 的兼容输入，但前端不使用此旧形状。创建前按项目绑定流程调用 `POST /project-bindings`，body 严格为 `project_id,node_id,worker_id,root_scope`；不补写管理员 token，不修改根目录，也不替用户默认选择节点。

错误读取 `{error:{code,message}}`，处理 401 / 403，不记录 token，不重试管理写。仅当前活跃 Ticket 每 12 秒查询详情；页面可见时不清空持久状态。没有请求队列、离线执行或 PWA 安装能力。

## 不作为验证证据的内容

- typecheck、构建、mock fetch 单测只覆盖浏览器的类型、打包与 HTTP 客户端行为。
- 尚未执行真实浏览器截图 / 响应式 UX feed、iOS Android、屏幕阅读器完整路径、Rust API、DSH plugin、真实文件写入、取消围栏、重启恢复或线上部署。
- 修改未经 git commit / push；本轮只改 `apps/web/**`，未更改根包元数据。
