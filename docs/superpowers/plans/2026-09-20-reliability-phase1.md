# S1 可靠性底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Windows 本地应用上完成 R1—R10 的可验证修复，建立 S1 必需的错误、事务、持久化、安全、基准与 CI 底座。

**Architecture:** 保留 Electron、sql.js 与现有页面；主进程集中校验权限、时间和写入，数据库以有版本迁移和操作回执承接修改命令。邮箱按账号生命周期隔离任务，事件以会话及运行标识隔离；测试均使用临时数据库、假会话和假网络。

**Tech Stack:** Electron 37.10.3 审查基线、React 19、TypeScript、sql.js、Vitest、electron-vite。依赖目标版本以实施时仍受支持的稳定版本及锁文件审计为准。

**Spec:** [技术设计与实施路线](../../技术设计与实施路线.md) 第 2、4、11、13、14 节及 [数据契约与验收细则](../../数据契约与验收细则.md) 第 1、3、4、6、8 节。下文“现有”指本计划编写时源码已存在；“拟议”指 S1 实施时才引入，不应当作已有导出。

## Global Constraints

应用审查基线为 0.1.0、schema v3。普通写入保留 400ms 合并，最长 2 秒尝试落盘；失败重试间隔为 1、5、30 秒，其后每 30 秒。关键命令只有事务提交且落盘成功才返回成功。提醒按 `fireAt ∈ [now - 24h, now]` 过滤。IMAP 初始窗口为最近 30 天。网页抓取按解码后响应流限制 2 MiB。邮箱、模型、用户数据库和生产 API 均不能进入自动测试。

本阶段覆盖 R1—R10，O3/O4/O5 的基础部分及 O2 的基准采集。O1/O6 与 O2—O5 的后续功能验收属于 S2—S5；F1/F2/F4/F6/F7/F8/F9/F11/F12 的完整功能不进入 S1。M1 只增修订号、操作回执、持久化和生命周期元数据；`action_candidates`、`entity_changes`、周期、提醒中心、隐私审计及 Gmail 新表须等所属阶段。S1 仅准备后续任务必需的 `operationId`、`expectedRevision`、`workspaceEpoch`、错误和事务契约。普通日程查询使用半开区间 `[start,end)`，旧无时区本地日期保持原语义，经集中转换才进入 UTC 毫秒级提醒调度。实施数据库结构变更、核心依赖升级前，按项目危险操作规则确认具体影响；本计划编写本身不执行这些操作。

## 文件责任与实施顺序

`src/main/db/connection.ts` 只管 sql.js 打开、原子文件替换与保存状态；`src/main/db/schema.ts`、拟议 `src/main/db/migrations/` 管版本迁移；拟议 `src/main/db/operations.ts` 管操作回执及条件更新。`src/main/services/backup.ts` 管导入验证和恢复排他边界，`src/main/security/` 管 IPC 来源与网页地址，`src/main/services/reminder.ts` 管扫描。`src/main/mail/sync.ts`、`scheduler.ts`、`service.ts` 分别管游标、账号运行任务和生命周期接线。`src/shared/operations.ts` 是拟议公共结果契约；`src/main/ipc.ts`、`src/main/index.ts`、`src/main/windows.ts`、`src/preload/index.ts` 是串行集成入口，不分配并行写入。`tests/helpers.ts` 的 `makeTestDb()` 始终创建当前 schema，`tests/mail/fakeSession.ts` 的 `FakeSession` / `makeEnvelope` 和各 UI 测试的 `window.api` 替身可复用。v3 迁移必须冻结旧版独立夹具；真实落盘测试另建临时文件夹并重新 `openDatabase`。

任务 1 建立基线，任务 2—3 固定写入契约，任务 4—7 可在共享入口外并行，任务 8—11 分别落实时间、会话和邮箱，任务 12 串行集成。共享入口和锁文件只由集成人员写。每项先验证失败原因，再实现、验证和独立审查。FastCtx 命令使用非交互 POSIX bash；后台单元测试默认使用 `timeout --kill-after=5s 60s npm test` 或 `timeout --kill-after=5s 60s npx vitest run tests/reminderBackup.test.ts`。先确认环境支持这些 timeout 选项；缺少时使用受控进程包装器，不能以工具等待时限代替进程超时。退出码 124/137 单独记录为超时，慢套件按文件拆分或注明上限调整。类型检查、构建和打包按实际耗时单独设限。

### Task 1: 固定 S1 基线与安全升级路径（O2/O5）

**Files:** 新建 `tests/performance/baseline.test.ts`、`scripts/measure-baseline.mjs`、`.github/workflows/ci.yml`；修改 `package.json`、`package-lock.json`（仅经具体升级确认后）。现有入口 `vitest.config.ts`、`scripts/check-build.mjs`、`tests/desktop/packaging.test.ts`。

**Interfaces:** 测量脚本拟议支持 `node scripts/measure-baseline.mjs --output <path>`，只生成固定合成数据与 JSON 记录：Node/sql.js 版本、样本规模、预热次数、查询 P50/P95。该结果仅是 Node 中的 sql.js 查询基准，不是 Electron 主进程延迟或 Windows 主线程阻塞指标；暖态查询 P95 300ms 与交互连续阻塞 100ms 的验收需在真实 Windows/Electron runtime 单独采集环境、版本和 trace。不得读取真实 `userData`。

