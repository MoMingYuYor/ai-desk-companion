# Q 版坐姿桌宠 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户确认的坐姿人物接入现有桌宠，提供轻量状态动画，保留桌面入口功能，并可与邮箱模块并行实施。

**Architecture:** React 视图分离人物、动画、气泡和输入控制；注入受限 PetPort，业务服务不依赖角色资源。主进程集中提供原生拖动、活动快照和窗口几何；共享接线归 R，引擎通知修改归邮箱 C 的同一所有者。

**Tech Stack:** 沿用 Electron、React、TypeScript、Vite、Vitest；动画仅 CSS，不添加运行时动画库。UI 测试共用邮箱计划的 Testing Library/jsdom 底座，不独立升级锁文件。

**Spec:** [桌宠形象与接入设计](../specs/2026-09-15-chibi-desktop-pet-design.md)。协作依据：[邮箱并行分区](2026-09-15-multi-mailbox.md)；产品与任务状态回填 [产品文档](../../产品设计文档.md)、[开发计划](../../开发计划.md)。

## Global Constraints

- 用户已确认生成图；保留角色、坐姿和白紫裙装，不重新设计或生成角色。
- 首版只使用一张透明 PNG；不做独立表情、Live2D、骨骼、走动、养成、语音、音效、换装和吸附。
- 保留拖动、右键、今日要点、外部材料拖入、提醒和托盘显示/隐藏。
- 人物/动画/气泡分区，不修改邮箱内部文件，不在运行时调用图像生成或加载远程角色。
- 首版默认窗口 320 × 400 DIP、图片框 200 × 200 CSS px；仅工程默认值，不把它们描述成用户逐项指定。
- 尊重 prefers-reduced-motion；隐藏时停动画和拖动轮询。
- 现有账号、数据库、备份格式不迁移；活动状态只保存在内存。
- 保留 contextIsolation=true、nodeIntegration=false；不绕开 IPC 来源校验。
- 当前只有设计和静态预览通过用户确认；本文件的测试结果均为预期，尚未运行。
- 公开仓库/安装包前核实角色和图片分发许可，许可不明不自行标注为原创或 MIT。

## 0. 实施前证据与执行规则

2026-09-15 检查工作区 `D:\Chatgpt\待办`：未发现 AGENTS.md；实施时重新检查。node_modules 不存在，npm.cmd 未在 PATH 找到，不能引用旧文档测试数作为本次通过证据。当前未提交改动主要为设计文档，必须保留；本轮不安装包、复制图片到运行目录或改源代码。

已读代码与具体风险：

| 接缝 | 现状 | 计划处理 |
| --- | --- | --- |
| `src/renderer/pet/pet.tsx` | 人物 SVG、定时器、业务事件、拖入和拖动集中；transform 与 keyframes 共用节点 | 任务 2—5 拆分视图和控制 |
| `src/renderer/shared/ui.css` | html/body/#root 设置非透明背景 | 任务 3 只在 pet.css 覆盖，不改全局样式 |
| `src/main/ipc.ts` | pointer down 对应的 PetDragStart 立刻开启 16 ms 轮询；move 是空操作 | 任务 4 超阈值后才 start；任务 6 提取可清理控制器 |
| `src/main/windows.ts` | 桌宠 150×170；面板偏移 +160；只考虑主屏尺寸 | 任务 7 集中几何配置与实际 workArea 定位 |
| `src/main/services/engine.ts` | 自动分析后才发 materials-accepted；analysis-updated 也可代表失败 | 任务 5 增加独立活动通知，不改原有事件语义 |
| `src/main/index.ts` | 提醒/模型切换同时用广播和直接气泡，另设全局 idle 超时 | 任务 5/7 去除重复接线，保留系统通知 |
| `src/main/windows.ts` | rendererUrl 在打包环境返回本地路径，但仍交给 loadURL | 任务 7 开发 URL/本地 loadFile 分流，并回归三个窗口 |

单项执行：先写失败测试 → 运行确认失败原因 → 最小实现 → 定向测试/类型检查 → 定向提交。以下组合测试列表在实施时逐条循环，不先写完全部代码再补测试。提交只 stage 本任务文件；未配置 Git 身份时请求用户设置，不虚构作者身份。

## 1. 文件地图、所有权与并行门槛

以下均为计划文件，不代表已存在。

| 文件 | 所有者 | 单一职责 |
| --- | --- | --- |
| `src/renderer/pet/assets/chibi-seated-v1.png` | P-V | 已确认角色图的原样副本 |
| `src/renderer/pet/assets/ASSET-SOURCES.md` | P-V | 来源、hash、确认状态和许可待核实说明 |
| `src/renderer/pet/PetCharacter.tsx`、`FallbackPet.tsx` | P-V | 图片显示与旧 SVG 回退 |
| `src/renderer/pet/PetBubbles.tsx`、`pet.css` | P-V | 气泡显示与 pet 专用样式 |
| `src/renderer/pet/contracts.ts`、`model.ts` | P-I | 注入端口、纯展示状态和常量 |
| `src/renderer/pet/gesture.ts`、`controller.ts` | P-I | 手势控制、事件/定时器/异步清理 |
| `src/renderer/pet/pet.tsx`、`pet-main.tsx` | P-I | 组件组合、唯一 window.api 注入点 |
| `src/shared/pet.ts` | R | 活动事件和布局参数，无 DOM/Node 依赖 |
| `src/main/pet/activity.ts`、`drag.ts`、`geometry.ts` | P-N | 活动注册、原生拖动、坐标纯函数 |
| `src/main/windows.ts`、`ipc.ts`、`index.ts` | R | 共享应用接线，禁止 P 区和邮箱 R 同时编辑 |
| `src/shared/api.ts`、`src/preload/index.ts` | R | 新快照 API；原有拖动签名不变 |
| `src/main/services/engine.ts` | C | 最小可选 onPetActivity 生命周期回调 |
| `tests/pet/*.test.ts` | 各任务作者 | 状态/几何/原生服务/活动/资源测试 |
| `tests/ui/pet/*.test.tsx` | 各任务作者 | 专属 UI 单测，邮箱 D 不写此子目录 |
| `tests/pet/engineActivity.test.ts` | C | 引擎回调开始、成功、失败、取消 |
| `vitest.config.ts`、tsconfig、package/lock | P0/R | 共用测试基础，不重复安装升级 |
| `docs/桌宠接入与验收.md` | R | 实施时创建，真实测试记录与发布门槛 |

