## Purpose

为工作区中的 Draw.io 图表提供完全离线、安全隔离的只读预览，同时保持现有文件预览、浏览器访问和本地双击打开行为不受影响。

## ADDED Requirements

### Requirement: Draw.io 文件路由
系统 SHALL 将扩展名（大小写不敏感）为 `.drawio` 或 `.dio` 的工作区文件路由到 Draw.io 只读预览，并 SHALL NOT 将其他扩展名路由到该预览器。

#### Scenario: 单击 Draw.io 文件
- **WHEN** 用户在工作区文件列表中单击一个 `.drawio` 或 `.dio` 文件
- **THEN** 系统在右侧预览标签中打开 Draw.io 只读预览

#### Scenario: 普通 XML 不被接管
- **WHEN** 用户单击一个 `.xml` 文件
- **THEN** 系统继续使用现有代码或文本预览行为，且不初始化 Draw.io 预览

### Requirement: 离线只读渲染
系统 SHALL 使用随应用打包的资源离线渲染有效的 Draw.io 文件，支持常见压缩与未压缩图表、多页面图表、中文文本、内嵌图片及随包提供的标准图形库。预览 SHALL 提供缩放、适配视图、页面切换和图层查看能力，但 SHALL NOT 提供编辑、保存或覆盖源文件的能力。当图表引用未随包提供的 stencil 时，系统 SHALL 继续渲染其他受支持内容、显示非阻塞的不完整预览警告，并 SHALL NOT 联网补取缺失资源或仅因单个 stencil 缺失而让整个预览失败。

#### Scenario: 查看常见 Draw.io 图表
- **WHEN** 用户预览一个不超过大小限制的有效 Draw.io 文件
- **THEN** 系统无需连接公共网络即可显示其图表内容，并允许用户使用只读查看操作

#### Scenario: 预览不修改源文件
- **WHEN** 用户在预览中缩放、切换页面、查看图层或关闭预览
- **THEN** 系统不写入或替换工作区中的源文件

#### Scenario: 图表引用未随包 stencil
- **WHEN** 有效 Draw.io 文件引用未包含在本地资源清单中的 stencil
- **THEN** 系统显示所有可渲染内容和非阻塞警告，不联网获取 stencil，且不把整个文件判定为无法预览

### Requirement: Draw.io 专属网络隔离
系统 SHALL 阻止 Draw.io 预览上下文发起外部网络连接、加载远程图片或字体以及通过图表链接导航到外部地址。该限制 SHALL 仅作用于 Draw.io 预览，不得添加应用级全局网络拦截，也不得改变 BrowserPanel、HTML 预览或其他文件预览器的既有网络行为。

#### Scenario: 图表包含远程资源
- **WHEN** Draw.io 文件引用远程图片、字体、脚本或其他网络资源
- **THEN** Draw.io 预览不发出对应的外部网络请求，且仍保持宿主应用隔离

#### Scenario: 图表包含外部链接
- **WHEN** 用户在 Draw.io 预览中激活一个外部链接
- **THEN** 预览不导航到该地址，也不通过该操作发起外部网络访问

#### Scenario: 其他功能不受限制
- **WHEN** 用户使用 BrowserPanel、HTML 预览或非 Draw.io 文件查看器
- **THEN** 系统保持这些功能在本变更前的网络行为

### Requirement: 40 MiB 预览上限
系统 SHALL 在读取 Draw.io 文件正文和初始化预览器之前检查文件大小。大小大于 `40 * 1024 * 1024` 字节的文件 SHALL NOT 被读取用于预览；大小等于或小于该值的文件 SHALL 可继续进入正常预览流程。

#### Scenario: 文件处于允许边界
- **WHEN** Draw.io 文件大小等于 40 MiB
- **THEN** 系统允许读取并尝试预览该文件

#### Scenario: 文件超过允许边界
- **WHEN** Draw.io 文件大小大于 40 MiB
- **THEN** 系统不读取文件正文、不初始化 Draw.io viewer，并提示文件过大；仅在支持本地打开的会话中提示可双击使用本地软件打开

#### Scenario: 无法取得文件元数据
- **WHEN** 系统无法取得待预览 Draw.io 文件的大小元数据
- **THEN** 系统显示可恢复的预览错误，且不读取文件正文或初始化 Draw.io viewer

### Requirement: 预览刷新与失败降级
系统 SHALL 在预览可见且应用活跃时检测源文件修改，并在修改后重新加载 Draw.io 预览。刷新同一路径时，系统 SHALL 在对应页面和图层仍存在的情况下恢复当前页面、缩放/平移和图层可见状态；目标状态已不存在时 SHALL 回退到新文件的有效默认视图。对于无效或不兼容的图表、读取失败以及本地 viewer 资源缺失，系统 SHALL 显示错误状态并 SHALL NOT 回退到公共 CDN 或在线 viewer。

#### Scenario: 源文件发生变化
- **WHEN** 可见预览对应文件的修改时间发生变化
- **THEN** 系统重新读取符合大小限制的文件并刷新图表内容

#### Scenario: 刷新后恢复仍然有效的查看状态
- **WHEN** 同一路径的文件刷新后仍包含用户当前查看的页面和图层
- **THEN** 系统恢复该页面、缩放/平移和图层可见状态，避免把用户重置到初始视图

#### Scenario: 刷新后的目标状态已经消失
- **WHEN** 同一路径的文件刷新后不再包含先前页面或图层
- **THEN** 系统忽略失效状态并显示新文件的有效默认页面和图层状态

#### Scenario: 图表无法解析
- **WHEN** Draw.io 文件格式无效或与随包 viewer 不兼容
- **THEN** 系统显示可恢复错误，并仅向支持本地打开的会话提示可双击使用本地软件打开

#### Scenario: 随包 viewer 资源缺失
- **WHEN** Draw.io viewer 的必要本地静态资源不可用
- **THEN** 系统显示安装或打包完整性错误，且不尝试从网络获取替代资源

### Requirement: 复用既有本地打开行为
在具备 Electron 本地打开能力的本地会话中，Draw.io 文件的双击打开 SHALL 复用工作区文件的既有系统默认程序打开流程。该能力 SHALL NOT 引入 Draw.io 可执行文件探测、专用 IPC 或第二套双击判定逻辑，并 SHALL NOT 改变其他文件类型或云端文件的既有双击与下载行为。

#### Scenario: 本地双击 Draw.io 文件
- **WHEN** 用户在本地会话中双击 `.drawio` 或 `.dio` 文件
- **THEN** 系统通过既有本地文件打开流程把原文件交给操作系统关联程序

#### Scenario: 云端 Draw.io 文件
- **WHEN** 用户在云端会话中操作 `.drawio` 或 `.dio` 文件
- **THEN** 系统提供应用内只读预览，但不尝试在本机打开不存在的服务器端路径

#### Scenario: 其他文件的双击行为保持不变
- **WHEN** 用户双击非 Draw.io 文件
- **THEN** 系统保持工作区既有的本地打开或云端行为，不由 Draw.io 功能拦截该操作
