## 1. 可行性门禁、集成基线与上游资源

- [x] 1.1 执行阻塞式 feasibility spike：用候选固定版本的真实官方 `viewer.min.js`、`sandbox="allow-scripts"`、transferable `postMessage` 和多页面/多图层 fixture，验证缩放、适配、页面切换、图层可见性、bootstrap 接管与零外部请求；任一 SHALL 能力失败时停止后续任务并先更新 OpenSpec，全部通过才可继续。（结果：8/8 通过，见 frontend-desktop/spike/drawio/REPORT.md）
- [x] 1.2 在实现分支合入或变基到 PR #29，先为其通用文件行行为补充/运行特征测试，验证本地文件单击预览、250 ms 内第二次点击调用既有 `openPath`、云端文件不调用本地打开且下载按钮仍只在云端显示。
- [x] 1.3 固定通过 spike 的官方 diagrams.net 发布版本，提取只读 viewer 的最小离线运行资源到 `frontend-desktop/public/vendor/drawio/<version>/`，提交来源、版本、SHA-256 清单、LICENSE/NOTICE 以及安全公告/格式兼容/Chromium 兼容三类升级触发条件；先增加资源完整性测试，再验证必要文件校验和正确且资源中没有 CDN fallback 配置。（版本 31.4.2，7 项完整性测试通过）
- [x] 1.4 用最小独立 HTML fixture 验证固定 viewer 在 `connect-src 'none'` 条件下无需 XHR 即可加载 viewer、标准 shapes/stencils 和字体；缺失资源必须补入清单，验证浏览器断网运行仍能渲染基础图表。（3/3 通过，含零外部请求尝试；run-offline-verify.mjs）

## 2. 文件类型与预览分发

- [x] 2.1 先扩展 `frontend-desktop/src/preview/fileType.test.ts`，覆盖 `.drawio`、`.dio`、大小写路径和 `.xml` 回归，再在 `fileType.ts` 新增精确的 `drawio` 类型；运行该测试验证只有两个目标扩展名被接管。
- [x] 2.2 为 `FilePreviewModal.tsx` 增加组件测试，验证 Draw.io 类型分发到新的 `DrawioViewer`、reload token 传入同一 viewer 实例且其他类型分支不变；实现对应分发后运行测试。
- [x] 2.3 在 PR #29 版本的 `WorkspacePanel.tsx` 中仅增加 Draw.io 文件图标/颜色和必要的国际化文案，不修改 `handleClick`、计时器、`onOpenLocal`、IPC 或下载条件；运行 1.2 的特征测试和 Draw.io 单击/双击集成用例验证无冲突。

## 3. 40 MiB 门控与加载状态

- [x] 3.1 先为 Draw.io 文档 loader 编写测试，覆盖按 `workspaceDataBase` 请求 `/workspace/file/stat`、`size === 40 * 1024 * 1024` 时允许继续、大于边界时不请求正文、stat 失败或 size 无效时安全停止；实现门控后运行测试。
- [x] 3.2 先测试门控通过后只请求同一会话 base 的 `/workspace/file/raw` 而不请求 JSON `/workspace/file`，并覆盖超限 `Content-Length` 取消、buffer 字节数二次检查、transferable ArrayBuffer 交接和 iframe fatal UTF-8 解码；实现传输后运行测试并验证父页面不保留整份正文副本。
- [x] 3.3 增加双 base 集成测试：模拟远端 `workspaceDataBase` 与本地 SPA `viewerAssetBase`，验证 stat/raw 只访问会话端，而 viewer 脚本、样式、字体和 stencil 只从 `document.baseURI`/`import.meta.env.BASE_URL` 下的本地 vendor 目录加载。
- [x] 3.4 为路径切换、请求竞态、卸载取消、reload 序号和错误状态编写测试，再实现加载生命周期；验证旧文件/旧刷新结果不能覆盖当前预览，且超限、读取失败、解析失败、资源缺失、初始化超时均无在线 fallback，并仅在具备本地打开能力时显示双击引导。

## 4. Draw.io 专属隔离 viewer

