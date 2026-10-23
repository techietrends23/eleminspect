const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

const controls = createInspectorControls({
  getTabId: async () => inspectedTabId,
  inspectBtn: document.getElementById('btn-inspect'),
  stopBtn: document.getElementById('btn-stop'),
  statusEl: document.getElementById('status'),
});

document.getElementById('btn-inspect').addEventListener('click', () => {
  void controls.start();
});
document.getElementById('btn-stop').addEventListener('click', () => {
  void controls.stop();
});

void controls.refresh();
