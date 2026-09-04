## Context

当前桌面前端通过 `fileType.ts` 按扩展名选择 viewer，`FilePreviewModal.tsx` 负责预览分发，文本内容和文件变更轮询分别复用 `/workspace/file` 与 `/workspace/file/stat`。Draw.io 尚无专用类型或 viewer；普通 XML 当前作为代码预览。

Electron 已暴露通用 `openPath` IPC。待合入 PR #29 在 `WorkspacePanel.tsx` 中为所有本地文件增加“单击延迟预览、第二次点击交给系统默认程序”的行为，并限制下载按钮只在云端显示。本设计必须建立在该 PR 之上，不能形成第二套点击状态机或本地打开通道。

安全约束的关键边界是：Draw.io 图表内容不可信且预览必须完全离线，但应用的 BrowserPanel、HTML viewer 等既有功能仍可能合法访问网络。因此隔离只能位于 Draw.io viewer 自己的执行上下文，不能位于 Electron session 或整个 SPA。

预览还存在两个必须分离的地址空间：viewer 静态资源属于本地 SPA 的资源根，工作区图表数据属于当前会话的后端。即使未来恢复云端会话，远端只提供图表数据，不能被要求同时部署桌面端 vendor 资产。

## Goals / Non-Goals

**Goals:**

- 以固定、可审计的官方 diagrams.net viewer 资源渲染 `.drawio` 和 `.dio`。
- 把不可信图表限制在无同源权限、无外网能力的只读 iframe 内。
- 在读取正文前执行 40 MiB 门控，并沿用现有会话定址与自动刷新机制。
- 与 PR #29 合并后保持一套统一的本地文件双击打开行为。
- 让开发构建和打包后的 Electron 应用都能在断网环境中预览。

**Non-Goals:**

- 不在应用内编辑或保存 Draw.io 文件。
- 不探测或捆绑本地 draw.io 桌面程序；双击结果由操作系统文件关联决定。
- 不把 `.xml` 或其他图形格式归入 Draw.io viewer。
- 不增加全局 Electron `webRequest` 规则、主窗口 CSP 或通用网络代理。
- 不改变 BrowserPanel、HTML viewer、其他文件 viewer、云端下载或非 Draw.io 文件双击行为。
- 不同步实现 `frontend-desktop-v2`；当前产品打包目标仍是 `frontend-desktop`，v2 转正时需单独迁移该能力。

## Decisions

### 1. 直接随包固定官方 viewer，而不依赖在线嵌入服务或第三方 React 包

正式实现前先执行阻塞式 feasibility spike：针对候选的固定官方发布版本，使用真实 `viewer.min.js`、`sandbox="allow-scripts"` 和父子 `postMessage` 渲染一份多页面、多图层 fixture，并实际操作缩放、适配、页面切换和图层可见性。spike 还必须证明 bootstrap 可以接管默认 DOM 扫描、所需 API 在该发布版本中可达、且严格 CSP 下没有运行时外部请求。任一 SHALL 能力无法成立时立即停止后续任务，先通过 OpenSpec 更新规格/设计；不得在实现中静默降级。

从官方 diagrams.net 发布物中提取只读 viewer 所需的最小运行时，存放在 `frontend-desktop/public/vendor/drawio/<version>/`。目录同时保存版本、上游来源、文件校验和及许可证/NOTICE；版本升级必须作为显式依赖变更审查。Vite 的 `public` 资源复制机制会把它带入 `dist`，现有 PyInstaller/Electron 打包链路继续整体收录 `frontend-desktop/dist`。

选择直接固定官方资源，是因为在线 Embed Mode 与完全离线要求冲突；`react-drawio` 等封装仍依赖在线嵌入协议；调研到的新兴通用 file-viewer 适配层发布和可获取性尚不足以作为生产依赖。调用本地 draw.io 生成图片也不适合作为预览主路径，因为它要求用户预装程序、引入进程生命周期，并不能稳定提供页面和图层交互。

只提交运行必需的 viewer、图形库、字体及样式资源，不复制完整编辑器源码。实现时通过 fixture 验证常见压缩/未压缩、多页面、中文、内嵌图片和标准 stencil，缺少资源时补入固定资源清单，而不是运行时回退到 CDN。bootstrap 对 stencil registry 的未命中进行记录：单个未随包 stencil 只产生非阻塞警告并保留其他可渲染内容，不触发联网补取或整图失败。

固定版本只在以下事件触发升级评估：影响随包代码/资源的安全公告、受支持 fixture 或用户格式因版本过旧无法解析、打包所用 Chromium 与 viewer 不兼容，或产品明确要求新的只读能力。每次升级都必须更新来源与校验和，并重跑 spike、格式兼容、安全隔离和打包测试。

### 2. Draw.io 是独立的精确扩展名路由

