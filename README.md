<div align="center">

# 事务助手

**本地优先的 AI 个人事务管理工具**

将群通知、邮件与文档等非结构化信息,提炼为可确认的日程与待办;
经用户确认后纳入日历,由独立提醒引擎按时触达。

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-419%20passing-brightgreen)
![Local First](https://img.shields.io/badge/data-local%20--first-orange)

[下载安装包](../../releases) · [本地开发](#本地开发) · [Roadmap](#roadmap)

<!-- 截图位:运行 `npm run dev` 后截图,放入 docs/screenshots/ 并取消下方注释
<img src="docs/screenshots/workbench.png" width="800" alt="工作台" />
<img src="docs/screenshots/pet.png" width="320" alt="桌宠" />
-->

</div>

---

## 核心特性

### 结构化通知分析

将聊天记录、邮件、文档、图片等非结构化材料解析为结构化分析结果:重点摘要、候选日程与待办、材料间的时间冲突,以及缺失信息的待确认清单。分析结果仅作为候选草稿呈现,经用户确认后方写入日历与待办,并通过幂等映射与指纹去重双重机制保证重复确认不产生重复事项。同一事项补充新材料时生成新版本分析,历史版本可回溯。

### 多邮箱聚合

支持 QQ 邮箱、163、Gmail 及自定义 IMAP 服务商,多账号统一收件与阅读。收件、阅读与附件下载全程不调用模型;仅当用户显式触发时,对指定邮件执行 AI 分析,分析结果与原邮件之间保留可追溯来源。凭据经系统安全模块加密存储,协议层强制只读,不修改远端邮件状态;正文与附件按需缓存,HTML 内容经白名单清理后在隔离环境中渲染。

### 桌面伴侣

Q 版桌宠常驻桌面,承担信息入口与状态反馈双重职责:拖入材料即发起分析,提醒触发时弹出气泡,分析进行中呈现忙碌状态。点击与拖动通过位移阈值自动区分,支持键盘操作;角色图片加载失败时自动回退至备用形象,交互始终可用。

### 统一提取管线

针对不同厂商、不同能力等级的模型设计:提取字段以单一 schema 定义,系统提示词与运行时校验由同一份定义生成。解析或校验失败时,自动携带错误反馈请求模型修正;仍未通过则按用户配置的备用顺序切换模型,全部失败才终止并保留各模型失败原因。字段级异常采用降级策略,异常内容计入待确认清单而非整体丢弃。支持 JSON 结构化输出协议的服务商可启用协议级约束。

### 日历与待办

月视图日历中课程与日程同屏呈现。待办支持优先级与分组;截止时间与执行时段相互独立,调整执行安排不影响截止时间,二者可建立关联。课表与校历支持从图片或 PDF 导入,涵盖单双周、指定周次与临时调课场景。

### 提醒调度

提醒引擎独立于模型服务运行,基于本地轮询与防重机制;应用异常退出后重新启动时,自动补报错过的提醒。

### 本地优先

全部业务数据存储于本机 SQLite,不依赖云端服务与账号体系。API Key 与邮箱授权码经系统安全模块加密;支持一键备份导出与恢复,邮箱凭据与收件缓存不进入备份文件,已确认事项及其分析来源完整保留。

## 工作流程

| 1. 输入材料 | 2. 确认事项 | 3. 按时提醒 |
| --- | --- | --- |
| 拖入通知、邮件或文件,亦可粘贴文本 | 审阅候选日程/待办,修正时间地点后确认加入 | 独立提醒引擎按计划弹窗与桌宠提示 |

## 安装

### 普通用户(Windows 便携版)

1. 从 [Releases](../../releases) 下载 `事务助手-*-portable-x64.zip`
2. 解压到任意目录(无需安装、无需管理员权限)
3. 双击 `事务助手.exe` 即可使用

- 数据(日程、待办、邮箱凭据等)全部保存在本机 `%APPDATA%\事务助手\`,删除应用不影响数据
- 首次使用请在「设置 → 模型服务」配置一个 OpenAI 兼容的模型接口
- 未做代码签名,首次运行如遇 SmartScreen 提示,选择「仍要运行」即可

### 本地开发

```bash
git clone <repo-url>
cd 待办
npm install        # 安装依赖
npm run dev        # 开发模式启动
npm test           # 运行测试(419 例)
npm run build      # 构建到 out/
npm run dist       # 打包 Windows 便携 zip
```

> 若 Electron 二进制下载失败,执行 `node node_modules/electron/install.js` 后重试。

## 配置指引

1. **模型服务(必需)**:设置 → 模型服务,填入 OpenAI 兼容接口的地址、API Key 与默认模型,支持配置多个服务商实现自动故障转移;服务商支持结构化输出协议时可启用"JSON 结构化输出"。
2. **邮箱(可选)**:工作台 → 邮箱 → 添加账号。QQ 邮箱与 163 使用客户端授权码,Gmail 使用应用专用密码。
3. **课表与画像(可选)**:导入课表图片、维护个人作息与偏好,使分析结果与安排建议更贴合实际情况。

## Roadmap

- [x] 通知分析、候选确认与去重机制
- [x] 多邮箱收件、手动 AI 分析与来源追溯
- [x] 桌宠形象接入与轻量状态动画
- [x] 统一提取管线:跨模型一致提取、自动修复与按序降级
- [ ] 改期/取消自动匹配原事项,支持一键更新
- [ ] 结合课表空闲时段推荐候选安排时间
- [ ] 全局搜索(材料/会话/事项)
- [ ] Gmail OAuth 登录与更多服务商预设
- [ ] 安装包签名与自动更新

## 技术架构

```
Electron 37 · React 19 · TypeScript 5 · sql.js (SQLite/WASM)
├─ 主进程  会话引擎 · 提取契约层 · 模型路由 · IMAP 同步调度 · 提醒服务 · 桌宠原生辅助
├─ 渲染层  工作台(聊天/邮箱/日历/待办/课表) · 桌宠窗口 · 今日面板
└─ 共享层  类型化 IPC 契约 · 提取 schema · 邮箱 DTO · 日期工具
```

测试基于 Vitest,共 69 个文件、419 个用例,覆盖协议集成、业务规则(去重/降级/自愈)与界面组件三个层面。

## 许可证与版权

**本项目代码版权归作者(MoMingYuYor)所有,保留所有权利。本仓库公开仅用于展示与分发官方构建产物,不构成开源许可:未经作者书面许可,不得复制、修改、再分发本仓库代码及其衍生作品。**

应用内使用的第三方库版权归各自作者所有(sql.js、pdfjs-dist、SheetJS、mammoth、word-extractor、imapflow、mailparser 等,均为 MIT/Apache-2.0 许可)。桌宠形象素材为用户授权内容(见 [ASSET-SOURCES.md](src/renderer/pet/assets/ASSET-SOURCES.md))。

---

<div align="center">

若本项目对你有所帮助,欢迎 Star 支持。

</div>