- [ ] Step 1：先记录 `npm test`、`npm run typecheck`、`npm run build`、`npm audit --json` 的输出与环境；审计逐条记录受影响包、依赖路径、是否进入打包产物，不能把审查时“4 个包”视为当前结果。
- [ ] Step 2：写失败测试，使用固定种子建立事件、待办和邮件样本；例如 `expect(report.dataset.events).toBe(10_000)`、`expect(report.measurements.eventsRange.p95Ms).toBeGreaterThanOrEqual(0)`、`expect(report.environment.node).toBeTruthy()`。先运行 `npx vitest run tests/performance/baseline.test.ts`，预期因脚本/报告入口缺失失败。
- [ ] Step 3：实现测量器与 CI。CI 在干净 Windows 运行 `npm ci`、`npm test`、`npm run typecheck`、`npm run build`；Node 基准只留数据，不冒充未测量的 Electron 300ms/100ms 目标。真实 Windows/Electron 指标列为后续真机验收记录；引入 lint/format 脚本时先限定触及文件，避免无关全库改写。
- [ ] Step 4：在获准的具体版本清单上升级受影响依赖与仍受支持的 Electron 稳定版，审查 `npm audit` 与打包后 WASM/资源路径；运行同一套测试和构建，记录升级前后差异及剩余风险。验收为可复跑的基准 JSON、CI 配置、锁文件一致，且无未经解释的审计发现。

### Task 2: 有版本迁移、回执与修订号（R7 前置，O3）

**Files:** 修改 `src/main/db/schema.ts`、`src/main/db/dao.ts`、`src/shared/api.ts`、`src/shared/types.ts`；新建 `src/main/db/migrations/m1.ts`、`src/main/db/operations.ts`、`src/shared/operations.ts`、`tests/fixtures/schema-v3.sql`、`tests/db/migrations.test.ts`、`tests/db/operations.test.ts`。现有 `initSchema` 位于 `dao.ts:38`，`makeTestDb` 位于 `tests/helpers.ts`。实际 schema 数字由集成人员按合入顺序唯一分配。

**Interfaces:** 拟议 `runOperation<T>(db: SqliteDb, input: {operationId: string; command:string; requestHash: string; expectedRevision?: number; workspaceEpoch:string}, apply: () => T): {value:T; replayed:boolean}` 是关键命令唯一事务拥有者：来源/结构/epoch 边界校验后先查幂等回执，再在一次 `db.transaction` 内校验 revision、运行无独立 `BEGIN` 的 `apply` 并写回执。`commitCritical` 只协调这次已提交事务的持久化，不再开启事务；复合 DAO 调用需提供不嵌套事务的内部方法。相同 ID/规范化摘要返回同一结果，包括原 revision 已过期时；不同摘要返回 `CONFLICT`。`events`、`todos`、`pending_items` 拟增 `revision INTEGER NOT NULL DEFAULT 1`；条件更新失败返回 `CONFLICT`。`operation_receipts` 保存 operation_id、command、request_hash、result_ref、created_at，不存请求全文或凭据。回执与业务数据同事务，不能独立保证未落盘事务。

来源、结构、epoch 检查由主进程边界在调用前完成；`runOperation` 首先查回执，再在同一事务内进行 revision 条件更新、业务写入及回执插入。新增只读 `getWorkspaceEpoch(): Promise<string>` 供可信窗口初始化与恢复后刷新，同步修改 `src/main/ipc.ts` 和 `src/preload/index.ts`；数据库内部函数的单元测试直接传已通过边界检查的命令，边界拒绝另由 IPC 测试覆盖。

- [ ] Step 1：冻结 `tests/fixtures/schema-v3.sql` 与代表性 v3 行（空库、已确认邮件、多待办共用日程、旧提醒、损坏引用）；由旧版夹具显式创建库并写 `schema_version=3`，不得用会随当前 schema 更新的 `makeTestDb()` 伪装旧库。迁移测试用 `PRAGMA table_info(events)` 断言含 `revision`，重复初始化仍只有一列；操作测试断言同 ID/同摘要重试返回首次引用与 `replayed:true`，即使原 revision 已过期，异摘要返回 `CONFLICT`。先运行 `npx vitest run tests/db/migrations.test.ts tests/db/operations.test.ts`，预期缺列/缺接口失败。
- [ ] Step 2：按 v3→M1 的已分配 schema 版本单次事务迁移并新增 `operation_receipts`，升级版本只在成功提交后发生；用 `PRAGMA table_info` 防重复加列，保留现有 mail v2/v3 迁移路径，拒绝未来 schema。旧 ID 与行数不变；回执摘要使用稳定规范化请求，排除 epoch、密钥及日志字段，结果按可恢复引用存储。迁移前停业务并留一致恢复点，完成持久化后才开窗口。
- [ ] Step 3：再测中途异常回滚、重复启动、旧关系未丢和未来版本拒绝。验收命令 `npx vitest run tests/db/migrations.test.ts tests/db/operations.test.ts tests/mail/migration.test.ts tests/db/rowMapping.test.ts`；迁移后的备份版本处理由任务 4 同步。

### Task 3: 可确认落盘与可重试错误（R2/O4）

