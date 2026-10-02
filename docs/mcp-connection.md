# personal-ops-mcp 连接指南(MCP-01)

personal-ops-mcp 是本应用的 stdio MCP 服务入口:复用与桌面端完全相同的 SQLite 运行库、
工具注册表与 ToolGateway,因此读工具的 schema 校验、幂等回执、观测轨迹,以及写操作的
"先提案、后人工批准"边界与桌面端完全一致。MCP 客户端不能绕过审批执行任何写操作。

## 启动命令(实测)

在项目根目录(开发版,需先 `npm run build` 生成 `out/`):

```bash
node_modules/electron/dist/electron.exe . --mcp --user-data <绝对目录>
```

PowerShell 形式(等价):

```powershell
Set-Location -LiteralPath 'D:/Chatgpt/待办'
node_modules\electron\dist\electron.exe . --mcp --user-data 'D:\absolute\path\to\mcp-profile'
```

参数说明:

| 参数 | 要求 | 说明 |
| --- | --- | --- |
| `.`(app 目录) | 必须为 app 目录方式启动 | 直接指定 `out/main/index.js` 会使 `app.getAppPath()` 解析到 `out/main`,sql.js WASM 资源路径错误而启动失败(已实测) |
| `--mcp` | — | 以 stdio MCP 服务运行:不创建窗口、不注册 GUI IPC;协议输出走 stdout,日志走 stderr |
| `--user-data <绝对目录>` | 必须绝对路径 | 独立用户目录;目录不存在会自动创建。**必须与桌面端日常使用的 `%APPDATA%\事务助手` 区分开**,避免 MCP 会话与桌面实例互相争锁或污染真实数据 |

实测环境:Windows x64、Electron 44.4.3；当前应用构建为 feat/agent-portfolio 的 2a75c25。实际zip解压包已从源码之外的cwd执行 `事务助手.exe --mcp --user-data <独立绝对目录>`，完成两次启动与EOF退出、读工具、pending写提案和伪造approved拒绝。提案重开仍为pending，业务写入为0；非空stdout行只包含匹配请求的JSON-RPC响应。证据在本机 artifacts/acceptance/adc-rc1-20261002/T06/packaged-mcp.json，构建与包范围见 [当前交付记录](acceptance/rc1-20261002.md)。

## 独立 userData 与单实例约束

- MCP 模式复用产品单实例锁:同一 userData 已有运行中的桌面实例时,MCP 进程无法获取锁,
  在 stderr 输出 `[mcp] 无法获取单实例锁:同一 userData 已有运行中的应用;MCP 模式需独占用户目录` 后退出。
- 因此给 MCP 客户端配置**专用的独立 userData 目录**;桌面端要用同一目录查看/审批 MCP 提案时,
  先退出 MCP 会话,再用 `--user-data` 指向同一目录启动桌面端。

## 可用工具清单(经同一注册表 schema 与网关执行)

| MCP 工具 | 内部工具 | 风险 | 行为 |
| --- | --- | --- | --- |
| `list_todos` | `todo.list` | 读 | 直接执行,结果落观测轨迹;可按 status/priority 过滤 |
| `create_todo` | `todo.create` | 写 | 只创建待批准提案,返回 `approvalId`;**不写入** todos |
| `list_calendar_events` | `calendar.list` | 读 | 直接执行,可指定起止日期(YYYY-MM-DD,含端点) |
| `create_calendar_event` | `calendar.create_event` | 写 | 只创建待批准提案;开始时间必须晚于当前计划时间,否则拒绝 |

审批边界(参数级强制):

- 写工具调用返回 `{runId, approvalId, confirmationId, status:"awaiting_confirmation"}`,
  其中 `approvalId` 与 `confirmationId` 同值(内部审批记录 ID),此时业务表**零写入**;
- 客户端在 arguments 里携带 `approved` 键(无论值是 true/false/其他)一律拒绝,
  返回 `isError:true` 与提示"不允许声明 approved;写操作必须经应用界面批准";
- 不存在任何自动批准参数;写操作只有在审批记录被决定为 approved 后,
  经运行调度器执行,且执行时校验参数 hash、计划版本、目标版本与有效期。