- [x] 4.1 先为 iframe 启动文档和 sandbox 属性编写测试，再实现 Draw.io bootstrap：只授予 `allow-scripts`，使用仅限该 iframe 的 CSP、`connect-src 'none'` 和明确的本地资源白名单；验证没有修改 Electron session、主窗口 CSP、BrowserPanel 或 `HtmlViewer`。
- [x] 4.2 在 `frontend-desktop/src/preview/viewers/drawio/protocol.test.ts` 为父子消息协议编写单元测试，覆盖随机实例 token、严格消息 schema、`event.source === iframe.contentWindow`、旧 token/旧刷新序号拒绝和卸载清理；实现 `ready/render/rendered/warning/error/snapshot` 握手并验证图表字节只作为数据传递、不拼入可执行 HTML。
- [x] 4.3 使用含远程图片、字体、脚本和外部链接的恶意 fixture 编写浏览器测试，再实现 iframe 内链接点击/辅助点击/键盘导航守卫；验证 Draw.io iframe 不产生外部请求或导航，同时测试用请求观察器只按该 frame/initiator 断言。
- [x] 4.4 为缩放、适配视图、页面切换和图层查看编写交互测试，再接入 spike 已验证的官方 GraphViewer 只读 API/控件或宿主侧只读按钮；验证消息协议不暴露编辑/保存命令，操作前后源文件内容与修改时间不变。

## 5. 格式兼容、刷新与范围回归

- [x] 5.1 增加压缩和未压缩 Draw.io、多页面、中文、内嵌图片、标准 stencil、未随包 stencil 及非法 XML fixtures，运行真实浏览器渲染测试；验证有效 fixture 可见、未知 stencil 只产生非阻塞警告并保留其他内容、非法文件进入可恢复错误状态。
- [x] 5.2 增加文件 mtime 变化的组件/浏览器测试，复用现有 `useAutoRefresh` 可见性门控；验证刷新前采集 page ID/index、scale、translate 和 visible layer IDs，新内容在暂存容器渲染后恢复仍有效状态再交换显示，失效 ID 回退默认值，刷新失败保留上一有效视图，面板隐藏或应用不活跃时不新增轮询。
- [x] 5.3 增加非 Draw.io 范围回归测试：`.xml` 仍为代码预览、非 Draw.io 文件双击仍走 PR #29、HTML viewer 或 BrowserPanel 的外部资源请求仍按既有行为工作；验证生产代码中不存在本功能新增的全局 `webRequest`/全局 CSP 拦截。

## 6. 构建与成品验收

- [x] 6.1 在 `frontend-desktop` 运行全部 Vitest 测试和 TypeScript/Vite 生产构建，验证无测试失败、类型错误或缺失的 Draw.io 静态资源，并检查 `dist/vendor/drawio/<version>/` 与 manifest 一致。
- [x] 6.2 扩展 `electron/test/packaged-layout.test.js` 或等价快速布局测试，验证打包输入和 `frontend-desktop/dist` 包含与 manifest 一致的 Draw.io vendor 文件、许可证和 bootstrap，且不依赖外部 URL。
- [ ] <!-- 发布门禁：合并/发布验收时执行，不进日常 TDD 内循环（本任务刻意不在实现分支勾选） --> 6.3 在合并/发布验收阶段构建一次完整 Electron 成品，并在禁止外网的环境中预览代表性 `.drawio`；验证成品只从本地 `viewerAssetBase` 加载、多页/图层可操作、云端模拟数据仍走 `workspaceDataBase`，同时 BrowserPanel/HTML viewer 未被 Draw.io 隔离策略影响。该重型 smoke 是最终发布门禁，不进入日常 TDD 内循环。
- [x] 6.4 对实现差异做最终范围审计并运行 OpenSpec 严格校验：确认未新增 Draw.io 专用 IPC/可执行文件探测、未改 PR #29 点击状态机、未接管其他扩展名、未引入 CDN/全局请求拦截，且 `openspec validate add-offline-drawio-preview --strict` 通过。