**Files:** 修改 `src/main/db/connection.ts`、`src/main/index.ts`、`src/main/ipc.ts`、`src/shared/api.ts`、`src/renderer/workbench/pages/CalendarPage.tsx`；新建 `tests/db/persistence.test.ts`、`tests/ui/persistFailure.test.tsx`。现有 `SqliteDb.flush(): void`、`openDatabase` 的保存器见 `connection.ts:68,82`。

**Interfaces:** 拟议主进程协调器 `commitCritical<T>(operationId:string, result:T): Promise<T>` 只对 `runOperation` 已提交的唯一事务执行原子落盘并在成功后 resolve，不再调用业务 `work` 或嵌套 `BEGIN`；`SqliteDb` 提供保存原语，业务写入、恢复、迁移和退出都经过协调器。保存状态为 `dirty|saving|saved|failed` 加写入代数，`subscribePersistState(listener)` 对 UI 提供可见状态。`PERSIST_FAILED` 携带 operationId 与“保存未确认”；进程内同 ID 优先重试保存，重启后只查磁盘库及其中回执：有回执返回已落盘结果，无回执需重读现状后才允许以同 ID 重试，不能假设内存状态复活。

- [ ] Step 1：用临时目录、注入文件操作故障写失败测试。拟议 `openDatabase` 增加可选文件操作注入参数，测试仅在该实例拒绝临时文件写入；一次 `runOperation` 在内存事务提交后，`commitCritical('op-1', result)` 应拒绝并带 `PERSIST_FAILED` 与原 operationId。恢复写入后同 ID 重试只产生一行，重新 `openDatabase` 能读回；另测试重启后磁盘无回执，绝不把原内存回执当已成功。先运行 `npx vitest run tests/db/persistence.test.ts`，预期缺 API 或错误未上抛。
- [ ] Step 2：实现保存状态、400ms 合并、2 秒最长等待、1/5/30/30 秒重试、临时文件刷新与替换；成功只清除已落盘代数。失败不要静默吞掉，也不要先显示“已保存”或触发依赖该结果的自动操作。设置写故障、替换故障、损坏主文件与残留临时文件的恢复规则；失败期间只读可用，显式救援导出必须标为“内存状态尚未持久化，可能不完整”。
- [ ] Step 3：主进程返回稳定错误码并广播保存状态；页面失败时保持编辑内容和重试入口。测试 `npx vitest run tests/db/persistence.test.ts tests/ui/persistFailure.test.tsx tests/ui/errorHandling.test.tsx`，再运行 `npm run typecheck`。验收包括成功命令重开库可见，失败命令 UI 明确标识未确认且不重复创建。

### Task 4: 备份先验校验与失败回滚（R1）

**Files:** 修改 `src/main/services/backup.ts`、`src/main/ipc.ts`；新建 `src/main/backup/validate.ts`、`tests/backup/validation.test.ts`、`tests/backup/recovery.test.ts`；扩展 `tests/reminderBackup.test.ts`。现有 `importBackup` 在 `backup.ts:67`，会跳过缺表并以 `INSERT OR REPLACE` 写入。

**Interfaces:** 拟议 `validateBackup(raw:unknown, supportedVersions:readonly number[]): ValidatedBackup`，按文件自身已知版本校验当时必需的业务表、列型、主键与引用，允许完整空库；当前格式覆盖全部已实现业务表，不能把旧 JSON 缺少未来清单或新表判作坏文件。`restoreBackup(db, backup): Promise<{imported:Record<string,number>}>` 由协调器建立排他窗口：先阻止新写入、取消外部请求、提升 workspaceEpoch、等待已接受事务排空并落盘，然后才建立恢复前快照并替换。

- [ ] Step 1：用 `makeTestDb()` 预置一条待办，分别输入 `{tables:{}}`、缺 `events`、高版本、坏行与合法全空表。关键断言如下；`invalidPath` 是测试临时目录中的 JSON 文件。先运行 `npx vitest run tests/backup/validation.test.ts`，预期缺表/版本案例失败。

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTodo, listTodos } from '../../src/main/db/dao'
import { importBackup } from '../../src/main/services/backup'
import { makeTestDb } from '../helpers'

