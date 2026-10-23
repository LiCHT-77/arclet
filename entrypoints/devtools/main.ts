const port = browser.runtime.connect({ name: 'arclet-devtools' });

port.postMessage({
  type: 'devtools:connected',
  tabId: browser.devtools.inspectedWindow.tabId,
});

// MV3 の service worker が停止して接続状態を失わないよう、DevTools が
// 開いている間は公式推奨の heartbeat で接続を維持する。
const heartbeat = window.setInterval(() => {
  port.postMessage({ type: 'devtools:heartbeat' });
}, 15_000);

port.onDisconnect.addListener(() => {
  window.clearInterval(heartbeat);
});