任务依赖：

```text
任务 1：工具、素材、测试底座、冻结契约
 ├─ P-V：任务 3（使用固定状态输入）
 ├─ P-I：任务 2 → 4（使用端口替身）
 └─ P-N/C：任务 5 的 registry/engine + 任务 6（使用假窗口）
                    ↓
任务 5 的 renderer 接线 + 任务 7 的 R 集成
                    ↓
任务 8：全量/真机/打包验收
```

不必等邮箱业务完成；如果邮箱 P0 尚未实施，由同一 P0/R 先发布最小共用 UI 测试底座，邮箱稍后复用。P 区从共同基线建立 `codex/pet-visual`、`codex/pet-interaction`、`codex/pet-native` 工作区（实施时按 using-git-worktrees 技能执行，不在本轮创建）。R 集成分支和邮箱共用，C 的引擎改动串行提交。按任务边界交接 SHA、文件清单、命令结果和未验证项，不强推他人分支。

## 2. 冻结契约与状态流

任务 1 由 R 发布 shared 契约、P-I 发布 renderer 契约；实现类不得成为跨区类型依赖。

```ts
// src/shared/pet.ts
export type PetActivityOutcome = 'done' | 'failed' | 'cancelled'
export type PetActivityChange =
  | { phase: 'start'; taskId: string }
  | { phase: 'finish'; taskId: string; outcome: PetActivityOutcome }
export interface PetActivitySnapshot { revision: number; activeIds: string[] }
export interface PetActivityNotice extends PetActivitySnapshot {
  finished?: { taskId: string; outcome: PetActivityOutcome }
}
export const PET_LAYOUT = {
  width: 320, height: 400, characterSize: 200,
  top: 12, bubbleHeight: 180, bottom: 8, bubbleWidth: 288
} as const

// src/renderer/pet/contracts.ts
import type { RendererApi } from '../../shared/api'
import type { PetActivitySnapshot } from '../../shared/pet'
export type PetPort = Pick<RendererApi,
  'getDayAgenda' | 'addMaterials' | 'pathForFile' |
  'petDragStart' | 'petDragEnd' | 'petOpenMenu' | 'on'> & {
    getPetActivitySnapshot(): Promise<PetActivitySnapshot>
  }
export interface PetClock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}
export type PetMode = 'idle' | 'busy' | 'alert'
export interface PetBubble { id: number; text: string; expiresAt: number }
export interface PetViewState {
  activity: PetActivitySnapshot
  pendingIntakes: number
  alertUntil: number
  alertSequence: number
  bubbles: PetBubble[]
}
export interface Point { x: number; y: number }
```

新增事件 `evt:pet-activity` 载荷为 PetActivityNotice；新增 `pet:activity-snapshot` 和 `RendererApi.getPetActivitySnapshot()`。先订阅再取快照，只应用较新 revision；快照只恢复忙碌状态，不重播完成气泡。主进程 registry 每次有效变化自增 revision，重复 start/finish 不增版本，不重复提醒。不在事件中发送邮件正文或材料路径。

保留既有 pet-bubble/pet-state 接口兼容其他调用方；legacy idle 不能清除 activeIds 或 pendingIntakes。提醒使用独立截止时间；旧超时只有自身序号匹配时可清除，避免新提醒被旧定时器清掉。

唯一事件映射：

| 输入 | 状态/气泡 |
| --- | --- |
| activity 开始 | 有活动则 busy，无需每次弹开始气泡 |
| activity done | 移除对应活动；“分析完成，打开工作台查看结果”，6 秒 |
| activity failed | 移除对应活动；“分析失败，请在工作台查看原因”，8 秒提醒 |
| activity cancelled | 移除对应活动；不显示成功、不弹错误 |
| reminder-fired | 用 key 去重本窗口最近 100 条；8 秒提醒和一条气泡 |
| model-switched | 6 秒提醒，一条有限长度的切换文案 |
| pet-bubble | 通用文本气泡，默认 5 秒；邮箱汇总仍走此接口 |
| materials-accepted / analysis-updated | 不再直接改 busy 或生成成功气泡，其他消费者不变 |
| 本地 addMaterials Promise | pendingIntakes 加一/最终减一；接收失败提示，不再根据返回顺序覆盖 registry |

引擎的 activity 指通知分析和课表/校历导入，不覆盖普通聊天、邮箱收取/阅读。邮箱后续通过同一 Engine.runAnalysis 的回调自动加入 registry；不可在邮箱桥再重复开始相同分析。材料准备期间若需额外状态，作为独立后续接线，不扩大本轮协议。

## 任务 1：素材锚定、测试底座与契约（P0/R + P-V/P-I）