it('R1: 缺表备份在替换前拒绝且原待办仍在', async () => {
  const db = await makeTestDb()
  const existingTodo = createTodo(db, { title: '保留我' })
  const invalidPath = join(mkdtempSync(join(tmpdir(), 'backup-invalid-')), 'missing.json')
  writeFileSync(invalidPath, JSON.stringify({
    app: 'ai-desk-companion', schemaVersion: 3,
    exportedAt: '2026-09-20T00:00:00.000Z', tables: {}
  }))
  expect(() => importBackup(db, invalidPath)).toThrow()
  expect(listTodos(db).map((item) => item.id)).toEqual([existingTodo.id])
})
```
- [ ] Step 2：对完整结构逐表校验，按依赖顺序写入并以事务回滚处理行错误；识别当前备份版本及受支持的 v3 旧备份并受控迁移，未来版本拒绝。恢复保存失败须回到前快照，不能让 UI 留在半恢复状态；恢复结束刷新所有窗口的 revision/epoch。导出仍排除密钥与邮箱账号/缓存；回执随其引用的业务实体恢复，旧 JSON 无回执时不伪造。
- [ ] Step 3：模拟数据库替换失败和恢复中断，并测试“旧异步写入被门控后才取恢复前快照”，确认原库、内存和磁盘重开一致。运行 `npx vitest run tests/backup/validation.test.ts tests/backup/recovery.test.ts tests/reminderBackup.test.ts`。附件打包/路径穿越属于 F8 完整恢复阶段，S1 只守住当前 JSON 备份边界。

### Task 5: 页面与 IPC 权限（R3）

**Files:** 修改 `src/main/windows.ts`、`src/main/ipc.ts`、`src/main/index.ts`、`src/main/appearance/ipc.ts`、`src/preload/index.ts`；新建 `src/main/security/ipcPolicy.ts`、`tests/window/ipcPolicy.test.ts`；扩展 `tests/window/hardenWebContents.test.ts`、`tests/preload/onWhitelist.test.ts`。

**Interfaces:** 拟议 `authorizeIpc(event: IpcMainInvokeEvent, channel:string, windows:WindowRegistry): boolean` 必须验证登记窗口的 webContents、`senderFrame` 存在且等于当前 mainFrame、解析后的精确页面 URL 与窗口能力表。工作台可执行业务修改；桌宠仅材料接收/显示/拖动；面板默认只读。未知 frame 一律拒绝。

- [ ] Step 1：构造假窗口/假 frame 测试外部 `file:` 页面、开发态同前缀恶意主机、子 frame、未登记窗口调用 `events:create` 与 `backup:import` 均返回 `FORBIDDEN`。现有 `hardenWebContents` 和 `onWhitelist` 测试可复用事件监听替身；先运行 `npx vitest run tests/window/ipcPolicy.test.ts tests/window/hardenWebContents.test.ts`。
- [ ] Step 2：将生产页面限制为应用目录内精确 `workbench.html`、`pet.html`、`panel.html`；开发态比较 URL 的协议、主机、端口和路径。所有 `ipcMain.handle` 与外观处理器调用同一策略，preload 仅对合格文档公开必要接口。拒绝日志记录 channel 与原因，不含请求参数。
- [ ] Step 3：运行 `npx vitest run tests/window/ipcPolicy.test.ts tests/window/hardenWebContents.test.ts tests/preload/onWhitelist.test.ts tests/appearance/ipc.test.ts` 与 `npm run typecheck`。验收是未授权零业务副作用，合法窗口现有操作仍可调用。

### Task 6: 模型密钥与邮箱凭据边界（R4）

**Files:** 修改 `src/main/keys.ts`、`src/main/db/dao.ts`、`src/main/ipc.ts`、`src/main/mail/accounts.ts`；新建 `tests/keysMigration.test.ts`；扩展 `tests/keys.test.ts`、`tests/mail/security.test.ts`。现有 `encryptApiKey` 在加密不可用时写 `plain:`；邮箱 `encryptCredential` 已拒绝降级。

**Interfaces:** 拟议 `encryptApiKey(plain:string): string` 在安全存储不可用时抛内部加密异常，公共层映射为 `AppError{code:'AUTH_REQUIRED',retryable:false}` 并以脱敏 detail 说明安全存储不可用；`migrateLegacyProviderKeys(db, storage): {migrated:number; pending:number}` 只在加密可用时事务化替换历史 `plain:`。不可用时历史记录标为待处理、不能经模型路由继续使用；新输入若允许内存会话使用，不可写库。

- [ ] Step 1：把现有“`plain:` 可还原”的测试改为安全要求：`expect(() => encryptApiKey('secret')).toThrow()`；已有 `plain:` 加密可用时迁移后数据库不含此前字符串，不可用时 `getProviderApiKey` 不产生可用明文。先运行 `npx vitest run tests/keys.test.ts tests/keysMigration.test.ts`，预期旧降级路径导致失败。
- [ ] Step 2：消除新明文持久化，迁移在独立事务中完成；保留原始值到加密成功才替换，失败能重试。复查邮箱 `credential_enc` 及模型密钥的备份、日志、IPC 返回值，禁止可还原凭据泄漏。
- [ ] Step 3：运行 `npx vitest run tests/keys.test.ts tests/keysMigration.test.ts tests/mail/security.test.ts tests/reminderBackup.test.ts`。验收是安全存储不可用时保存被明确拒绝、历史数据无静默丢失、迁移后仍可使用加密密钥。

### Task 7: 网页抓取逐跳地址和流大小（R5）

**Files:** 修改 `src/main/services/urlFetch.ts`；新建 `src/main/security/urlPolicy.ts`、`tests/urlPolicy.test.ts`；扩展 `tests/urlFetch.test.ts`。现有 `createUrlFetcher` 允许自动重定向，`arrayBuffer()` 全量读取后截断。

**Interfaces:** 拟议 `assertPublicHttpTarget(url:URL, resolved:readonly string[]): void` 拒绝 IPv4/IPv6、映射地址中的环回、私网、链路本地、多播、未指定和保留段；拟议抓取 transport 必须把 DNS 校验结果绑定实际连接地址，逐跳手动重定向，并按解码后的响应流累计最多 2 MiB。单纯先 `dns.lookup` 再普通 `fetch` 不满足防重绑定要求。

- [ ] Step 1：用可注入 transport 假实现测试 `http://127.0.0.1`、`[::1]`、IPv4-mapped 私网、公共地址 302→内网、DNS 校验后连接改向内网均拒绝；构造分块/压缩响应超过上限，断言读取提前中止。先运行 `npx vitest run tests/urlPolicy.test.ts tests/urlFetch.test.ts`，预期旧实现的内网和全量缓冲案例失败。
- [ ] Step 2：实现最多限定次数的逐跳处理、每跳重新解析与连接绑定；`Content-Length` 仅作提前拒绝，响应流限制实际解码字节。保留 HTTP(S) 与文本 MIME 校验、超时提示，错误不回显敏感 URL 参数。
- [ ] Step 3：运行 `npx vitest run tests/urlPolicy.test.ts tests/urlFetch.test.ts tests/urlText.test.ts`。验收是无绕过连接、超限不全量入内存；本地模型服务端点走独立配置域，不放宽网页策略。