在 `PreviewType` 中新增 `drawio`，仅由大小写不敏感的 `drawio`、`dio` 扩展名触发。`xml` 继续命中现有 `CODE_LANGS.xml`。`FilePreviewModal.tsx` 增加 `DrawioViewer` 分支。路径不变而 `reloadToken` 变化时保留同一个外层 iframe，通过消息协议更新其内部 GraphViewer；只有路径切换或组件卸载才销毁隔离上下文。

`WorkspacePanel.tsx` 的改动被限制为在 PR #29 合入后的 `getFileStyle` 中增加 Draw.io 图标/颜色（若产品仍需要）。不得修改 PR 的 `handleClick`、250 ms 判定、`onOpenLocal`、`shell.openPath` 或云端下载条件。因此 Draw.io 单击自然进入预览，双击自然复用通用本地打开；其他文件完全沿用 PR 行为。

### 3. 先 stat 门控，再读取正文，再创建 viewer

`DrawioViewer` 维护两个互不替代的 base：

- `workspaceDataBase` 来自 `usePreviewBase()`，用于当前会话的 `/workspace/file/stat` 与 `/workspace/file/raw`；云端会话时它可以是远端地址。
- `viewerAssetBase` 从 `document.baseURI`/`import.meta.env.BASE_URL` 解析，始终指向承载 SPA 的本地应用资源根，用于 `/vendor/drawio/<version>/...`；它绝不从会话 base 推导。

只有 stat 成功且 `size <= 40 * 1024 * 1024` 时才创建或复用 iframe，并从同一 `workspaceDataBase` 请求 `/workspace/file/raw`。正文不再经过 `/workspace/file` 的 JSON 包装：父页面读取 `ArrayBuffer`，通过 transferable `postMessage` 把所有权转移给 iframe，由 iframe 使用 fatal UTF-8 decoder 解码并解析。这消除 JSON 转义/解析膨胀和结构化克隆整份正文的额外副本。

stat 失败或缺少有效 size 时进入错误状态；超限时进入 `too-large` 状态，不请求 raw 正文也不初始化 viewer。为缩小 stat 后文件增长的竞态，raw 响应若声明超过阈值的 `Content-Length` 则立即取消消费；取得 buffer 后也重新核对字节数，超限即停止解析。

数据流如下：

```text
.drawio/.dio 单击
  -> workspaceDataBase /workspace/file/stat
  -> size > 40 MiB：停止并显示降级提示
  -> size <= 40 MiB：workspaceDataBase /workspace/file/raw 读取 ArrayBuffer
  -> transferable postMessage 发送到 Draw.io 专属 sandbox iframe
  -> iframe 从 viewerAssetBase 加载本地 viewer 并回报 rendered/warning/error
```

现有 `useAutoRefresh` 继续只在预览可见且窗口活跃时轮询 mtime；`reloadToken` 变化会重新执行 stat 门控后再加载。文件可能在 stat 与读取之间变化，这是现有两端点方案的固有竞态；Content-Length/buffer 二次检查负责安全失败，但本变更不为此新增后端 API。40 MiB 是已确认的产品边界，不在本变更中引入配置面。

### 4. 网络限制只存在于 Draw.io iframe

`DrawioViewer` 创建一个仅含 `sandbox="allow-scripts"` 的 iframe，不授予 `allow-same-origin`、弹窗、表单、下载或顶层导航能力。iframe 的启动文档使用只对自身生效的 CSP：默认拒绝资源，`connect-src 'none'`，脚本/样式/字体/图片仅按需要允许 `viewerAssetBase` 下的固定 vendor 资源以及 `data:`/`blob:` 内嵌内容。所有 viewer 依赖必须预加载为本地静态资源，不能通过 XHR 补取 stencil；云端 `workspaceDataBase` 不进入 iframe 的资源白名单。

图表 XML 不直接拼接为可执行 HTML。父页面在 iframe 报告 ready 后，通过带随机 capability token 的 `postMessage` 发送纯数据；iframe 只接受预期消息结构。因为无同源 sandbox 的来源是 opaque origin，父页面接收消息时必须同时校验 `event.source === iframe.contentWindow` 和 token，不能只依赖 `event.origin`。iframe 内部以捕获阶段阻止链接点击、辅助点击和键盘导航，配合 sandbox/CSP 避免图表链接产生外部导航。

生产代码不注册 Electron session 级 `webRequest` 监听器，也不修改主窗口或其他 iframe 的 CSP。安全测试可以观察浏览器请求，但断言和阻断范围必须按 Draw.io iframe 的 frame/initiator 过滤；不得把测试用拦截器带入生产路径。这样远程图片、字体和链接在 Draw.io 中失效，而 BrowserPanel、HTML 预览和其他 viewer 的行为不变。

### 5. viewer 生命周期采用明确握手和可恢复错误

父子上下文使用最小消息协议：`ready`、`render`、`rendered`、`warning`、`error`、`snapshot` 以及只读查看命令。每个 iframe 实例有独立 token；路径变化或卸载会使旧 token 失效，刷新序号用于拒绝迟到的旧 render。初始化和渲染设置超时，以区分资源缺失、脚本初始化失败与图表解析失败。

