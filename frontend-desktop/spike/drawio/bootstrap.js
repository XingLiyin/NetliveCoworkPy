/** Draw.io 隔离壳的协议与渲染逻辑（spike 版，生产实现同骨架）。
 *  运行在 sandbox="allow-scripts"（无 allow-same-origin）的 iframe 里，
 *  只认父窗口 + 实例 token 的消息；能力：渲染/切页/图层/缩放/适配。
 */
(function () {
  'use strict';
  var TOKEN = (crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(16)).map(function (b) { return b.toString(16).padStart(2, '0') })).join('')
    : String(Math.random());
  var graph = null;
  var pages = [];
  var current = -1;

  function post(msg) { msg.token = TOKEN; parent.postMessage(msg, '*'); }

  function renderPage(index) {
    var page = pages[index];
    var container = document.getElementById('graph');
    container.innerHTML = '';
    if (graph && graph.destroy) { try { graph.destroy(); } catch (e) {} }
    // drawio 的 Graph（viewer.min.js 暴露的全局类），不是裸 mxGraph——
    // 样式管线（自适应配色等）挂在它身上，裸 mxGraph 渲染会炸 getAdaptiveColors。
    graph = new Graph(container);
    graph.setCellsEditable(false);
    graph.setConnectable(false);
    graph.setDropEnabled(false);
    graph.setPanning(true);
    graph.setTooltips(true);
    var doc = mxUtils.parseXml(page.xml);
    var codec = new mxCodec(doc);
    codec.decode(doc.documentElement, graph.getModel());
    current = index;
    return page;
  }

  function state() {
    var layerInfo = [];
    var root = graph.getModel().getRoot();
    for (var i = 1; i < root.getChildCount(); i++) {
      var layer = root.getChildAt(i);
      layerInfo.push({ id: layer.id, name: layer.value || layer.id, visible: layer.isVisible() });
    }
    return {
      page: current,
      pageCount: pages.length,
      pages: pages.map(function (p) { return { id: p.id, name: p.name }; }),
      scale: graph.getView().getScale(),
      layers: layerInfo,
      svg: !!document.querySelector('#graph svg'),
      svgText: (document.querySelector('#graph svg') || { textContent: '' }).textContent,
    };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parent) return;
    var msg = ev.data;
    if (!msg || msg.token !== TOKEN) return;
    try {
      if (msg.type === 'render' && msg.buf instanceof ArrayBuffer) {
        var xml = new TextDecoder('utf-8', { fatal: true }).decode(msg.buf);
        var doc = mxUtils.parseXml(xml);
        if (!doc || !doc.documentElement || doc.documentElement.nodeName !== 'mxfile') {
          post({ type: 'error', code: 'not-mxfile' }); return;
        }
        pages = Array.prototype.map.call(doc.documentElement.getElementsByTagName('diagram'), function (d) {
          return { id: d.getAttribute('id'), name: d.getAttribute('name'), xml: mxUtils.getXml(d.getElementsByTagName('mxGraphModel')[0]) };
        });
        renderPage(0);
        graph.getView().setScale(1);
        post({ type: 'rendered', state: state() });
      } else if (msg.type === 'setPage') {
        renderPage(msg.index);
        if (msg.scale) graph.getView().setScale(msg.scale);
        post({ type: 'rendered', state: state() });
      } else if (msg.type === 'setLayerVisible') {
        var root = graph.getModel().getRoot();
        for (var i = 0; i < root.getChildCount(); i++) {
          var layer = root.getChildAt(i);
          if (layer.id === msg.layerId) {
            // 走 model.setVisible（记录 mxVisibleChange）而不是 cell.setVisible——
            // 后者绕过变更编辑，endUpdate 拿到空 edit，视图不会跟着刷新。
            var model = graph.getModel();
            model.beginUpdate();
            try { model.setVisible(layer, msg.visible); } finally { model.endUpdate(); }
          }
        }
        post({ type: 'rendered', state: state() });
      } else if (msg.type === 'zoom') {
        graph.getView().setScale(graph.getView().getScale() * msg.factor);
        post({ type: 'rendered', state: state() });
      } else if (msg.type === 'fit') {
        var b = graph.getGraphBounds();
        if (b && (b.width || b.height)) {
          var c = graph.container;
          graph.getView().setScale(Math.min((c.clientWidth - 20) / Math.max(1, b.width), (c.clientHeight - 20) / Math.max(1, b.height)));
        }
        post({ type: 'rendered', state: state() });
      }
    } catch (e) {
      post({ type: 'error', code: 'render-failed', message: String(e && e.message || e) });
    }
  });

  document.addEventListener('click', function (e) { e.preventDefault(); }, true);
  document.addEventListener('auxclick', function (e) { e.preventDefault(); }, true);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') e.preventDefault();
  }, true);

  post({ type: 'ready', token: TOKEN });
})();