**Files:** Create 上述 assets 两文件、shared/pet、pet/contracts、`tests/pet/asset.test.ts`、`tests/ui/pet/setup.test.tsx`；Modify 共用测试配置/package 仅限底座尚未具备时。

**Interfaces:** Consumes 设计文档的原图路径/hash；Produces 打包可导入的 PNG、完整第 2 节类型及能够独立运行的 node/jsdom 环境。

- [ ] 实施开始重新检查 git status/AGENTS、node/npm；补齐 npm 后 `npm.cmd ci`，运行原 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run build`，记录真实基线。环境失败不当成测试红灯。
- [ ] 检查确认图存在且 hash 一致。若缺失或不同，要求找回/重新确认，不静默生成新人物。写下面的资源测试：

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
it('使用用户确认的完整 PNG，而非运行时个人目录', () => {
  const data = readFileSync(resolve('src/renderer/pet/assets/chibi-seated-v1.png'))
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(data.readUInt32BE(16)).toBe(1254)
  expect(data.readUInt32BE(20)).toBe(1254)
  expect(createHash('sha256').update(data).digest('hex')).toBe(
    '00e0a0decbb5bc8ffbe252260c5aa47599b674a03ea6ac638314cfe5b644aae8')
})
```

- [ ] `npm.cmd test -- tests/pet/asset.test.ts`，预期因目标 PNG 尚不存在而失败。用 Copy-Item -LiteralPath 原样复制到明确目标，先确认目标不存在；不处理图片像素、不删除原文件。再次测试预期通过。
- [ ] 写 ASSET-SOURCES.md：生成日期、参考来自用户、原始文件名、确认图 hash、用户已认可视觉、下半身补全、公开分发许可未核实。实际个人绝对路径留在本设计记录，不嵌入打包资源说明；未经许可不得自动推送含素材提交到公开仓库。
- [ ] 由 P0/R 复用邮箱测试底座；没有时仅安装 `@testing-library/react@16.3.3`、`@testing-library/user-event@14.6.7`、`jsdom@26.1.0` 的精确开发依赖。不安装邮箱运行依赖以强行满足桌宠单独开发。配置保留全部原测试，并增加 UI 环境：

```ts
// vitest.config.ts：与邮箱底座合并，不覆盖已存在配置。
import { defineConfig } from 'vitest/config'
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] }
})
// tests/ui/pet/setup.test.tsx
// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
afterEach(cleanup)
it('可以独立渲染桌宠组件', () => {
  render(<button>今日要点</button>)
  expect(screen.getByRole('button', { name: '今日要点' })).toBeTruthy()
})
```

`// @vitest-environment jsdom` 须放测试文件首行。node tsconfig exclude `tests/ui/**`，web tsconfig include `tests/ui/**`；若 web composite 引入 UI 外测试 helper，将 helper 纳入 include 或移入专用 UI helper，不靠关闭类型检查解决。node tsconfig 加入 vitest.config.ts 的检查。
- [ ] 创建第 2 节契约，RendererApi 新方法在任务 7 与 preload 同一提交接入，当前 PetPort 用交叉类型预声明，不让基础构建引用未实现桥接。运行全量测试/类型检查/构建，记录发布基线 SHA；提交 `chore(pet): anchor approved asset and shared test contracts`。

## 任务 2：纯状态、提醒与气泡生命周期（P-I）

**Files:** Create `src/renderer/pet/model.ts`、`tests/pet/model.test.ts`。

**Interfaces:** Consumes PetViewState；Produces `initialPetState(): PetViewState`、`applyActivity(state, notice): PetViewState`、`addBubble(state, text, now, ttl?): PetViewState`、`setAlert(state, now, ttl): PetViewState`、`expire(state, now): PetViewState`、`selectMode(state, now): PetMode`；state/notice 参数分别为 PetViewState/PetActivityNotice，now/ttl 为 number。

- [ ] 写提醒到期仍应忙碌及旧快照不得覆盖新状态的红灯测试：

```ts
import { expect, it } from 'vitest'
import { initialPetState, applyActivity, setAlert, expire, selectMode } from '../../src/renderer/pet/model'
it('提醒消退后恢复仍在执行的分析', () => {
  let s = applyActivity(initialPetState(), { revision: 2, activeIds: ['run-a'] })
  s = setAlert(s, 1000, 8000)
  expect(selectMode(s, 1001)).toBe('alert')
  s = expire(s, 9000)
  expect(selectMode(s, 9000)).toBe('busy')
  s = applyActivity(s, { revision: 1, activeIds: [] })
  expect(selectMode(s, 9000)).toBe('busy')
})
```

- [ ] 运行 `npm.cmd test -- tests/pet/model.test.ts` 确认缺模块失败。按下面纯函数最小实现，其余转换不原地修改数组：

```ts
export function selectMode(s: PetViewState, now: number): PetMode {
  if (s.alertUntil > now) return 'alert'
  return s.pendingIntakes > 0 || s.activity.activeIds.length > 0 ? 'busy' : 'idle'
}
export function applyActivity(s: PetViewState, n: PetActivityNotice): PetViewState {
  if (n.revision <= s.activity.revision) return s
  return { ...s, activity: { revision: n.revision, activeIds: [...new Set(n.activeIds)] } }
}
```

初始 revision=-1；registry 初始 revision=0。addBubble 只接受非空文本，纯文本显示；最多 3 条，序号用当前最后 id+1，跨清空可从 1 重起，controller 定时器按重调度清理。文本内部截取上限 500 字，UI 两行省略；不使用 dangerouslySetInnerHTML。setAlert 增加 alertSequence，将期限设为 max(旧期限, now+ttl)。expire 只过滤到期项并清除已到期提醒，保留活动。
- [ ] 补齐测试：两个活动结束一个仍 busy；pendingIntakes 阻止提前 idle；提醒叠加；空提示忽略；第四气泡淘汰第一条；相同 revision 不重播；HTML 字符保持文本；超时后的旧快照拒绝。
- [ ] 定向测试及 `npm.cmd run typecheck` 通过后提交 `feat(pet): isolate activity alert and bubble state`。

