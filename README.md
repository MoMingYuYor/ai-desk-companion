<div align="center">

# 🐱 事务助手

**一款桌面 AI 事务助手 —— 把每一条通知,变成日程表上确定的安排。**

拖入群通知、收到的邮件、截图文件,AI 帮你提炼时间、地点、事件、参与人,
确认一下,就进了日历和待办。还有一只会提醒你休息的 Q 版桌宠。

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-231%20passing-brightgreen)
![Local First](https://img.shields.io/badge/data-local%20first-orange)

**[⬇️ 下载安装包](../../releases) · [🛠️ 本地开发](#-本地开发) · [🗺️ Roadmap](#-roadmap)**

<!-- 📸 截图位:运行 `npm run dev` 后截图,放入 docs/screenshots/ 并替换下方图片
<img src="docs/screenshots/workbench.png" width="800" alt="工作台" />
<img src="docs/screenshots/pet.png" width="320" alt="桌宠" />
-->

</div>

---

## ✨ 它能做什么

### 📬 通知不再只躺在聊天记录里
把群消息文本、邮件、PDF、截图**直接拖给桌宠**,AI 综合所有材料生成一份结构化分析:
重点摘要、候选日程、待办建议、材料之间的时间冲突、缺失信息待确认——
你看一眼,点"加入",事情就安排好了。

### 📧 多邮箱统一收件
QQ 邮箱、163、Gmail、自定义 IMAP,多个账号统一收进一个收件箱。
**收信和阅读不花一分 AI 额度**,看到值得安排的邮件,再手动点"AI 分析"。
授权码系统级加密保存、协议只读不碰你的服务器状态,每 5 分钟后台静默收信。

### 🐱 一只真的会帮事的桌宠
不是摆设:拖通知给它就是分析、到点提醒会弹气泡、分析时轻晃表示忙碌、
点击一下告诉你今天几节课几个日程。坐姿、呼吸、按压回弹,细节都在。

### 🧠 什么模型都能稳定提取
自建**提取契约层**:不管你接的是哪家模型、能力强弱,
输出字段统一校验、格式坏了自动修复一次、还不行就按你配置的备用模型顺序自动切换——
你永远只看结果,不用手动重试。

### 📅 日历 · 待办 · 课表 · 提醒
- 月视图日历,课程与日程同屏
- 待办支持优先级、**截止时间与执行时段分离**(改期执行不动截止)
- 课表/校历图片一键导入,单双周、指定周次、调课停课都支持
- 提醒引擎独立于 AI 运行,**模型全挂了提醒照响**

### 🔒 本地优先,数据在你手里
所有数据存在本机 SQLite,无云端、无账号体系;
API Key 与邮箱授权码系统级加密;手动一键备份/恢复。

---

## 🎬 三步上手

| 1️⃣ 喂给它 | 2️⃣ 确认一下 | 3️⃣ 到点提醒 |
| --- | --- | --- |
| 拖通知/邮件/文件给桌宠,或粘贴进工作台 | AI 产出候选日程/待办,改改时间地点,点"加入" | 独立提醒引擎到点弹窗 + 桌宠气泡 |

---

## 📥 安装

### 普通用户(Windows)

从 [Releases](../../releases) 下载最新安装包(NSIS 安装向导),双击安装即可。

### 本地开发

```bash
git clone <repo-url>
cd 待办
npm install        # 安装依赖
npm run dev        # 开发模式启动
npm test           # 运行测试(231 例)
npm run dist       # 打包 Windows 安装包
```

> 若 Electron 二进制下载失败,执行 `node node_modules/electron/install.js` 后重试。

## 🚀 配置指引

1. **模型服务(必配)**:设置 → 模型服务 → 填入任意 OpenAI 兼容接口的地址、API Key、默认模型。可配置多个,自动故障切换。服务商支持结构化输出时勾选"JSON 结构化输出"。
2. **邮箱(可选)**:工作台 → 邮箱 → 添加账号。QQ/163 使用客户端授权码,Gmail 使用应用专用密码。
3. **课表/画像(可选)**:导入课表图片、填写作息偏好,让安排建议更懂你。

## 🗺️ Roadmap

- [x] 通知分析、候选确认、指纹去重
- [x] 多邮箱收件 + 手动 AI 分析 + 来源追溯
- [x] Q 版桌宠形象接入与轻量动画
- [x] 提取契约层:跨模型统一提取、自动修复、按序降级
- [ ] 改期/取消自动匹配原事项,一键更新
- [ ] 结合课表空闲时段智能推荐安排时间
- [ ] 全局搜索(材料/会话/事项)
- [ ] Gmail OAuth 登录、更多服务商预设
- [ ] 安装包签名与自动更新

## 🧱 技术架构

```
Electron 37 · React 19 · TypeScript 5 · sql.js (SQLite/WASM)
├─ 主进程  会话引擎 · 提取契约层 · 模型路由 · IMAP 同步调度 · 提醒服务 · 桌宠原生辅助
├─ 渲染层  工作台(聊天/邮箱/日历/待办/课表) · 桌宠窗口 · 今日面板
└─ 共享层  类型化 IPC 契约 · 提取 schema · 邮箱 DTO · 日期工具
```

测试:Vitest,29 个文件 / 231 个用例,覆盖协议集成、业务规则(去重/降级/自愈)与 UI 组件。

## 📄 许可证

代码许可证将于正式发布时在此注明。
桌宠形象素材为用户授权内容,公开分发前需单独核实许可(见 [ASSET-SOURCES.md](src/renderer/pet/assets/ASSET-SOURCES.md))。

---

<div align="center">

如果这个项目对你有帮助,欢迎点一个 ⭐

</div>
