// 必须在 viewer.min.js 之前执行：预置 MathJax 存根。
// Editor.initMath 的守卫是 typeof window.MathJax === 'undefined'——不预置它就会
// 在加载时尝试外联 https://viewer.diagrams.net/math4/es5/startup.js（被 CSP 挡，
// 但连"尝试"都不该有）。离线只读预览不支持数学排版，存根 = 显式降级。
window.MathJax = window.MathJax || {}