## 任务 3：人物、回退、气泡与轻动画（P-V）

**Files:** Create PetCharacter.tsx、FallbackPet.tsx、PetBubbles.tsx、pet.css、`tests/ui/pet/visual.test.tsx`；从旧 pet.tsx 提取 SVG 由 P-I 在组装提交删除原位置，避免 P-V 同时编辑 pet.tsx。

**Interfaces:** `PetCharacter({ mode, pressed, dragging, releaseKey, alertKey }: { mode: PetMode; pressed: boolean; dragging: boolean; releaseKey: number; alertKey: number }): JSX.Element`；`PetBubbles({ items }: { items: PetBubble[] }): JSX.Element`。组件不读 window.api。

- [ ] 写图片和气泡分离的测试，`npm.cmd test -- tests/ui/pet/visual.test.tsx` 预期模块缺失失败：

```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PetCharacter } from '../../../src/renderer/pet/PetCharacter'
afterEach(cleanup)
it('使用不可原生拖动的角色图，错误时回退', () => {
  render(<PetCharacter mode="idle" pressed={false} dragging={false} releaseKey={0} alertKey={0} />)
  const img = screen.getByAltText('坐姿桌宠') as HTMLImageElement
  expect(img.draggable).toBe(false)
  fireEvent.error(img)
  expect(screen.getByRole('img', { name: '备用桌宠' })).toBeTruthy()
})
```

- [ ] 静态 import `./assets/chibi-seated-v1.png`；img onError 切一次 React 状态，改渲染旧 SVG（aria-label="备用桌宠"、role="img"）。不得把个人路径放入 src。层次固定如下，CSS reset 限于 pet 页面：

```tsx
// PetCharacter 内部层次；safe fallback 由局部 failed 状态选择。
<div className="pet-motion" data-mode={mode} data-dragging={dragging}>
  <div className="pet-alert-motion" key={alertKey}>
    <div className="pet-release" key={releaseKey}>
      <div className="pet-press" data-pressed={pressed}>
        <img src={characterUrl} alt="坐姿桌宠" draggable={false} />
      </div>
    </div>
  </div>
</div>
```

回弹和提醒各独占一层；仅非零 releaseKey/alertKey 才添加一次动画 class，初次挂载不弹。切换 busy/alert 时不得重复 key 整棵人物，图片 failed 状态保存在 PetCharacter 顶层。dragging 时所有运动层禁用 animation，releaseKey 不增长。
- [ ] 加 pet 专用布局/样式，覆盖公共 CSS 背景而不改原文件：

```css
html, body, #root { background: transparent; }
.pet-root { height: 100vh; display: grid; grid-template-rows: 180px 200px;
  padding: 12px 16px 8px; justify-items: center; user-select: none; }
.pet-character-button { width: 200px; height: 200px; padding: 0; border: 0;
  background: transparent; touch-action: none; cursor: grab; }
.pet-character-button:focus-visible { outline: 2px solid #8971b8; outline-offset: 2px; }
.pet-character-button img { display: block; width: 200px; height: 200px; object-fit: contain; }
.pet-motion[data-mode="idle"] { animation: pet-breathe 3.6s ease-in-out infinite; }
.pet-motion[data-mode="busy"] { animation: pet-busy 1.8s ease-in-out infinite; }
.pet-press { transform-origin: bottom center; transition: transform 100ms ease-out; }
.pet-press[data-pressed="true"] { transform: scale(1.04, .96); }
@keyframes pet-breathe { 50% { transform: translateY(-3px); } }
@keyframes pet-busy { 25% { transform: rotate(-2deg); } 75% { transform: rotate(2deg); } }
@keyframes pet-release { 40% { transform: scale(.98, 1.02); } 100% { transform: none; } }
@keyframes pet-alert { 45% { transform: translateY(-6px); } 100% { transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .pet-motion, .pet-alert-motion, .pet-release, .pet-press {
    animation: none !important; transition: none !important; transform: none !important;
  }
  .pet-press[data-pressed="true"] { outline: 1px solid #8971b8; }
}
```

release 动画 320ms ease-out，alert 动画 600ms ease-in-out，bottom center 为轴；宽高读取 PET_LAYOUT 派生 CSS 变量或同一常量映射，示例固定值不得形成第二份长期配置。气泡区底部对齐，max-width 288px，font-size12px/line-height18px，padding6px 10px，2 行省略，最多 3 条与 6px 间隔。`visibilitychange` 隐藏时添加 root 状态停止全部动画；恢复时只恢复常驻运动，不重播旧提醒。
- [ ] 补静态 busy/alert、图片 src、文字转义、三条长气泡、拖动禁动画、静态焦点测试。jsdom 仅验 DOM 和样式规则，实际位移/透明边缘留任务 8，不伪称已测动画流畅度。
- [ ] UI 测试和 web 类型检查通过；提交 `feat(pet): render approved character with isolated lightweight motion`。

## 任务 4：点击、拖动、键盘与异步清理（P-I）

**Files:** Create gesture.ts、`tests/pet/gesture.test.ts`、`tests/ui/pet/gesture.test.tsx`；Modify pet.tsx 组装输入层。