### Task 8: 日程输入与原子转换（R7）

**Files:** 修改 `src/main/db/dao.ts`、`src/main/services/engine.ts`、`src/main/ipc.ts`、`src/renderer/workbench/pages/CalendarPage.tsx`、`src/renderer/workbench/pages/PendingPage.tsx`、`src/shared/api.ts`、`src/preload/index.ts`；新建 `src/main/planning/eventValidation.ts`、`tests/planning/eventValidation.test.ts`、`tests/planning/confirmAtomic.test.ts`、`tests/ui/pendingConversion.test.tsx`；扩展 `tests/extractionImport.test.ts`。现有 `PendingPage.tsx:30-40` 连续调用 `createEvent` / `updatePending`，`nextHourSlot()` 被调用两次且起止落在同一整点。

**Interfaces:** 拟议 `validateEventInput(input:EventInput): ValidatedEventInput` 校验标题、可解析日期、`endAt > startAt`；全天按本地日期与排他结束日解析。缺结束时间只在编辑预览提出 30 分钟建议，用户确认后写入。拟议 IPC `resolveExistingPending(command:{context:MutationContext;pendingId:string;decision:'create_event'|'create_todo';event?:EventInput;todo?:TodoInput}): Promise<Result<{pendingId:string;targetId:string}>>` 调用拟议 `resolveExistingPendingInDb(db:SqliteDb, command): {pendingId:string;targetId:string}`。它是 S1 仅供现有 PendingPage 转换使用的原子主进程命令，事务所有权在 `runOperation`，先创建目标再更新该 pending 为 handled；失败回滚二者。完整 F2 的候选身份、来源快照和工作台 API 留待 S2，不在 S1 建 `action_candidates`。

- [ ] Step 1：在 `makeTestDb()` 上测试空标题、`startAt` 无效、相等/倒置区间均不插入；注入 pending 状态更新失败后断言目标创建也回滚。UI 失败测试直接复现现有 PendingPage：点击“转为日程”应只调用原子命令一次，不调用两条旧 IPC，且传入非零时长。先运行 `npx vitest run tests/planning/eventValidation.test.ts tests/planning/confirmAtomic.test.ts tests/ui/pendingConversion.test.tsx`，预期旧代码失败。

```tsx
// tests/ui/pendingConversion.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import React from 'react'
import { PendingPage } from '../../src/renderer/workbench/pages/PendingPage'

afterEach(cleanup)
it('R7: 待处理转日程使用一次原子命令且结束晚于开始', async () => {
  const resolveExistingPending = vi.fn(async (_input: unknown) => ({
    ok: true, value: { pendingId: 'p1', targetId: 'e1' }
  }))
  const createEvent = vi.fn()
  const updatePending = vi.fn()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    listPending: vi.fn(async () => [{
      id: 'p1', title: '整理材料', notes: null, status: 'open', revision: 1,
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z'
    }]),
    getWorkspaceEpoch: vi.fn(async () => 'epoch-1'),
    resolveExistingPending, createEvent, updatePending, on: vi.fn(() => () => {})
  }
  render(<PendingPage refreshKey={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '转为日程' }))
  const preview = await screen.findByRole('dialog', { name: '转换为日程' })
  expect(resolveExistingPending).not.toHaveBeenCalled()
  fireEvent.click(within(preview).getByRole('button', { name: '确认加入日历' }))
  await vi.waitFor(() => expect(resolveExistingPending).toHaveBeenCalledTimes(1))
  const command = resolveExistingPending.mock.calls[0][0] as { event: { startAt: string; endAt: string } }
  expect(new Date(command.event.endAt).getTime()).toBeGreaterThan(new Date(command.event.startAt).getTime())
  expect(createEvent).not.toHaveBeenCalled()
  expect(updatePending).not.toHaveBeenCalled()
})
```

- [ ] Step 1b：同一轮补后端原子回滚失败测试。下段放入 `tests/planning/confirmAtomic.test.ts`；`resolveExistingPendingInDb` 是本任务拟议实现，未实现时导入先红。SQLite trigger 强制 pending 更新失败，断言先创建的事件随唯一业务事务一起撤销。

