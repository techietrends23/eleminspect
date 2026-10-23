function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      resolve(tabs && tabs[0] ? tabs[0].id : null);
    });
  });
}

const controls = createInspectorControls({
  getTabId: getActiveTabId,
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