**Interfaces:** `createPetGesture(port: Pick<PetPort,'petDragStart'|'petDragEnd'>, callbacks: { click(): void; change(value: { pressed: boolean; dragging: boolean; releaseKey: number }): void; error(): void }): { down(point: Point): void; move(point: Point): void; up(): void; cancel(): void; dispose(): Promise<void> }`。函数不访问 DOM；Pointer Capture 在组件层处理。

- [ ] 写微移不启动原生拖动的测试，运行 gesture node 测试确认红灯：

```ts
import { expect, it, vi } from 'vitest'
import { createPetGesture } from '../../src/renderer/pet/gesture'
it('阈值以内只点击，主进程不开始轮询', async () => {
  const port = { petDragStart: vi.fn(async () => {}), petDragEnd: vi.fn(async () => {}) }
  const click = vi.fn()
  const g = createPetGesture(port, { click, change: vi.fn(), error: vi.fn() })
  g.down({ x: 10, y: 10 }); g.move({ x: 13, y: 14 }); g.up()
  expect(port.petDragStart).not.toHaveBeenCalled()
  expect(click).toHaveBeenCalledTimes(1)
  await g.dispose()
})
```

- [ ] 实现状态机，>=6 才 start；每次 pointer 序列只调用一次，操作串行且 reject 后队列仍可继续：

```ts
// controller 闭包内部。所有 end 排在 start 尝试之后，即使 start 拒绝也尝试清理。
let operations: Promise<void> = Promise.resolve()
function enqueue(action: () => Promise<void>): void {
  operations = operations.then(action).catch(() => { callbacks.error() })
}
// down 只记录 Point；move 首次 Math.hypot(dx, dy) >= 6：
// enqueue(() => port.petDragStart())
// up/cancel/dispose 若已排过 start：enqueue(() => port.petDragEnd())
```

dispose 标记关闭、清理输入、不再通知 React，返回队列最终 Promise；error 在关闭后不 setState。拖动 start 失败后该轮不退化成点击，仍执行 end。鼠标快速连续拖动同样按 start/end/start/end 排序，不能由旧 ack 改写新 gesture 状态。
- [ ] 角色使用 button，onPointerDown 仅左键+primary，调用 setPointerCapture(pointerId)；非当前 pointerId 忽略。pointerup 处理后释放 capture；lostpointercapture/pointercancel/blur/document.hidden/unmount 调 cancel，必须幂等。图片 draggable=false；原生外部 drop 不进入 pointer gesture。
- [ ] pointerup 负责鼠标点击，button onClick 只接受键盘合成事件（detail===0）；防止原生 click 再请求一次。Shift+F10 preventDefault 后开菜单；右键不触发左键状态。拖动期间触发菜单时先 cancel 再打开。
- [ ] 测快速移动超过阈值只 start 一次、返回起点仍不是点击、窗外释放、lostcapture、卸载、start 延迟时先松手、start/end reject、下一个手势可恢复。组件测试 stub capture API 并核对调用，不据此宣称 Windows capture 实测通过。
- [ ] 两类 gesture 测试和类型检查通过，提交 `feat(pet): separate pointer press click and native drag`。

## 任务 5：活动真值、业务通知和控制器（P-N + C + P-I，分文件交接）

**Files:** P-N Create main/pet/activity.ts、tests/pet/activity.test.ts；C Modify services/engine.ts，Create tests/pet/engineActivity.test.ts；P-I Create renderer/pet/controller.ts、tests/ui/pet/controller.test.tsx，Modify pet.tsx。共享注册留任务 7。

**Interfaces:** `createPetActivityRegistry(emit: (n: PetActivityNotice) => void): { apply(change: PetActivityChange): void; snapshot(): PetActivitySnapshot }`；EngineDeps 增加可选 `onPetActivity?: (change: PetActivityChange) => void`。`createPetController(api: PetPort, clock: PetClock, render: (state: PetViewState) => void): { start(): void; showToday(): Promise<void>; acceptDrop(input: Parameters<PetPort['addMaterials']>[0]): Promise<void>; dispose(): void }`。

- [ ] 写 registry 并发测试，运行 `npm.cmd test -- tests/pet/activity.test.ts` 确认缺实现：

```ts
import { expect, it, vi } from 'vitest'
import { createPetActivityRegistry } from '../../src/main/pet/activity'
it('一项完成不清空其他任务，重复完成不重发提示', () => {
  const emit = vi.fn(); const r = createPetActivityRegistry(emit)
  r.apply({ phase: 'start', taskId: 'a' }); r.apply({ phase: 'start', taskId: 'b' })
  r.apply({ phase: 'finish', taskId: 'a', outcome: 'done' })
  expect(r.snapshot()).toEqual({ revision: 3, activeIds: ['b'] })
  r.apply({ phase: 'finish', taskId: 'a', outcome: 'done' })
  expect(emit).toHaveBeenCalledTimes(3)
})
```

- [ ] registry 用 Set，重复变化直接 return；snapshot 返回新数组；有效变化 revision++ 再 emit。emit 失败记录固定错误但不能向业务抛出导致分析失败，不输出文本/凭据。registry 生命周期绑定 bootstrap，不在窗口重开时清空。
- [ ] C 先用现有 Engine 测试工具添加回调 spy：runAnalysis/runImport 在有效请求第一次异步执行前 start，在 finally 恰好 finish；成功/JSON失败/模型失败/AbortError 各验证 outcome。同一 conversation 两次调用使用不同 randomUUID，不能用 conversationId 当 taskId。既有广播载荷、方法参数和返回值保持不变，兼容邮箱计划增加的 runAnalysis options。