```ts
import { expect, it } from 'vitest'
import { insertPending } from '../../src/main/db/dao'
import { resolveExistingPendingInDb } from '../../src/main/planning/resolveExistingPending'
import { makeTestDb } from '../helpers'

it('R7: pending 状态更新失败时不留下孤立事件', async () => {
  const db = await makeTestDb()
  const pending = insertPending(db, { title: '整理材料' })
  db.run("CREATE TRIGGER reject_pending BEFORE UPDATE ON pending_items BEGIN SELECT RAISE(ABORT, 'forced pending failure'); END")
  const command = {
    context: { operationId: 'op-p1', expectedRevision: 1, workspaceEpoch: 'epoch-1' },
    pendingId: pending.id, decision: 'create_event' as const,
    event: { title: '整理材料', startAt: '2026-09-20T13:00', endAt: '2026-09-20T13:30' }
  }
  expect(() => resolveExistingPendingInDb(db, command)).toThrow()
  expect(db.all("SELECT id FROM events WHERE title = '整理材料'")).toHaveLength(0)
  expect(db.get<{ status: string }>('SELECT status FROM pending_items WHERE id = ?', [pending.id])?.status).toBe('open')
})
```

- [ ] Step 2：新增 `src/main/planning/resolveExistingPending.ts` 承载上述原子命令；校验集中在主进程入口。点击“转为日程”打开名为“转换为日程”的预览对话框，提供带标签的标题、开始时间和结束时间字段，建议 30 分钟；点击“确认加入日历”才提交，取消不落库。PendingPage 一次计算时段，读取 revision/epoch 后调用原子命令。内部更新不得自行 BEGIN；错误保留编辑状态。非 pending 候选只补共享输入校验，F2 完整工作台留后续。
- [ ] Step 3：运行 `npx vitest run tests/planning/eventValidation.test.ts tests/planning/confirmAtomic.test.ts tests/ui/pendingConversion.test.tsx tests/extractionImport.test.ts tests/ui/errorHandling.test.tsx`。验收是无效输入不落库、转换全成或全撤，错误时编辑内容保留。

### Task 9: 提醒按实际 fireAt 补报（R6）

**Files:** 修改 `src/main/services/reminder.ts`、`src/main/db/dao.ts`；新建 `tests/reminders/window.test.ts`；扩展 `tests/reminderBackup.test.ts`。现有 `withinMissedWindow` 恒返回 true，事件查询按 `start_at` 范围限制。

**Interfaces:** 拟议 `dueReminders(db:SqliteDb, now:Date): Array<{entityId:string;fireAt:string;key:string}>` 按 `fireAt` 查询及过滤 `[now-24h, now]`，使用注入时钟；通知前检查已完成/取消，重复 key 不再报。`showNotification` 成功仅代表交给操作系统。

- [ ] Step 1：固定本地时钟 `2026-09-20 12:00`，创建提前数天提醒但 `fireAt` 恰在窗口内的事件，以及 `fireAt` 刚好在 24 小时边界、早 1ms、晚于 now 1ms 的案例；完成待办与取消日程不出现。下列关键测试使用拟议 `dueReminders`，新入口尚不存在时先红。运行 `npx vitest run tests/reminders/window.test.ts`。

```ts
import { expect, it } from 'vitest'
import { createEvent } from '../../src/main/db/dao'
import { dueReminders } from '../../src/main/services/reminder'
import { makeTestDb } from '../helpers'

it('R6: fireAt 在闭合的过去24小时窗口内且提前数天的提醒可见', async () => {
  const db = await makeTestDb()
  const now = new Date(2026, 8, 20, 12, 0, 0, 0)
  const localMs = (d: Date): string => {
    const p = (n: number, size = 2): string => String(n).padStart(size, '0')
    return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())].join('-') + 'T' +
      [p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())].join(':') + '.' + p(d.getMilliseconds(), 3)
  }
  const at = (offsetMs: number): string => localMs(new Date(now.getTime() + offsetMs))
  const inside = createEvent(db, {
    title: '提前数天', startAt: at(3 * 86_400_000), endAt: at(3 * 86_400_000 + 3_600_000),
    reminderMinutes: 3 * 24 * 60
  })
  const boundary = createEvent(db, {
    title: '恰好24小时', startAt: at(-86_400_000), endAt: at(-86_400_000 + 3_600_000),
    reminderMinutes: 0
  })
  const tooOld = createEvent(db, {
    title: '早1毫秒', startAt: at(-86_400_001), endAt: at(-86_400_001 + 3_600_000),
    reminderMinutes: 0
  })
  const future = createEvent(db, {
    title: '晚1毫秒', startAt: at(1), endAt: at(3_600_001), reminderMinutes: 0
  })
  const ids = dueReminders(db, now).map((r) => r.entityId)
  expect(ids).toContain(inside.id)
  expect(ids).toContain(boundary.id)
  expect(ids).not.toContain(tooOld.id)
  expect(ids).not.toContain(future.id)
})
```
- [ ] Step 2：将查询以实际触发时刻为准，统一本地时间解析与边界，标记 fired 的时点及失败重试语义要避免“先标记后丢通知”。本阶段保持现有通知形式，免打扰/稍后提醒/持久提醒中心留待 F4。
- [ ] Step 3：运行 `npx vitest run tests/reminders/window.test.ts tests/reminderBackup.test.ts`。验收是边界可重现、重启后仅补过去 24 小时内应触发的活跃事项。

### Task 10: 会话运行标识与迟到事件隔离（R8）

**Files:** 修改 `src/main/services/engine.ts`、`src/shared/api.ts`、`src/renderer/workbench/pages/ChatPage.tsx`、`src/main/ipc.ts`；扩展 `tests/ui/chatRace.test.tsx`；新建 `tests/engineRunId.test.ts`。现有 `evt:chat-done/error` 只带 `conversationId`，页面 done/error 在会话匹配前会清空流状态。

