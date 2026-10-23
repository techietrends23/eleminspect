// Shared start/stop logic for the toolbar popup and the DevTools panel.
const INSPECTOR_CONTENT_SCRIPT_FILES = [
  'selector-generator.js',
  'element-check-catalog.js',
  'locator-match.js',
  'content-script.js',
];

function createInspectorControls({ getTabId, inspectBtn, stopBtn, statusEl }) {
  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function setActive(active) {
    inspectBtn.classList.toggle('hidden', active);
    stopBtn.classList.toggle('hidden', !active);
  }

  function sendToTopFrame(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        resolve(runtimeError ? { error: runtimeError.message } : (response || {}));
      });
    });
  }

  function injectContentScripts(tabId) {
    return new Promise((resolve) => {
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: INSPECTOR_CONTENT_SCRIPT_FILES,
      }, () => {
        const runtimeError = chrome.runtime.lastError;
        resolve(runtimeError ? { error: runtimeError.message } : { ok: true });
      });
    });
  }

  async function start() {
    const tabId = await getTabId();
    if (typeof tabId !== 'number') {
      setStatus('No active tab to inspect.', true);
      return;
    }
    // Tabs opened before the extension was installed have no content script yet.
    let response = await sendToTopFrame(tabId, { type: 'element_inspector_start' });
    if (response.error) {
      const injected = await injectContentScripts(tabId);
      if (injected.error) {
        setStatus(`This page cannot be inspected (${injected.error}).`, true);
        return;
      }
      response = await sendToTopFrame(tabId, { type: 'element_inspector_start' });
    }
    if (response.error) {
      setStatus('Unable to inspect this page. Reload it and try again.', true);
      return;
    }
    setActive(true);
    setStatus('Inspector active. Hover to inspect, click to lock, Esc to exit.');
  }

  async function stop() {
    const tabId = await getTabId();
    if (typeof tabId === 'number') {
      await sendToTopFrame(tabId, { type: 'element_inspector_stop' });
    }
    setActive(false);
    setStatus('Idle');
  }

  async function refresh() {
    const tabId = await getTabId();
    if (typeof tabId !== 'number') return;
    const response = await sendToTopFrame(tabId, { type: 'element_inspector_status' });
    setActive(Boolean(response.active));
    setStatus(response.active ? 'Inspector active. Hover to inspect, click to lock, Esc to exit.' : 'Idle');
  }

  // The content script broadcasts this when the inspector starts or stops (for example on Esc).
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'inspector_state') return;
    setActive(Boolean(message.active));
    setStatus(message.active ? 'Inspector active. Hover to inspect, click to lock, Esc to exit.' : 'Idle');
  });

  return { start, stop, refresh, setActive, setStatus };
}