```ts
// 嵌入既有 runAnalysis/runImport 的合法输入检查之后，复用原 controller/analysis。
const taskId = randomUUID()
this.deps.onPetActivity?.({ phase: 'start', taskId })
// 原有 try/catch 业务保持；将 finish 放进最外层 finally，确保 recordFailure 抛错也清理。
const outcome: PetActivityOutcome = controller.signal.aborted ? 'cancelled'
  : analysis?.status === 'done' ? 'done' : 'failed'
this.deps.onPetActivity?.({ phase: 'finish', taskId, outcome })
```

上述为插入位置示意，不把 finish 写到 finally 外。回调包装为不影响业务的通知方法，异常不得中断模型调用或覆盖原业务错误。空材料/不存在会话的早退不 start。普通聊天不添加此动画通知。C 运行 `tests/analysis.test.ts`、engineActivity 与邮箱 analysis（若已存在）回归后交付单独提交。
- [ ] controller 先订阅事件再 snapshot；校验输入对象/数字/数组，不直接断言 unknown；以 model 统一过期状态。只保留一个指向最近期限的 timeout，每次更新清旧 timer 后重排；dispose 取消所有订阅/timer并增加异步代次，迟到 snapshot/agenda/drop 不 render。
- [ ] 按第 2 节唯一映射展示文案。activity 完成提示只处理比当前 revision 新的 notice，初始化快照不提示。legacy pet-state alert 用8秒临时提醒；idle/busy 不覆盖 registry。reminder key 集合限100条；通用 pet-bubble 不按相同文本永久去重，避免后续真实同文提醒丢失。
- [ ] 今日要点同一在途请求合并，查询失败提示“暂时无法读取今日安排”；成功保持原课程/日程/到期待办数量逻辑。acceptDrop 使用 try/finally 更新 pendingIntakes；文件路径仍通过 api.pathForFile 获取，路径解析错误单独提示，不直接接触 fs。原 addMaterials 签名和拖入即分析不变。
- [ ] 测事件先于快照返回、低 revision忽略、取消不成功、失败不会被 materials-accepted 改忙碌、两任务/两次提醒交错、3气泡过期、卸载后所有 timer/监听清零、今日点击不调用 addMaterials/模型、拖入只调用一次 addMaterials。运行 activity/engineActivity/controller 测试，分所有者提交，不混合 stage 引擎与 UI 的未完成改动。

## 任务 6：原生拖动的生命周期（P-N）

**Files:** Create main/pet/drag.ts、tests/pet/drag.test.ts。

**Interfaces:** `DragWindow` 仅暴露 `isDestroyed(): boolean`、`getPosition(): [number,number]`、`setPosition(x:number,y:number): void`、`on(event:string, fn:()=>void): unknown`、`removeListener(event:string, fn:()=>void): unknown`。`createPetDragService(deps: { cursor(): Point; save(): void; setInterval(fn:()=>void,ms:number): unknown; clearInterval(id:unknown): void }): { start(win: DragWindow): void; stop(): void; dispose(): void }`。Point 在本文件用结构化 `{x:number;y:number}`，不能从 renderer 引入。

- [ ] 编写假时钟/窗口测试，先验证重复 start 仅一个 interval，stop 后光标变化不会继续 setPosition；`npm.cmd test -- tests/pet/drag.test.ts` 预期缺实现失败。测试最小窗口记录回调：

```ts
import { afterEach, expect, it, vi } from 'vitest'
import { createPetDragService } from '../../src/main/pet/drag'
afterEach(() => vi.useRealTimers())
it('隐藏停止唯一的拖动轮询', () => {
  vi.useFakeTimers()
  const listeners = new Map<string, () => void>()
  const win = {
    isDestroyed: () => false, getPosition: (): [number, number] => [100, 100],
    setPosition: vi.fn(),
    on: (event: string, fn: () => void) => { listeners.set(event, fn) },
    removeListener: (event: string) => { listeners.delete(event) }
  }
  const save = vi.fn()
  const drag = createPetDragService({ cursor: () => ({ x: 120, y: 120 }), save,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>) })
  drag.start(win); drag.start(win)
  vi.advanceTimersByTime(16)
  expect(win.setPosition).toHaveBeenCalledTimes(1)
  listeners.get('hide')?.()
  vi.advanceTimersByTime(100)
  expect(win.setPosition).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  drag.dispose()
})
```

- [ ] 从现有 ipc.ts 轮询逻辑移入服务，start 记录当前 cursor 相对窗口偏移，16ms 读取 DIP 光标并 setPosition。stop 先清轮询和窗口监听、置状态空，再对仍存活窗口 save 一次；任何异常仍清理，不保持僵尸引用。
- [ ] start 注册 blur/hide/closed/render-process-gone（后者由 R 的 webContents 回调调用 stop，不在 BrowserWindow 伪造事件）；stop removeListener，dispose 幂等。相同实例 start 重入不复制 interval；旧窗口已销毁则只清理不取位置。原生鼠标释放主路径仍由捕获 pointer 发送 end，不能假设 Electron 自动发送。
- [ ] 测关闭/隐藏/失焦、轮询时销毁、save 抛错、重复 stop、多轮 start/stop、退出 dispose；确保无残留 timers。Node 测试与类型检查通过，提交 `refactor(pet): isolate cancellable native drag service`。

## 任务 7：窗口布局、IPC 与真实组装（R + P-I）

**Files:** P-N Create geometry.ts、tests/pet/geometry.test.ts；R Modify windows.ts、ipc.ts、index.ts、shared/api.ts、preload/index.ts，Create tests/pet/ipc.test.ts、tests/pet/windows.test.ts；P-I 完成 pet.tsx/pet-main.tsx 真实端口注入。

