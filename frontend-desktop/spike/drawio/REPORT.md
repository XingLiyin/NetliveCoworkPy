# Draw.io 只读预览可行性 spike 报告（任务 1.1 阻塞门禁）

**结论：8/8 通过，门禁放行。** 生产实现按本报告的验证路径走。

## 验证环境

- 官方 `viewer.min.js`，`VERSION="31.4.2"`，SHA-256
  `3810b944463d342daa438e0bf7793addbcc96531269c4aea26907142b1a38d0a`，
  来源 `https://viewer.diagrams.net/js/viewer.min.js`（下载于 2026-09-04）。
- Chromium（系统 Edge，headless）+ 本地静态服务（127.0.0.1:4177）。
- iframe：`sandbox="allow-scripts"`（无 allow-same-origin，opaque origin），
  文档自带 CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'`。
- fixture：2 页（中文节点），第 2 页含 2 个图层。

## 结果矩阵

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| A | bootstrap 程序化接管（非 data-* 自动扫描） | PASS | sandbox iframe 内渲染出 SVG |
| B | 零外部请求 | PASS | 整个会话 6 个请求全部 127.0.0.1 |
| C | 多页面：解析 2 页 + 切换 | PASS | 页名/内容随 setPage 变化 |
| D | 图层可见性：隐藏/恢复 | PASS | 隐藏图层B后其节点从 SVG 消失，恢复回来 |
| E | 缩放 | PASS | scale×2 生效 |
| F | 适配视图 | PASS | fit 计算出 scale=1.689… |
| G | transferable ArrayBuffer + fatal UTF-8 解码 | PASS | 父端 buffer detached，子端解码渲染成功 |

## 生产实现必须沿用的四个关键事实

1. **用 drawio 的 `Graph`（全局类，单参构造 `new Graph(container)`），不要用裸 `mxGraph`**：
   样式管线（自适应配色等）挂在 Graph 上，裸 mxGraph 渲染即抛
   `getAdaptiveColors is not a function`（实测踩到）。
2. **`window.MathJax = window.MathJax || {}` 存根必须在 viewer.min.js 之前执行**：
   `Editor.initMath` 的守卫是 `typeof window.MathJax === 'undefined'`，不预置就会在加载时
   尝试外联 `https://viewer.diagrams.net/math4/es5/startup.js`。存根 = 数学排版显式降级、
   连"尝试"都不发生。
3. **图层可见性必须走 `graph.getModel().setVisible(layer, vis)`**（在 begin/endUpdate 内）：
   直接 `layer.setVisible(...)` 绕过变更记录，endUpdate 拿到空 edit，视图不刷新（实测踩到）。
4. **消息协议在 opaque origin 下只能靠 `event.source` + 实例 token 双验**：
   `event.origin` 是字符串 `"null"`，不可用。脚本一律外链（内联被 `script-src 'self'` 挡）。

## 其他记录

- 官方 `GraphViewer` 自带 `page`/`pageId` 配置与 `toolbar: 'zoom layers'` 控件项——
  宿主侧自绘按钮（本 spike 路线）与官方控件（备选路线）都可行；生产按 design 决策 5
  优先官方控件、不全则宿主侧补。
- viewer.min.js 内嵌完整 mxClient（mxUtils/mxCodec/mxGraph/Graph/Editor 全局可达），
  标准 stencil 内建，未发现渲染基础图表所需的外部资源依赖。
- 压缩形态 `<diagram>`（base64+deflate）：spike fixture 用明文；生产实现需在解析处补
  inflate（mxUtils 有现成例程），列入任务 5.1 的 fixtures。

## 复跑

```bash
curl -sSL -o frontend-desktop/spike/drawio/viewer.min.js https://viewer.diagrams.net/js/viewer.min.js
cd frontend-desktop && node spike/drawio/run-spike.mjs
```

（viewer.min.js 2.6MB 不入 git；正式固化在任务 1.3 的 public/vendor 目录。）

## 任务 1.4 补充：vendored 副本断网验证（3/3 通过）

对 `public/vendor/drawio/31.4.2/` 正式副本 + `public/drawio-preview/` 生产 bootstrap，
用 Playwright 路由拦截把一切非 127.0.0.1 请求硬 abort（连尝试都记为失败）：

- PASS vendored viewer + 生产 bootstrap 断网渲染出 SVG（viewer/标准 shapes/系统字体无需 XHR）
- PASS 多页面解析正常
- PASS 零外部请求尝试（CSP + MathJax 存根兜底）

复跑：`node spike/drawio/run-offline-verify.mjs`
