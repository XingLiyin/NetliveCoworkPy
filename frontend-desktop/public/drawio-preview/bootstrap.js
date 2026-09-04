/** Draw.io 隔离壳（生产版）。运行在 sandbox="allow-scripts"（无 allow-same-origin）iframe 里。
 *  身份：token 由父页面生成、经 URL 片段传入（#token 不随请求发出），每条消息回显；
 *  父侧另做 event.source 校验。消息一律纯数据。
 *  只读：所有编辑/保存通路不存在；能力 = 渲染/刷新/切页/图层可见性/缩放/适配/快照。
 *  三个 spike 验证过的关键点：用 drawio Graph 而非裸 mxGraph；图层走 model.setVisible；
 *  MathJax 存根（pre.js）必须先于 viewer.min.js 执行。
 */
(function () {
  'use strict';
  var TOKEN = (location.hash && location.hash.length > 1)
    ? decodeURIComponent(location.hash.slice(1))
    : String(Math.random());                       // 无片段时兜底（父不认它，消息会被拒）
  var graph = null;
  var pages = [];
  var current = -1;
  var lastSnapshot = null;                         // 最近一次上报的查看状态（刷新恢复用，任务 5.2）

  function post(msg) { msg.token = TOKEN; parent.postMessage(msg, '*'); }

  function snapshot() {
    var layerInfo = [];
    var root = graph.getModel().getRoot();
    for (var i = 1; i < root.getChildCount(); i++) {
      var layer = root.getChildAt(i);
      layerInfo.push({ id: layer.id, name: layer.value || layer.id, visible: layer.isVisible() });
    }
    return {
      page: current, pageCount: pages.length,
      pages: pages.map(function (p) { return { id: p.id, name: p.name }; }),
      scale: graph.getView().getScale(),
      layers: layerInfo,
      svg: !!document.querySelector('#graph svg'),
    };
  }

  function hiddenIds(s) {
    return s && s.layers ? s.layers.filter(function (l) { return !l.visible; }).map(function (l) { return l.id; }) : [];
  }

  function parsePages(docEl) {
    return Array.prototype.map.call(docEl.getElementsByTagName('mxGraphModel'), function (m) {
      var d = m.parentNode;                        // <diagram>
      return { id: d.getAttribute('id') || '', name: d.getAttribute('name') || '', xml: mxUtils.getXml(m) };
    });
  }

  function renderPage(index, keep) {
    var page = pages[index];
    var container = document.getElementById('graph');
    container.innerHTML = '';
    if (graph && graph.destroy) { try { graph.destroy(); } catch (e) {} }
    graph = new Graph(container);                  // drawio Graph：样式管线（自适应配色等）在它身上
    graph.setCellsEditable(false);
    graph.setConnectable(false);
    graph.setDropEnabled(false);
    graph.setPanning(true);
    graph.setTooltips(true);
    var doc = mxUtils.parseXml(page.xml);
    var codec = new mxCodec(doc);
    codec.decode(doc.documentElement, graph.getModel());
    current = index;
    if (keep && keep.scale) graph.getView().setScale(keep.scale);
    if (keep && keep.hidden && keep.hidden.length) {
      var root = graph.getModel().getRoot(), model = graph.getModel();
      model.beginUpdate();
      try {
        for (var i = 0; i < root.getChildCount(); i++) {
          var layer = root.getChildAt(i);
          if (keep.hidden.indexOf(layer.id) >= 0) model.setVisible(layer, false);
        }
      } finally { model.endUpdate(); }
    }
    return page;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parent) return;
    var msg = ev.data;
    if (!msg || msg.token !== TOKEN) return;
    try {
      if ((msg.type === 'render' || msg.type === 'refresh') && msg.buf instanceof ArrayBuffer) {
        var isRefresh = msg.type === 'refresh';
        var keep = isRefresh && lastSnapshot
          ? { scale: lastSnapshot.scale, hidden: hiddenIds(lastSnapshot) }
          : null;
        var prevPageId = isRefresh && pages[current] ? pages[current].id : null;
        var xml = new TextDecoder('utf-8', { fatal: true }).decode(msg.buf);
        var doc = mxUtils.parseXml(xml);
        if (!doc || !doc.documentElement || doc.documentElement.nodeName !== 'mxfile') {
          post({ type: 'error', code: 'not-mxfile' }); return;
        }
        pages = parsePages(doc.documentElement);
        if (!pages.length) { post({ type: 'error', code: 'empty-file' }); return; }
        var idx = 0;
        if (prevPageId) for (var k = 0; k < pages.length; k++) if (pages[k].id === prevPageId) { idx = k; break; }
        renderPage(idx, keep);
        if (!keep) graph.getView().setScale(1);
        lastSnapshot = snapshot();
        post({ type: 'rendered', state: lastSnapshot });
      } else if (msg.type === 'setPage') {
        if (msg.index >= 0 && msg.index < pages.length) {
          renderPage(msg.index, { scale: graph.getView().getScale(), hidden: hiddenIds(lastSnapshot || { layers: [] }) });
          lastSnapshot = snapshot();
          post({ type: 'rendered', state: lastSnapshot });
        }
      } else if (msg.type === 'setLayerVisible') {
        var root = graph.getModel().getRoot(), model = graph.getModel();
        model.beginUpdate();
        try {
          for (var i = 0; i < root.getChildCount(); i++) {
            var layer = root.getChildAt(i);
            if (layer.id === msg.layerId) model.setVisible(layer, msg.visible);
          }
        } finally { model.endUpdate(); }
        lastSnapshot = snapshot();
        post({ type: 'rendered', state: lastSnapshot });
      } else if (msg.type === 'zoom') {
        graph.getView().setScale(graph.getView().getScale() * msg.factor);
        lastSnapshot = snapshot();
        post({ type: 'rendered', state: lastSnapshot });
      } else if (msg.type === 'fit') {
        var b = graph.getGraphBounds();
        if (b && (b.width || b.height)) {
          var c = graph.container;
          graph.getView().setScale(Math.min((c.clientWidth - 20) / Math.max(1, b.width), (c.clientHeight - 20) / Math.max(1, b.height)));
        }
        lastSnapshot = snapshot();
        post({ type: 'rendered', state: lastSnapshot });
      } else if (msg.type === 'snapshot') {
        lastSnapshot = snapshot();
        post({ type: 'snapshot', state: lastSnapshot });
      }
    } catch (e) {
      post({ type: 'error', code: 'render-failed', message: String(e && e.message || e) });
    }
  });

  // 捕获阶段拦链接/辅助点击/Tab 导航：图表里的链接不许离开这个 iframe。
  document.addEventListener('click', function (e) { e.preventDefault(); }, true);
  document.addEventListener('auxclick', function (e) { e.preventDefault(); }, true);
  window.addEventListener('keydown', function (e) { if (e.key === 'Tab') e.preventDefault(); }, true);

  post({ type: 'ready' });
})();