**Interfaces:** geometry 的 `Rect={x:number;y:number;width:number;height:number}`；`clampPetPosition(point: {x:number;y:number}, area: Rect): {x:number;y:number}`、`placePanel(pet:Rect,panel:{width:number;height:number},area:Rect): {x:number;y:number}`。共享 API 仅新增 getPetActivitySnapshot；原 petDragStart/Move/End、petOpenMenu 不改参数。

- [ ] 写负坐标屏幕边界测试并运行 geometry 测试确认红灯：

```ts
import { expect, it } from 'vitest'
import { clampPetPosition } from '../../src/main/pet/geometry'
it('副屏允许负坐标，窗口完整落在工作区', () => {
  expect(clampPetPosition({ x: -50, y: 1000 },
    { x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({ x: -320, y: 640 })
})
```

- [ ] 实现 workArea 夹取，校验持久化值 Number.isFinite，非法值走屏幕右下角内缩24默认值；最小工作区小于窗口时不产生反向边界，左上可见并记录此环境限制：

```ts
export function clampPetPosition(p: { x: number; y: number }, a: Rect) {
  const maxX = a.x + Math.max(0, a.width - PET_LAYOUT.width)
  const maxY = a.y + Math.max(0, a.height - PET_LAYOUT.height)
  return { x: Math.round(Math.min(maxX, Math.max(a.x, p.x))),
    y: Math.round(Math.min(maxY, Math.max(a.y, p.y))) }
}
```

由 R 在 app ready 后按保存窗口矩形与 getAllDisplays 的 workArea 求交集选屏，无交集用主屏；不因 x<0 拒绝合法副屏。尺寸变更首启按旧窗口底部中心作为锚点再 clamp，meta 新增 `pet:layout-version=1` 仅作设置，不迁移 schema；保存失败不能每次启动累计漂移。拖动结束/显示恢复/显示器变更重做 clamp，主进程屏幕坐标统一 DIP，不另乘 devicePixelRatio。
- [ ] placePanel 优先在桌宠左侧12px，否则右侧12px，最后按工作区 clamp；用 pet.getBounds() 替代 +160。测试主屏/负副屏/屏幕移除/非法配置/面板靠边；不借此修改工作台布局。
- [ ] R 完成 registry 和 drag service 启动、getPetActivitySnapshot、evt:pet-activity 广播；引擎 onPetActivity 接 registry.apply。新快照和全部 pet drag/menu/action handler 校验 `event.sender === pet.webContents` 且 `event.senderFrame === pet.webContents.mainFrame`。当前通用 handle 丢弃 event 时，为 pet 通道单独注册带 event 的 handler，不改所有业务通道参数。
- [ ] 保留 PetDragMove 通道为空兼容旧 renderer；新 renderer 不调用它。getPetActivitySnapshot/drag 的错误不回传系统路径，销毁/隐藏停止 drag；before-quit 和 webContents render-process-gone 也清理。preload 暴露精确 invoke 方法，P-I 在 pet-main 传入 `<PetApp api={window.api} />`，内部组件不再散落访问全局 API。
- [ ] R 删除 index.ts 中 reminder onFired 和 notifyModelSwitch 的重复 markPetBubble/markPetState/idle timers；依然保留 engine 原有 evt:model-switched、reminders 原有 evt:reminder-fired 和系统 Notification。其他 petBridge 通用提示不删除。测试一轮提醒/模型切换只有一条桌宠提示。
- [ ] windows.ts 统一页面加载入口，三个窗口调用，保留全部安全参数：

