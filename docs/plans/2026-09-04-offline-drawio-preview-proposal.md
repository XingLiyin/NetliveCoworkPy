## Why

工作区右侧文件管理目前无法直观查看 Draw.io 图表，用户只能离开应用或手动寻找本地程序。需要为图表提供安全、完全离线的只读预览，同时复用待合入 PR #29 的本地文件双击打开能力，避免引入第二套文件交互逻辑。

## What Changes

- 在右侧文件预览中识别 `.drawio` 和 `.dio`，使用随桌面端打包的固定版本官方 diagrams.net viewer 进行只读渲染。
- 支持缩放、适配视图、页面和图层查看，不提供编辑或保存交互。
- Draw.io 预览使用独立 sandbox iframe，并仅在该 iframe 内禁止外部网络访问；不改变 BrowserPanel、HTML 预览或其他文件查看器的网络行为。
- 预览前检查文件大小；超过 40 MiB 时不读取正文或初始化 viewer，并仅在支持本地打开的会话中提示用户双击使用本地软件打开。
- 文件变化时自动刷新预览；解析失败、资源缺失或格式不兼容时显示可恢复错误提示。
- 在 PR #29 合入后复用其双击 `shell.openPath` 路径打开原文件，不复制或改写双击判定、Electron IPC 与云端下载行为。
- 普通 `.xml` 文件继续按现有代码/文本规则预览，不被 Draw.io 逻辑接管。

## Capabilities

### New Capabilities

- `workspace/drawio-preview`: 定义工作区 Draw.io 文件的离线只读预览、格式路由、安全隔离、大小限制、自动刷新及本地打开兼容行为。

### Modified Capabilities

无。

## Impact

- 前端文件类型识别、预览分发、右侧文件图标和新的 Draw.io viewer 组件。
- 桌面端静态资源与打包清单将包含固定版本 diagrams.net viewer、所需 shapes/stencils/fonts 及许可证文件。
- 工作区文件读取流程需要在读取 Draw.io 正文前利用现有 stat 接口执行 40 MiB 门控。
- 不新增后端公共 API，不新增全局网络拦截，不改变其他预览器或浏览器面板。
- 实现顺序依赖 PR #29；合入时只在其文件行逻辑上增加 Draw.io 类型/图标适配，不修改其双击和下载策略。
- 本地文件单击预览前的 250 ms 等待来自 PR #29 为区分单击与双击而引入的通用策略，并非本变更新增的 Draw.io 专属延迟。