**Interfaces:** 拟议 chat delta 事件 `{conversationId:string;runId:string;delta:string}`，done 事件 `{conversationId:string;runId:string;messageId:string}`，error 事件 `{conversationId:string;runId:string;error:string}`；分析更新事件也携带运行 ID，非当前运行的分析事件不清流状态。`sendChat`/`retry` 启动时生成新 runId 并使旧运行失效；停止命令对应活动 runId。页面保存当前 `conversationId+runId`，只接收精确匹配事件。

新增 `evt:chat-started`，包含 conversationId、runId、单会话递增 runGeneration，由主进程在任何流事件前发送；页面据此绑定运行，不能把任意迟到 delta 当作新运行。新增 `getActiveChatRun(conversationId)` 返回活动运行和累计文本，支持视图切回。订阅先建立再取快照，以 generation 和同运行单调文本序号去掉重复增量，旧快照不覆盖新运行。须同时更新 `src/preload/index.ts` 的订阅白名单；恢复 workspaceEpoch 后旧活动快照全部失效。

- [ ] Step 1：扩展现有 `tests/ui/chatRace.test.tsx` 中 `installApi` 的 `handlers` 假订阅；测试同会话旧 runId 的 done/error、另一会话事件均不能清空当前流。关键测试如下（直接加入已有文件、复用其 `installApi`）；先运行 `npx vitest run tests/ui/chatRace.test.tsx tests/engineRunId.test.ts`，预期旧事件能清空新状态。

```tsx
it('R8: 旧运行完成事件不清空同会话新运行', async () => {
  const { listMessages, handlers } = installApi()
  render(<ChatPage refreshKey={0} petAction={null} locateConversationId={null} />)
  await vi.waitFor(() => expect(listMessages).toHaveBeenCalledWith('conv-a'))
  act(() => {
    handlers.get('evt:chat-started')?.({ conversationId: 'conv-a', runId: 'run-new', runGeneration: 2 })
    handlers.get('evt:chat-delta')?.({ conversationId: 'conv-a', runId: 'run-new', delta: '新运行文本' })
  })
  expect(await screen.findByText('新运行文本')).toBeTruthy()
  act(() => {
    handlers.get('evt:chat-done')?.({ conversationId: 'conv-a', runId: 'run-old' })
    handlers.get('evt:chat-error')?.({ conversationId: 'conv-b', runId: 'run-other', error: '迟到' })
  })
  expect(screen.getByText('新运行文本')).toBeTruthy()
  expect(screen.queryByText('分析失败:迟到')).toBeNull()
})
```
- [ ] Step 2：在 Engine、shared、preload 和 UI 假订阅中增加 started/runId 契约；现有 `installApi` 辅助默认增加 `getActiveChatRun: vi.fn(async () => null)`，并更新原有只发送 delta 的测试，先发送 started。取消和重试使旧运行失效，视图切换只重置本页绑定，不取消其他会话的后台运行。清理 AbortController 时只删当前运行对应项，事件判定先于任何 UI 状态变更；补充切回活动会话及快照与增量重叠的测试。
- [ ] Step 3：运行 `npx vitest run tests/ui/chatRace.test.tsx tests/engineRunId.test.ts tests/modelRouter.test.ts`。验收是不相关运行零 UI 副作用；F9 的完整发送快照和审计仍属后续阶段。

### Task 11: 邮箱初始 UID 上界与空窗口（R9）

**Files:** 修改 `src/main/mail/sync.ts`、`src/main/mail/ports.ts`、`src/main/mail/repository.ts`；扩展 `tests/mail/sync.test.ts`、`tests/mail/fakeSession.ts`。现有 `FakeSession` 可设置 `uidNext`、`envelopesByUid` 并检查 `calls`。

**Interfaces:** 初始 `open()` 的 `cap = uidNext - 1` 是固定快照；最近 30 天检索仅装载 `uid <= cap`。非最后一批只提交该批已处理最大 UID 与 `initialized=false`；只有最后一批完整提交或空窗口提交成功后，才把 `lastUid` 推进到 cap 并标记 initialized。第二次 `open()` 后仅补 `(cap, newUidNext - 1]`，UIDVALIDITY 改变时不沿用旧身份。中断后重跑最近 30 天窗口，仓储按 UID 幂等跳过已提交批次；`SyncState` 现有字段足以承载，不先增加新游标类型。

- [ ] Step 1：`fake.uidNext = 500`，只放一封 400 天前的 UID 1；初始同步后应 `lastUid===499`、无邮件，且 `calls` 不含 `searchUids:0:499`。扩展 `FakeSession` 为可注入 `onOpen(openCount)`，在第二次打开前注入 UID 500 并返回 `uidNext=501`，断言只补新信。再把下列测试直接加入现有 `tests/mail/sync.test.ts`，复用其中的 `setup`、`FakeSession` 和 `makeEnvelope`，验证中途取消没有提前推进 cap。先运行 `npx vitest run tests/mail/sync.test.ts`，预期旧实现的空窗口游标或分批终态不满足断言。