```ts
function loadRendererPage(win: BrowserWindow, page: 'pet' | 'panel' | 'workbench'): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) {
    return win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`)
  }
  return win.loadFile(join(__dirname, '../renderer', `${page}.html`))
}
```

调用方处理 Promise rejection，保留可诊断加载失败信息但不暴露凭据。不要开启 webSecurity=false 或 nodeIntegration 解决素材加载；PNG import 由 Vite 复制进 out/renderer/assets。pet-main 在公共 CSS 后导入 pet.css，检查 html/body/#root computed background 透明。
- [ ] 窗口/IPC mock 测拒绝工作台和子 frame 调拖动/快照、160旧偏移消失、三个窗口开发/生产加载方法、安全选项、清理回调、多个事件去重。运行全部 tests/pet、tests/ui/pet 与 typecheck/build，提交按 R/P-I 文件边界拆开。

## 任务 8：整体验收、打包与交付记录（R）

**Files:** Create `docs/桌宠接入与验收.md`、`tests/ui/pet/integration.test.tsx`；Modify 原产品/开发文档的真实状态，README 仅在实现后补桌宠说明。

**Interfaces:** Consumes 全部真实模块；Produces 自动化证据、Windows 验收表、素材公开分发门槛。不直接发布/推送/创建 PR。

- [ ] 添加组件集成测试：PetApp 注入完整 PetPort spy，初始 snapshot idle；pointer点击 → getDayAgenda 一次；drop → addMaterials 一次；activity start/finish → busy/idle；提醒插入 → 到期恢复 busy；右键 → petOpenMenu；dispose 后 emit 不触发 render。以实际组成组件测试，不把整个 PetApp mock 掉。

```tsx
// @vitest-environment jsdom
import { act, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PetApp from '../../../src/renderer/pet/pet'
import type { PetPort } from '../../../src/renderer/pet/contracts'
afterEach(cleanup)
it('失败完成不显示成功，卸载清理订阅', async () => {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const api: PetPort = {
    on: (channel, listener) => {
      handlers.set(channel, listener)
      return () => { handlers.delete(channel) }
    },
    getPetActivitySnapshot: vi.fn(async () => ({ revision: 0, activeIds: [] })),
    getDayAgenda: vi.fn(async () => ({ date: '2026-09-15', courses: [],
      events: [], todos: [], schoolEvents: [] })),
    addMaterials: vi.fn(async () => ({ conversationId: 'synthetic-conv', materials: [] })),
    pathForFile: vi.fn(() => ''),
    petDragStart: vi.fn(async () => {}), petDragEnd: vi.fn(async () => {}),
    petOpenMenu: vi.fn(async () => {})
  }
  const view = render(<PetApp api={api} />)
  await act(async () => { await Promise.resolve() })
  act(() => handlers.get('evt:pet-activity')?.({ revision: 1, activeIds: ['run-1'] }))
  act(() => handlers.get('evt:pet-activity')?.({ revision: 2, activeIds: [],
    finished: { taskId: 'run-1', outcome: 'failed' } }))
  expect(screen.queryByText(/分析完成/)).toBeNull()
  expect(screen.getByText('分析失败，请在工作台查看原因')).toBeTruthy()
  view.unmount()
  expect(handlers.size).toBe(0)
})
```

- [ ] 执行并逐项记录退出码，不引用旧结果：

```powershell
npm.cmd test -- tests/pet tests/ui/pet
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

预期全部退出0。若邮箱尚未集成，记录当时基线不含邮箱，不称“邮箱与桌宠联合验收已通过”；若邮箱已集成，补充同步/阅读不触发 busy、手动分析触发 busy、新邮件只一条汇总的联合测试。
- [ ] 本机浅色/深色背景截图：200px角色无底色、轮廓清晰；图片读取失败确实回退；待机/按压/忙碌/提醒、最长三气泡无裁切；气泡不随人物变形；减少动态效果时静止，键盘焦点可见。PNG alpha 仅有透明像素不代表所有边缘合格，必须看截图。
- [ ] Windows 实测100/125/150/200%缩放、主屏/左侧副屏负坐标/任务栏、拖动至边缘、拔掉副屏后重开、隐藏/显示和面板位置。每项填环境/动作/结果/证据，不具备的环境填“未验证”。验证按下未越6px窗口不动，窗外释放后不再跟随鼠标，快速拖放/失焦/右键均停止轮询。
- [ ] 隔离用户数据后测试文件和文本拖入、剪贴板分析、成功/失败/取消/重试、多任务重叠、日程和到期待办提示。鼠标点击/拖动/右键不得新增模型请求；确认原有拖入自动分析规则仍生效。
- [ ] `npm.cmd run build` 后用 `npm.cmd exec -- electron-builder --win --dir` 创建本地解包验收产物；实际运行检查三个窗口、人物 PNG、sql.js WASM 和运行依赖。不能以 out 文件存在替代运行；当前运行时依赖缺失若属基线问题应单独记录/修复后重验，不混入视觉功能提交。
- [ ] 隐藏/显示10次、拖放20次后检查 interval/监听数量无增长；隐藏时无动画循环持续唤醒，主进程无拖动轮询。记录CPU与内存观测值和机器信息，不虚构统一性能百分比。
- [ ] 交付记录分列“图已确认 / 素材入项目 / 模块测试 / 整体回归 / Windows / 打包运行 / 素材公开许可”，只勾实际完成项。公开许可未核实不得打“可公开分发”勾；内部本地测试与公开发布分别判断。提交 `test(pet): verify character interaction and desktop lifecycle`。

## 3. 需求覆盖与不扩大范围

| 需求或风险 | 任务 |
| --- | --- |
| 使用确认图、透明、可打包、来源清楚 | 1、3、8 |
| 人物/动画/气泡分开、轻量效果、减少动态效果 | 2、3、8 |
| 点击/拖动/右键/越界释放/Promise竞态 | 4、6、7、8 |
| 多活动、提醒恢复、失败不报成功、旧事件顺序 | 2、5、7 |
| 今日要点、材料拖入、键盘、异常和清理 | 4、5、8 |
| 窗口尺寸、透明CSS、多屏/面板/生产页面加载 | 3、7、8 |
| 邮箱并行、共享文件所有权、引擎改动不冲突 | 1、5、7；第1节 |
| 素材分发未核实、静态图不等于已实现 | 1、8；设计第2节 |

本计划的复杂度来自保留既有交互与生命周期正确性，不是增加新的角色功能。禁止顺便接入原参考项目的插件、外部API、语音或记账，禁止升级成多表情生产线。出现确需扩大接口/范围的问题，更新设计并由用户确认后再实施。

## 4. 本轮交付和后续执行

本轮仅编写设计、8个实施任务、共享契约、测试范例和验收规则，并回填旧细则；不复制素材进运行目录、不安装依赖、不实现功能、不创建分支或自动启动并行任务。

进入实施时可选：subagent-driven-development 按分区派发并逐项评审，或 executing-plans 在当前任务按检查点推进。用户当前要求“先充分细化”，因此本文完成后停在文档交付，不自动切换执行。

## 5. 技术参考（2026-09-15 核对）

- 原生窗口的本地页面加载与显示生命周期参考 [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)；版本行为仍按仓库锁定 Electron 实测。
- workArea 与 DIP 坐标使用 [Electron screen](https://www.electronjs.org/docs/latest/api/screen) 的接口，不由 renderer 自行缩放主进程坐标。
- 窗外输入捕获参考 [Pointer Capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)，捕获不替代 cancel/blur/卸载清理。
- 系统减少动画设置参考 [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)。
