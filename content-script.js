// eleminspect content script: element inspector only.
// Inspector UI and locator logic are copied from the TestifyHub web recorder.
(() => {
  const contentScriptInstanceKey = '__eleminspectContentScriptActive__';
  if (window[contentScriptInstanceKey]) return;
  window[contentScriptInstanceKey] = true;

  const HIGHLIGHT_DURATION_MS = 4000;
  // Fuzzy or label-based locator types. The inspected element is already verified unique for these.
  const TARGET_VERIFIED_TYPES = new Set(['text', 'label', 'placeholder', 'alt']);
  // While the inspector is active, these events never reach the page.
  const BLOCKED_EVENT_TYPES = [
    'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick',
    'contextmenu', 'auxclick', 'touchstart', 'touchend', 'keydown', 'keypress', 'keyup',
  ];

  let elementInspector = null;
  let inspectorTarget = null;
  let inspectorLocked = false;
  let inspectorActive = false;

  function isSubframeContext() {
    return window.top !== window;
  }

  function coordinatesCandidateFromElement(target) {
    const rect = target?.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    const clientX = Math.round(rect.left + (rect.width / 2));
    const clientY = Math.round(rect.top + (rect.height / 2));
    return {
      selector: JSON.stringify({
        x: Math.round(clientX + window.scrollX),
        y: Math.round(clientY + window.scrollY),
        clientX,
        clientY,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }),
      selector_type: 'coordinates',
      reliability: 0.4,
      source: 'coordinates',
      label: `(${clientX}, ${clientY})`,
    };
  }

  function attachCoordinatesToSelectorInfo(target, selectorInfo) {
    const coord = coordinatesCandidateFromElement(target);
    if (!selectorInfo) return selectorInfo;
    if (!coord) return selectorInfo;
    const bundle = selectorInfo.locator_bundle && typeof selectorInfo.locator_bundle === 'object'
      ? { ...selectorInfo.locator_bundle }
      : { primary: null, candidates: [] };
    const candidates = Array.isArray(bundle.candidates) ? bundle.candidates.slice() : [];
    const already = candidates.some((item) => String(item?.selector_type || '').toLowerCase() === 'coordinates');
    if (!already) candidates.push(coord);
    bundle.candidates = candidates;
    if (!bundle.strategy_order) {
      bundle.strategy_order = ['testid', 'name', 'data-attr', 'role', 'label', 'placeholder', 'alt', 'title', 'text', 'css', 'xpath', 'coordinates'];
    } else if (!bundle.strategy_order.includes('coordinates')) {
      bundle.strategy_order = [...bundle.strategy_order, 'coordinates'];
    }
    return { ...selectorInfo, locator_bundle: bundle };
  }

  function getSelectorInfo(target) {
    const result = window.WebRecorderSelector.selectorFromElement(target);
    if (!result) return null;
    if (typeof result === 'string') {
      return attachCoordinatesToSelectorInfo(target, {
        selector: result,
        selector_type: 'css',
        label: result,
        locator_bundle: window.WebRecorderSelector.locatorBundleFromElement
          ? window.WebRecorderSelector.locatorBundleFromElement(target)
          : null,
        reliability: null,
      });
    }
    if (result.selector) {
      const locatorBundle = result.locator_bundle
        || (window.WebRecorderSelector.locatorBundleFromElement
          ? window.WebRecorderSelector.locatorBundleFromElement(target)
          : null);
      return attachCoordinatesToSelectorInfo(target, {
        selector: result.selector,
        selector_type: result.selector_type || 'css',
        label: result.label || result.selector,
        locator_bundle: locatorBundle,
        reliability: Number.isFinite(result.reliability) ? result.reliability : null,
      });
    }
    return null;
  }

  function inspectorTypeLabel(type, value) {
    const normalized = String(type || 'locator').toLowerCase();
    const raw = String(value || '');
    if (normalized === 'xpath' && /@id=|@data-testid=/.test(raw)) return 'XPath (ID anchor)';
    if (normalized === 'xpath' && /^\/html\[\d+\]\//.test(raw)) return 'XPath (absolute)';
    if (normalized === 'xpath') return 'XPath';
    const labels = {
      id: 'Unique ID', testid: 'Test ID', role: 'Role', label: 'Label', placeholder: 'Placeholder',
      alt: 'Alt text', text: 'Text', css: 'CSS', xpath: 'XPath', name: 'Name',
      'data-attr': 'Data attribute', title: 'Title', 'aria-describedby': 'ARIA description',
    };
    return labels[String(type || 'locator').toLowerCase()] || String(type || 'Locator');
  }

  function isUniqueInspectorCandidate(candidate, target) {
    const value = String(candidate?.selector || '').trim();
    const type = String(candidate?.selector_type || '').toLowerCase();
    if (!value || !target) return false;
    if (window.WebRecorderSelector?.isUniqueLocatorForElement) {
      return window.WebRecorderSelector.isUniqueLocatorForElement(candidate, target);
    }
    try {
      if (type === 'css') {
        const nodes = document.querySelectorAll(value);
        return nodes.length === 1 && nodes[0] === target;
      }
      if (type === 'xpath') {
        const result = document.evaluate(value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return result.snapshotLength === 1 && result.snapshotItem(0) === target;
      }
      if (type === 'id') {
        const id = value.startsWith('#') ? value.slice(1) : value;
        const node = document.getElementById(id);
        return Boolean(node) && node === target && document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length === 1;
      }
    } catch (_error) {
      return false;
    }
    return false;
  }

  function normalizeInspectorText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function queryAllInspectorLocatorMatches(type, value) {
    const normalizedType = String(type || '').toLowerCase();
    const raw = String(value || '').trim();
    if (!raw) return { error: 'Missing locator', matches: [] };

    const locatorMatch = globalThis.TestifyHubLocatorMatch || {};
    const query = locatorMatch.queryLocatorMatches
      || (() => ({ error: 'Locator match unavailable', matches: [] }));

    if (normalizedType === 'role') {
      try {
        const meta = JSON.parse(raw);
        const role = normalizeInspectorText(meta.role);
        const name = normalizeInspectorText(meta.name);
        if (!role) return { error: 'Invalid role locator', matches: [] };
        const result = query(document, 'role', role);
        if (result.error) return result;
        if (!name) return result;
        return {
          error: null,
          matches: (result.matches || []).filter((node) => {
            const label = normalizeInspectorText(node.getAttribute?.('aria-label')
              || node.innerText
              || node.textContent);
            return label === name;
          }),
        };
      } catch (_error) {
        return { error: 'Invalid role locator', matches: [] };
      }
    }

    if (['css', 'xpath', 'id', 'text', 'label', 'placeholder', 'alt', 'testid', 'title', 'name'].includes(normalizedType)) {
      return query(document, normalizedType, raw);
    }

    return { error: `Unsupported locator type: ${normalizedType}`, matches: [] };
  }

  function ensureInspectorHighlightStyles() {
    if (document.getElementById('web-recorder-inspector-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'web-recorder-inspector-highlight-style';
    style.textContent = `
      @keyframes web-recorder-inspector-blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.15; }
      }
      [data-web-recorder-inspector="locator-highlight"] {
        animation: web-recorder-inspector-blink 0.5s ease-in-out infinite;
        border: 2px solid #c026d3;
        background: rgba(192, 38, 211, 0.22);
        box-shadow: 0 0 0 3px rgba(192, 38, 211, 0.35);
        border-radius: 3px;
      }
    `;
    document.documentElement.append(style);
  }

  function clearInspectorLocatorHighlights() {
    if (!elementInspector) return;
    const session = elementInspector.highlightSession;
    if (session) {
      cancelAnimationFrame(session.frameId);
      clearTimeout(session.timerId);
      session.boxes.forEach((box) => box.remove());
      elementInspector.highlightSession = null;
    }
    if (elementInspector.highlightLayer) {
      elementInspector.highlightLayer.style.display = 'none';
    }
  }

  // One persistent box per element. A rAF loop keeps the boxes on their elements while the page scrolls or moves.
  // The blink is a CSS animation on the box, so the boxes are never rebuilt while it runs.
  function showInspectorLocatorHighlights(nodes) {
    if (!elementInspector) return { error: 'Inspector is not active.', count: 0 };
    clearInspectorLocatorHighlights();
    const targets = nodes.filter((node) => node && node.isConnected && typeof node.getBoundingClientRect === 'function');
    if (!targets.length) return { error: 'No elements matched this locator.', count: 0 };

    ensureInspectorHighlightStyles();
    targets[0].scrollIntoView({ block: 'center', inline: 'center' });

    const { highlightLayer } = elementInspector;
    const boxes = targets.map(() => {
      const box = document.createElement('div');
      box.setAttribute('data-web-recorder-inspector', 'locator-highlight');
      Object.assign(box.style, {
        position: 'fixed', pointerEvents: 'none', boxSizing: 'border-box', display: 'none',
      });
      highlightLayer.append(box);
      return box;
    });
    highlightLayer.style.display = 'block';

    const session = { targets, boxes, frameId: 0, timerId: 0 };
    const follow = () => {
      if (!elementInspector || elementInspector.highlightSession !== session) return;
      targets.forEach((node, index) => {
        const box = boxes[index];
        const rect = node.isConnected ? node.getBoundingClientRect() : null;
        if (!rect || (!rect.width && !rect.height)) {
          box.style.display = 'none';
          return;
        }
        Object.assign(box.style, {
          display: 'block',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      });
      session.frameId = requestAnimationFrame(follow);
    };
    elementInspector.highlightSession = session;
    session.timerId = setTimeout(clearInspectorLocatorHighlights, HIGHLIGHT_DURATION_MS);
    follow();
    return { error: null, count: targets.length };
  }

  // Resolves a suggested locator to the elements it points at.
  // Fuzzy types (text, label, placeholder, alt) use the inspected element, which was already verified unique.
  function resolveLocatorItemNodes(item) {
    const type = String(item?.type || '').toLowerCase();
    if (TARGET_VERIFIED_TYPES.has(type)) {
      return { error: null, nodes: inspectorTarget ? [inspectorTarget] : [] };
    }
    const result = queryAllInspectorLocatorMatches(type, item.value);
    if (result.error) return { error: result.error, nodes: [] };
    const nodes = Array.from(new Set((result.matches || []).filter((node) => node instanceof Element)));
    return { error: null, nodes };
  }

  function handleInspectorLocatorHighlight(button) {
    if (!elementInspector?.locatorItems) return;
    setInspectorLocked(true);
    const statusEl = elementInspector.panel.querySelector('[data-inspector-highlight-status]');
    const item = elementInspector.locatorItems[Number(button.dataset.inspectorHighlightIndex)];
    if (!item || !statusEl) return;

    const resolved = resolveLocatorItemNodes(item);
    const result = resolved.error
      ? { error: resolved.error, count: 0 }
      : showInspectorLocatorHighlights(resolved.nodes);

    statusEl.style.display = 'block';
    if (result.error) {
      statusEl.textContent = result.error;
      statusEl.style.color = INSPECTOR_THEME.errorText;
      return;
    }
    if (result.count === 1) {
      statusEl.textContent = `Highlighted the element for ${Math.round(HIGHLIGHT_DURATION_MS / 1000)} seconds.`;
      statusEl.style.color = INSPECTOR_THEME.uniqueText;
    } else {
      statusEl.textContent = `This locator matches ${result.count} elements. Highlighted all of them.`;
      statusEl.style.color = INSPECTOR_THEME.warningText;
    }
  }

  function getInspectorLocators(target) {
    const selectorInfo = getSelectorInfo(target);
    const candidates = selectorInfo?.locator_bundle?.candidates || [];
    const locators = [];
    const add = (candidate) => {
      if (!candidate?.selector || !isUniqueInspectorCandidate(candidate, target)) return;
      const key = `${candidate.selector_type || 'locator'}:${candidate.selector}`;
      if (locators.some((item) => item.key === key)) return;
      locators.push({
        key,
        type: candidate.selector_type || 'locator',
        value: String(candidate.selector),
        score: 100,
      });
    };

    const id = String(target.id || '').trim();
    if (id && document.getElementById(id) === target) {
      add({ selector_type: 'id', selector: `#${window.CSS?.escape ? CSS.escape(id) : id}`, reliability: 0.96 });
    }
    candidates.forEach(add);
    if (selectorInfo?.selector) add(selectorInfo);
    return locators.sort((a, b) => b.score - a.score);
  }

  function inspectorRectsOverlap(targetRect, panelLeft, panelTop, panelWidth, panelHeight) {
    const padding = 8;
    const panelRight = panelLeft + panelWidth;
    const panelBottom = panelTop + panelHeight;
    const targetRight = targetRect.left + targetRect.width;
    const targetBottom = targetRect.top + targetRect.height;
    return !(
      panelRight < targetRect.left + padding
      || panelLeft > targetRight - padding
      || panelBottom < targetRect.top + padding
      || panelTop > targetBottom - padding
    );
  }

  function positionInspectorPanel(panel, targetRect, userPosition) {
    const padding = 12;
    const gap = 12;
    const panelWidth = panel.offsetWidth || Math.min(460, window.innerWidth - 24);
    const panelHeight = panel.offsetHeight || 320;

    if (userPosition && Number.isFinite(userPosition.left) && Number.isFinite(userPosition.top)) {
      const left = Math.max(padding, Math.min(userPosition.left, window.innerWidth - panelWidth - padding));
      const top = Math.max(padding, Math.min(userPosition.top, window.innerHeight - panelHeight - padding));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      return;
    }

    const clampHorizontal = (left) => Math.max(padding, Math.min(left, window.innerWidth - panelWidth - padding));
    const clampVertical = (top) => Math.max(padding, Math.min(top, window.innerHeight - panelHeight - padding));
    const candidates = [
      { left: clampHorizontal(targetRect.left), top: clampVertical(targetRect.bottom + gap) },
      { left: clampHorizontal(targetRect.left), top: clampVertical(targetRect.top - panelHeight - gap) },
      { left: clampHorizontal(targetRect.right + gap), top: clampVertical(targetRect.top) },
      { left: clampHorizontal(targetRect.left - panelWidth - gap), top: clampVertical(targetRect.top) },
    ];

    const nonOverlapping = candidates.find(
      (placement) => !inspectorRectsOverlap(targetRect, placement.left, placement.top, panelWidth, panelHeight),
    );
    if (nonOverlapping) {
      panel.style.left = `${nonOverlapping.left}px`;
      panel.style.top = `${nonOverlapping.top}px`;
      return;
    }

    const targetCenterX = targetRect.left + (targetRect.width / 2);
    const targetCenterY = targetRect.top + (targetRect.height / 2);
    const left = targetCenterX < (window.innerWidth / 2)
      ? clampHorizontal(Math.max(targetRect.right + gap, window.innerWidth - panelWidth - padding))
      : padding;
    const top = targetCenterY < (window.innerHeight / 2)
      ? clampVertical(Math.max(targetRect.bottom + gap, window.innerHeight - panelHeight - padding))
      : padding;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function bindInspectorDrag(panel) {
    if (panel.dataset.inspectorDragBound === '1') return;
    panel.dataset.inspectorDragBound = '1';

    const onMove = (event) => {
      if (!elementInspector?.dragState) return;
      const { startX, startY, originLeft, originTop } = elementInspector.dragState;
      const nextLeft = originLeft + (event.clientX - startX);
      const nextTop = originTop + (event.clientY - startY);
      elementInspector.userPosition = { left: nextLeft, top: nextTop };
      positionInspectorPanel(panel, elementInspector.lastTargetRect || { left: 0, top: 0, width: 0, height: 0 }, elementInspector.userPosition);
    };

    const onEnd = () => {
      if (!elementInspector?.dragState) return;
      elementInspector.dragState = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
    };

    panel.addEventListener('mousedown', (event) => {
      if (!event.target.closest('[data-inspector-drag]')) return;
      if (event.target.closest('[data-inspector-close]')) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      elementInspector.dragState = {
        startX: event.clientX,
        startY: event.clientY,
        originLeft: rect.left,
        originTop: rect.top,
      };
      elementInspector.userPosition = { left: rect.left, top: rect.top };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
    });
  }

  const INSPECTOR_THEME = {
    panelBg: '#ffffff',
    panelText: '#0f172a',
    panelBorder: '#dbeafe',
    panelShadow: '0 18px 48px rgba(15, 23, 42, 0.14)',
    mutedText: '#64748b',
    labelText: '#1d4ed8',
    codeText: '#0f172a',
    uniqueText: '#15803d',
    warningText: '#b45309',
    errorText: '#dc2626',
    divider: '#e2e8f0',
    controlBg: '#ffffff',
    controlBorder: '#cbd5e1',
    controlText: '#0f172a',
    subtleBg: '#f8fafc',
    closeText: '#64748b',
    primaryBtnBg: '#2563eb',
    primaryBtnBorder: '#2563eb',
    primaryBtnText: '#ffffff',
  };

  function ensureElementInspector() {
    if (elementInspector) return elementInspector;

    // Transparent layer over the whole page. It takes every pointer event so the page never sees them.
    const blocker = document.createElement('div');
    blocker.setAttribute('data-web-recorder-inspector', 'blocker');
    Object.assign(blocker.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', display: 'none',
      pointerEvents: 'auto', cursor: 'crosshair', background: 'transparent',
    });
    const highlight = document.createElement('div');
    highlight.setAttribute('data-web-recorder-inspector', 'highlight');
    Object.assign(highlight.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
      border: '2px solid #2563eb', background: 'rgba(37, 99, 235, 0.12)',
      borderRadius: '3px', display: 'none', boxSizing: 'border-box',
    });
    const highlightLayer = document.createElement('div');
    highlightLayer.setAttribute('data-web-recorder-inspector', 'highlight-layer');
    Object.assign(highlightLayer.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483645', display: 'none',
    });
    const panel = document.createElement('section');
    panel.setAttribute('data-web-recorder-inspector', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Element locator inspector');
    Object.assign(panel.style, {
      position: 'fixed', zIndex: '2147483647', width: 'min(460px, calc(100vw - 24px))',
      maxHeight: 'min(420px, calc(100vh - 24px))', overflow: 'auto', display: 'none',
      boxSizing: 'border-box', padding: '12px', borderRadius: '12px',
      background: INSPECTOR_THEME.panelBg, color: INSPECTOR_THEME.panelText, border: `1px solid ${INSPECTOR_THEME.panelBorder}`,
      boxShadow: INSPECTOR_THEME.panelShadow, fontFamily: 'system-ui, sans-serif',
      fontSize: '12px', lineHeight: '1.4',
    });

    panel.addEventListener('click', (event) => {
      const copyButton = event.target.closest('[data-inspector-copy]');
      if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        void copyTextToClipboard(copyButton.dataset.inspectorCopy || '').then(() => {
          const previous = copyButton.textContent;
          copyButton.textContent = 'Copied';
          setTimeout(() => { copyButton.textContent = previous || 'Copy'; }, 900);
        });
        return;
      }
      const highlightButton = event.target.closest('[data-inspector-highlight-index]');
      if (highlightButton) {
        event.preventDefault();
        event.stopPropagation();
        handleInspectorLocatorHighlight(highlightButton);
        return;
      }
      if (event.target.closest('[data-inspector-close]')) stopElementInspector();
    });
    document.documentElement.append(blocker, highlightLayer, highlight, panel);
    bindInspectorDrag(panel);
    elementInspector = {
      blocker,
      highlight,
      highlightLayer,
      panel,
      userPosition: null,
      dragState: null,
      lastTargetRect: null,
      locatorItems: [],
      highlightSession: null,
    };
    return elementInspector;
  }

  function renderElementInspector(target) {
    if (!elementInspector || !target) return;
    const { highlight, panel } = elementInspector;
    const rect = target.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: rect.width && rect.height ? 'block' : 'none', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    const locators = getInspectorLocators(target);
    const tag = target.tagName.toLowerCase();
    const descriptor = [tag, target.getAttribute('name'), target.getAttribute('aria-label')].filter(Boolean).join(' · ');
    elementInspector.locatorItems = locators;
    const highlightIcon = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:block"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>';
    const rows = locators.length
      ? locators.map((item, index) => `<div style="padding:8px 0;border-top:1px solid ${INSPECTOR_THEME.divider}">
          <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:4px">
            <strong style="color:${INSPECTOR_THEME.labelText}">${escapeHtml(inspectorTypeLabel(item.type, item.value))}</strong>
            <span style="color:${INSPECTOR_THEME.uniqueText};font-weight:700">Unique</span>
          </div>
          <div style="display:flex;gap:8px;align-items:flex-start">
            <code style="flex:1;overflow-wrap:anywhere;color:${INSPECTOR_THEME.codeText}">${escapeHtml(item.value)}</code>
            <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
              <button type="button" data-inspector-highlight-index="${index}" aria-label="Highlight element" title="Highlight element (blinks for ${Math.round(HIGHLIGHT_DURATION_MS / 1000)} seconds)" style="display:inline-flex;align-items:center;justify-content:center;border:1px solid ${INSPECTOR_THEME.controlBorder};background:${INSPECTOR_THEME.subtleBg};color:#c026d3;border-radius:6px;padding:4px 7px;cursor:pointer;font:inherit">${highlightIcon}</button>
              <button type="button" data-inspector-copy="${escapeHtml(item.value)}" style="border:1px solid ${INSPECTOR_THEME.controlBorder};background:${INSPECTOR_THEME.subtleBg};color:${INSPECTOR_THEME.controlText};border-radius:6px;padding:4px 7px;cursor:pointer;font:inherit">Copy</button>
            </div>
          </div>
        </div>`).join('')
      : `<p style="margin:8px 0;color:${INSPECTOR_THEME.warningText}">No unique locator was found for this element.</p>`;
    panel.innerHTML = `<div data-inspector-drag style="display:flex;justify-content:space-between;gap:12px;align-items:start;cursor:move;user-select:none;touch-action:none">
        <div><strong style="font-size:13px">Element inspector</strong><div style="color:${INSPECTOR_THEME.mutedText};margin-top:2px">${escapeHtml(descriptor || tag)} · ${locators.length} unique locator${locators.length === 1 ? '' : 's'}</div></div>
        <button type="button" data-inspector-close style="border:0;background:transparent;color:${INSPECTOR_THEME.closeText};font-size:18px;cursor:pointer;line-height:1" aria-label="Close inspector">×</button>
      </div>${rows}<div data-inspector-highlight-status style="display:none;margin-top:8px;font-size:11px"></div><p style="margin:10px 0 0;color:${INSPECTOR_THEME.mutedText}">Drag header to move · Hover to inspect · Click to lock · Esc to close</p>`;
    panel.style.display = 'block';
    elementInspector.lastTargetRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    if (!inspectorLocked) {
      elementInspector.userPosition = null;
    }
    positionInspectorPanel(panel, elementInspector.lastTargetRect, elementInspector.userPosition);
  }

  function setInspectorLocked(locked) {
    inspectorLocked = locked;
    if (elementInspector) {
      elementInspector.blocker.style.cursor = locked ? 'default' : 'crosshair';
    }
  }

  function startElementInspector() {
    ensureElementInspector();
    setInspectorLocked(false);
    inspectorActive = true;
    inspectorTarget = null;
    // Drop focus from any page control so keys cannot act on it while inspecting.
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    elementInspector.blocker.style.display = 'block';
    broadcastInspectorState();
    return true;
  }

  function stopElementInspector() {
    if (!elementInspector) return;
    clearInspectorLocatorHighlights();
    elementInspector.blocker.style.display = 'none';
    elementInspector.highlight.style.display = 'none';
    elementInspector.panel.style.display = 'none';
    elementInspector.userPosition = null;
    elementInspector.dragState = null;
    elementInspector.lastTargetRect = null;
    inspectorTarget = null;
    setInspectorLocked(false);
    inspectorActive = false;
    sendInspectorState(false);
  }

  function broadcastInspectorState() {
    sendInspectorState(inspectorActive);
  }

  // Popup and DevTools panel listen for this; nobody listening is normal, so swallow lastError.
  function sendInspectorState(active) {
    try {
      chrome.runtime.sendMessage({ type: 'inspector_state', active }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_e) {
      // Extension context was reloaded.
    }
  }

  function isInsideInspectorUi(node) {
    return Boolean(elementInspector && node && elementInspector.panel.contains(node));
  }

  // The blocker is on top, so hit-testing skips it while we ask which page element is under the pointer.
  function elementUnderPointer(clientX, clientY) {
    const blocker = elementInspector.blocker;
    blocker.style.pointerEvents = 'none';
    let element = null;
    try {
      element = document.elementFromPoint(clientX, clientY);
    } finally {
      blocker.style.pointerEvents = 'auto';
    }
    return element instanceof Element ? element : null;
  }

  function handleInspectorMouseMove(event) {
    if (!inspectorActive || !elementInspector || inspectorLocked) return;
    if (isInsideInspectorUi(event.target)) return;
    const target = elementUnderPointer(event.clientX, event.clientY);
    if (!target || isInsideInspectorUi(target) || target === inspectorTarget) return;
    inspectorTarget = target;
    renderElementInspector(target);
  }

  function lockInspectorTarget() {
    if (inspectorLocked || !inspectorTarget) return;
    setInspectorLocked(true);
    renderElementInspector(inspectorTarget);
  }

  // Runs in the capture phase on window, before any page listener. While the inspector is active,
  // page pointer and keyboard events are stopped here. Only the inspector panel keeps its own events.
  function handleInspectorBlockedEvent(event) {
    if (!inspectorActive || !elementInspector) return;
    if (event.type === 'keydown' && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopElementInspector();
      return;
    }
    if (isInsideInspectorUi(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (event.type === 'click' && event.target === elementInspector.blocker) {
      lockInspectorTarget();
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function copyTextToClipboard(value) {
    const text = String(value == null ? '' : value);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_err) {
      // fall through to legacy copy
    }
    try {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.setAttribute('readonly', 'readonly');
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      temp.style.left = '-9999px';
      document.body.appendChild(temp);
      temp.select();
      temp.setSelectionRange(0, temp.value.length);
      const copied = document.execCommand('copy');
      temp.remove();
      return copied;
    } catch (_err) {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'element_inspector_start') {
      // Only the top frame responds; the popup and DevTools panel target frame 0.
      if (isSubframeContext()) return;
      const started = startElementInspector();
      sendResponse(started ? { ok: true } : { error: 'The inspector could not start on this page.' });
      return true;
    }
    if (message?.type === 'element_inspector_stop') {
      if (isSubframeContext()) return;
      stopElementInspector();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'element_inspector_status') {
      if (isSubframeContext()) return;
      sendResponse({ active: inspectorActive });
      return true;
    }
  });

  BLOCKED_EVENT_TYPES.forEach((type) => {
    window.addEventListener(type, handleInspectorBlockedEvent, { capture: true, passive: false });
  });
  window.addEventListener('mousemove', handleInspectorMouseMove, { capture: true, passive: true });
})();