```ts
it('R9: 分批中止只保留已提交进度，重跑不漏剩余近期邮件', async () => {
  const { fake, repository, info, worker } = await setup()
  fake.uidNext = 100
  for (let uid = 1; uid <= 51; uid += 1) fake.envelopesByUid.set(uid, makeEnvelope(uid))
  const controller = new AbortController()
  let batches = 0
  const originalCommit = repository.commitBatch.bind(repository)
  repository.commitBatch = (...args: Parameters<typeof repository.commitBatch>) => {
    const added = originalCommit(...args)
    batches += 1
    if (batches === 1) controller.abort() // 首批已经提交，再中断下一批
    return added
  }
  await expect(worker.run(info.id, 'refresh', DAY, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(repository.state(info.id)).toMatchObject({ lastUid: 50, initialized: false })
  repository.commitBatch = originalCommit
  const result = await worker.run(info.id, 'refresh', DAY, new AbortController().signal)
  expect(result.initial).toBe(true)
  expect(repository.state(info.id)).toMatchObject({ lastUid: 99, initialized: true })
  expect(repository.list({ accountId: info.id, limit: 100 }).items).toHaveLength(51)
})
```
- [ ] Step 2：仅在最后一批或空窗口提交成功时推进 cap；分批中断后保留未初始化标记，不允许从半途 `lastUid` 直接走增量。补收前复核 UIDVALIDITY；身份改变时进入远端身份重建分支，不把旧 UID 当新邮箱记录。保留既有历史加载的 `oldestDay` 语义。
- [ ] Step 3：运行 `npx vitest run tests/mail/sync.test.ts tests/mail/repository.test.ts tests/mail/windows.test.ts`。验收是空窗口无历史回捞，初始化期间邮件不丢，UIDVALIDITY 重置后不串库。

### Task 12: 邮箱账号级取消、集成与阶段出口（R10/O3/O4/O5）

**Files:** 修改 `src/main/mail/scheduler.ts`、`src/main/mail/service.ts`、`src/main/mail/content.ts`、`src/main/mail/repository.ts`、`src/main/mail/accounts.ts`、`src/main/index.ts`、`src/main/ipc.ts`、`src/shared/mail.ts`；扩展 `tests/mail/scheduler.test.ts`、`tests/mail/sync.test.ts`、`tests/mail/content.test.ts`、`tests/ui/errorHandling.test.tsx`；新建 `tests/mail/lifecycle.test.ts`。现有调度器 `stopAll` 只持有 `runDue` 的控制器，手动同步和阅读使用各自新建控制器。

**Interfaces:** 拟议 `MailTaskRegistry.begin(accountId:string, kind:'sync'|'history'|'content'): {signal:AbortSignal; generation:number; finish():void}` 与 `cancelAccount(accountId:string): Promise<void>`；每次写仓储/缓存之前检查账号代数与 enabled/existence。`MailService.setEnabled/remove/stop` 必须取消并等待对应账号任务；停用/移除不影响其他账号。

- [ ] Step 1：复用 `FakeWorker` 的门控思想与 `FakeSession.onEnvelopes`：A 的手动同步停在 `envelopes()`，执行停用或移除后释放旧结果，断言 `mail_messages`、`mail_sync_state`、缓存与账号状态无迟到写入；同时 B 同步成功。退出测试让读取/下载悬挂，`stop()` 等待其安全退出。先运行 `npx vitest run tests/mail/lifecycle.test.ts`，预期旧手动控制器未被取消。
- [ ] Step 2：账号级任务注册表接入自动/手动同步、历史加载、正文和附件；仓储提交边界复核代数并将账号存在性与代数检查放在同一写入协调范围内。停用先提升代数、取消和等待，再更新状态；移除先阻断后删除。退出停止新任务，等待必要保存；超时记录未完成任务供下次安全恢复。
- [ ] Step 3：公共 `AppError` 严格使用细则中的 `VALIDATION/FORBIDDEN/CONFLICT/PERSIST_FAILED/BACKUP_INVALID/AUTH_REQUIRED/NETWORK/CANCELLED/BUSY/STALE_PREVIEW/TARGET_UNAVAILABLE`，内部细因放脱敏 detail 或日志分类，不新增公开冲突/加密细码。检查日志只含操作 ID、通道、分类与脱敏上下文，不含密钥、邮件正文或材料内容。执行 `npx vitest run tests/mail/lifecycle.test.ts tests/mail/scheduler.test.ts tests/mail/sync.test.ts tests/mail/content.test.ts tests/ui/errorHandling.test.tsx`。
- [ ] Step 4：阶段出口运行 `npm test`、`npm run typecheck`、`npm run build`、落地的 lint/format/CI、`npm audit --json`，并在干净测试 `userData` 下验证 v3 迁移与重开。记录 Windows 打包、休眠唤醒、磁盘写失败的真机结果或明确“未验证”；绝不以模拟测试冒充真实邮箱/生产调用。验收为 R1—R10 各有红转绿的缺陷用例、旧数据未丢、错误可见，未通过项目逐项列出。

## 覆盖与审查

R1→任务 4；R2→2、3；R3→5；R4→6；R5→7；R6→9；R7→2、8；R8→10；R9→11；R10→12。O2 基准→1，O3 模块边界→2—12，O4 错误与脱敏→3、5、6、12，O5 CI/故障/打包留证→1、12。每项独立审查其红灯原因、绿灯结果、迁移/安全副作用及文件责任。计划中拟议签名不等于现有 API；实施若调整签名，须同时校正调用方、测试和本计划的依赖。