缩放、适配、页面和图层能力复用已由 spike 验证的官方 GraphViewer 只读 API/控件，或由 `DrawioViewer` 提供宿主侧按钮并通过同一消息协议调用；协议不暴露任何修改或保存命令。错误和 stencil 警告 UI 使用可本地化的状态码，不显示未经处理的图表内容或堆栈。

同一路径刷新前，bootstrap 返回当前 page ID/index、scale、translate 和可见 layer IDs。新内容在 iframe 内的暂存容器完成渲染后，若对应页面/图层仍存在则恢复快照再交换可见容器；不存在的 ID 被丢弃并回退到新文件默认值。刷新失败时保留上一份已渲染视图并显示非阻塞错误，避免外部 draw.io 频繁自动保存导致整帧闪烁或反复跳回第一页。

超限、解析失败和资源缺失均不启动在线 fallback。本地会话的提示可引导用户双击用系统关联程序打开；云端会话只说明无法预览，因为服务器路径不能交给本机程序。

### 6. 测试分层覆盖契约与打包结果

- 扩展名单元测试锁定 `.drawio`/`.dio` 路由，并锁定 `.xml` 仍为代码预览。
- loader/component 测试锁定 40 MiB 等于边界可读取、大于边界不发正文请求、不创建 iframe，stat 失败同样停止。
- fixture 测试覆盖压缩/未压缩、多页面、中文、内嵌图片、标准 stencil、未随包 stencil、非法 XML、自动刷新和查看状态恢复。
- iframe 安全测试使用含远程图片、字体、脚本和链接的恶意 fixture，确认 Draw.io frame 无外部请求/导航，同时用回归测试确认 HTML viewer 或 BrowserPanel 未被全局阻断。
- 双 base 测试使用远端会话数据源和本地 SPA 资源源，确认 raw/stat 走会话 base，而所有 viewer 资产只走本地应用资源根。
- PR #29 的文件行测试继续作为双击与云端下载行为的权威测试；本变更只补 Draw.io 集成用例，不复制该状态机测试。
- 构建完整性测试校验 vendor manifest、必要文件、许可证和校验和；打包 smoke test 在断网条件下加载成品资源并完成一次渲染。

## Risks / Trade-offs

- [官方 viewer 资源体积增加安装包] → 只收录经 fixture 验证的只读运行时和所需标准资源，并在版本清单中记录体积。
- [上游 viewer 的页面/图层 API 或 sandbox 集成不满足规格] → 将真实发布物 spike 设为第一道阻塞门禁，失败时先修订 OpenSpec 而非继续实现。
- [上游 viewer 的资源路径假设导致开发环境可用、打包后失败] → 静态资源只从 `viewerAssetBase` 构造，并对 `vite build` 产物和 Electron 打包产物分别执行完整性检查。
- [云端会话把 vendor 资源错误定址到远端] → 将 `workspaceDataBase` 和 `viewerAssetBase` 建模为不同来源，并用双源集成测试锁定。
- [CSP 过严使部分 stencil 或字体无法显示] → 将必需资源转为随包预加载项，通过 fixture 扩充明确白名单，不开放 `connect-src` 或 CDN。
- [40 MiB 上限仍可能造成较高的解码、XML 和 DOM 峰值内存] → 用 raw + transferable ArrayBuffer 消除 JSON/克隆副本，先 stat 并二次核对字节数，在真实 40 MiB 边界 fixture 上记录峰值与响应性；若成品不可接受则回到产品规格重新决定阈值，不在实现中暗改。
- [频繁自动保存导致刷新闪烁或查看位置丢失] → 在同一 iframe 内暂存渲染并按 page/layer ID 恢复视图快照，失败时保留上一有效视图。
- [无同源 iframe 的消息通道使用 `*` target origin] → 使用不可预测的实例 token、严格消息 schema 和 `event.source` 校验，并在卸载时撤销监听。
- [PR #29 未合入或合入后冲突] → 实现第一步先合并/变基到 PR #29 并运行其测试；Draw.io 变更不得重写文件行点击逻辑。
- [系统未安装或未关联 draw.io] → `shell.openPath` 的既有失败处理保持权威，预览功能不承担安装探测或修复。

## Migration Plan

1. 对候选官方版本完成阻塞式 spike；若任一 SHALL 能力不成立，停止并先修订本变更。
2. 合入 PR #29，确认本地双击和云端下载测试通过。
3. 固定并审计已通过 spike 的 viewer 版本及运行资源，提交 manifest、校验和和许可证。
4. 加入 Draw.io 类型、raw/transferable loader、隔离 viewer、文案和图标，不改通用点击/IPC。
5. 运行前端单元/组件测试、离线浏览器测试和生产构建；将完整 Electron 成品离线 smoke 作为合并/发布门禁，而非日常测试内循环。
6. 发布不需要数据迁移。回滚时删除 Draw.io 路由、组件和 vendor 资源即可；PR #29 的通用本地打开行为保持不变。