## 审批入口(桌面端)

MCP 创建的提案落在同一 SQLite 的 `agent_runs`(状态 `awaiting_confirmation`,输入显示为
`(MCP 提案)todo.create` 等)与 `approvals`(`decision = pending`)表中:

1. 退出 MCP 会话(或使用桌面端独立目录时切换目录),用同一 userData 启动桌面端
   (`npm run preview -- --user-data <同一绝对目录>` 或打包版对应方式);
2. 打开 Agent 工作台,在运行列表找到该运行(输入形如 `(MCP 提案)create_todo`),
   运行详情中对待批准提案选择批准或拒绝;
3. 批准后由调度器按队列执行,写入一次并记录轨迹;拒绝则零写入,运行按失败收尾。

MCP 协议侧不提供任何批准/拒绝方法,批准只能来自应用界面。

## 客户端配置样例

stdio 型 MCP 客户端(以 Claude Desktop 的 `mcpServers` 配置为例;命令已按上述实测形态给出,
未在 Claude Desktop 内逐项复验,协议层验证见下节):

```json
{
  "mcpServers": {
    "personal-ops": {
      "command": "D:/Chatgpt/待办/node_modules/electron/dist/electron.exe",
      "args": [".", "--mcp", "--user-data", "D:/mcp-profile/personal-ops"],
      "cwd": "D:/Chatgpt/待办"
    }
  }
}
```

要点:`args` 的第一项必须是 app 目录(`.` 或项目绝对路径),`cwd` 必须是项目根,
`--user-data` 必须是独立绝对目录。打包版路径替换为解压后 exe 的绝对路径(待 PKG-01 验证)。

## 成功连接实测记录

以下为 2026-10-01 实测摘录(完整样例:
`artifacts/project-completion-2026-09-30/delivery/mcp-01-protocol-sample.log`,
进程级测试:`tests/mcp/startup.test.ts`,日志:`delivery/mcp-01.log`)。
发送内容为按行写入 stdin 的 JSON-RPC,`OUT|` 为进程 stdout 原样输出:

```text
# 命令: electron . --mcp --user-data C:\...\Temp\mcp-capture-tUubRF
OUT| {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"personal-ops-mcp","version":"0.1.0"}}}
OUT| {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"list_todos",...},{"name":"create_todo",...},{"name":"list_calendar_events",...},{"name":"create_calendar_event",...}]}}
OUT| {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"todos\":[...演示种子待办...]}"}],"isError":false}}
OUT| {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"解析错误"}}
OUT| {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"{\"runId\":\"ce584342c4333864de61\",\"approvalId\":\"6af1c47944b10bb890e9\",\"confirmationId\":\"6af1c47944b10bb890e9\",\"status\":\"awaiting_confirmation\"}"}],"isError":false}}
OUT| {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"不允许声明 approved;写操作必须经应用界面批准"}],"isError":true}}
# 关闭 stdin 后进程退出:EXIT code=0
```

对应磁盘校验(进程级测试断言):`approvals` 表恰好新增一条 `decision='pending'` 记录,
其 `approval_id` 等于响应中的 `approvalId`;`todos` 表没有提案标题对应的行(业务零写入);
`trace_events` 出现读工具的 `tool_call` 观测事件;重启同一 userData 后提案仍为 pending。

## 已知限制

- **启动目录日志污染 stdout(接线差距)**:index.ts 的
  `console.log('[startup] 使用隔离用户目录:...')` 写到 stdout,出现在协议流最前部;
  严格解析 stdout 的客户端会把它当非法行。应改为 stderr(整合者接线,待修复)。
- **Electron Windows 主进程 stdin 限制**:Electron 主进程(Windows)的 `process.stdin`
  被读取即合成 end(实测 Electron 44)。server.ts 在注入通道首读即 EOF 时自动改用
  独立 fd 0 流兜底收行;若未来 index.ts 直接以 fd 0 流接线,可移除该兜底。
- EOF(客户端关闭 stdin)后服务落盘自身写入并退出(实测退出码 0);
  打包版启动命令与截图连接记录待 PKG-01/PORT-01 补充。
