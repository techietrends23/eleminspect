// eleminspect content script: element inspector only.
// Inspector UI and locator logic are copied from the TestifyHub web recorder.
(() => {
  const contentScriptInstanceKey = '__eleminspectContentScriptActive__';
  if (window[contentScriptInstanceKey]) return;
  window[contentScriptInstanceKey] = true;

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
    if (normalized === 'xpath' && /@id=|@data-testid=/.test(String(value || ''))) {
      return 'XPath (ID anchor)';
    }
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

  function clearInspectorLocatorHighlights() {
    if (!elementInspector) return;
    if (elementInspector.highlightTimer) {
      clearTimeout(elementInspector.highlightTimer);
      elementInspector.highlightTimer = null;
    }
    if (elementInspector.highlightRefreshTimer) {
      clearInterval(elementInspector.highlightRefreshTimer);
      elementInspector.highlightRefreshTimer = null;
    }
    if (elementInspector.highlightLayer) {
      elementInspector.highlightLayer.replaceChildren();
      elementInspector.highlightLayer.style.display = 'none';
    }
    elementInspector.highlightNodes = [];
    elementInspector.frozenHighlightRects = [];
  }

  function ensureInspectorHighlightStyles() {
    if (document.getElementById('web-recorder-inspector-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'web-recorder-inspector-highlight-style';
    style.textContent = `
      @keyframes web-recorder-inspector-locator-flash {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 2px rgba(192, 38, 211, 0.95); }
        50% { opacity: 0.3; box-shadow: 0 0 0 6px rgba(192, 38, 211, 0.35); }
      }
      [data-web-recorder-inspector="locator-highlight"] {
        animation: web-recorder-inspector-locator-flash 0.8s ease-in-out infinite;
        border: 2px solid #c026d3;
        background: rgba(192, 38, 211, 0.22);
      }
    `;
    document.documentElement.append(style);
  }

  function captureVisibleMatchRects(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map((node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }).filter(Boolean);
  }

  function renderInspectorLocatorHighlightRects(rects) {
    if (!elementInspector?.highlightLayer) return;
    const layer = elementInspector.highlightLayer;
    layer.replaceChildren();
    if (!rects.length) {
      layer.style.display = 'none';
      return;
    }

    ensureInspectorHighlightStyles();
    rects.forEach((rect) => {
      const box = document.createElement('div');
      box.setAttribute('data-web-recorder-inspector', 'locator-highlight');
      Object.assign(box.style, {
        position: 'fixed',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        borderRadius: '3px',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      layer.append(box);
    });
    layer.style.display = layer.childElementCount ? 'block' : 'none';
  }

  function positionInspectorLocatorHighlights(matches) {
    renderInspectorLocatorHighlightRects(captureVisibleMatchRects(matches));
  }

  function showInspectorLocatorHighlights(matches, durationMs = 5000) {
    if (!elementInspector) return 0;
    clearInspectorLocatorHighlights();
    const nodes = Array.isArray(matches) ? matches.filter(Boolean) : [];
    const frozenRects = captureVisibleMatchRects(nodes);
    if (!frozenRects.length && inspectorTarget instanceof Element) {
      frozenRects.push(...captureVisibleMatchRects([inspectorTarget]));
    }
    if (!frozenRects.length) return 0;

    elementInspector.highlightNodes = nodes;
    elementInspector.frozenHighlightRects = frozenRects;
    renderInspectorLocatorHighlightRects(frozenRects);

    const refreshHighlights = () => {
      const liveRects = captureVisibleMatchRects(
        (elementInspector.highlightNodes || []).filter((node) => node?.isConnected),
      );
      if (liveRects.length) {
        renderInspectorLocatorHighlightRects(liveRects);
        return;
      }
      renderInspectorLocatorHighlightRects(elementInspector.frozenHighlightRects || []);
    };

    elementInspector.highlightRefreshTimer = setInterval(refreshHighlights, 150);
    elementInspector.highlightTimer = setTimeout(() => {
      clearInspectorLocatorHighlights();
    }, durationMs);

    return nodes.length || frozenRects.length;
  }

  function highlightSuggestedLocator(type, value) {
    const result = queryAllInspectorLocatorMatches(type, value);
    if (result.error) return { error: result.error, count: 0 };
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const count = showInspectorLocatorHighlights(matches);
    if (!count) return { error: 'No visible matches to highlight.', count: 0 };
    return { error: null, count: matches.length || count };
  }

  function handleInspectorLocatorHighlight(event, highlightButton) {
    if (!highlightButton || !elementInspector?.locatorItems) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    inspectorLocked = true;
    document.documentElement.style.cursor = '';

    const index = Number(highlightButton.dataset.inspectorHighlightIndex);
    const item = elementInspector.locatorItems[index];
    if (!item) return;

    const result = highlightSuggestedLocator(item.type, item.value);
    const statusEl = elementInspector.panel.querySelector('[data-inspector-highlight-status]');
    if (!statusEl) return;

    if (result.error) {
      statusEl.textContent = result.error;
      statusEl.style.color = INSPECTOR_THEME.errorText;
    } else if (!result.count) {
      statusEl.textContent = 'No matches found.';
      statusEl.style.color = INSPECTOR_THEME.warningText;
    } else {
      statusEl.textContent = result.count === 1
        ? 'Highlighted 1 match for 5 seconds.'
        : `Highlighted ${result.count} matches for 5 seconds.`;
      statusEl.style.color = result.count === 1
        ? INSPECTOR_THEME.uniqueText
        : INSPECTOR_THEME.warningText;
    }
    statusEl.style.display = 'block';
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
    panel.addEventListener('mousedown', (event) => {
      const highlightButton = event.target.closest('[data-inspector-highlight-index]');
      if (!highlightButton) return;
      handleInspectorLocatorHighlight(event, highlightButton);
    }, true);
    // Keep suggested-locator highlighting attached to the inspector panel.
    // The implementation lives in highlightSuggestedLocator/showInspectorLocatorHighlights.

    panel.addEventListener('click', (event) => {
      const button = event.target.closest('[data-inspector-copy]');
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        void copyTextToClipboard(button.dataset.inspectorCopy || '').then(() => {
          const previous = button.textContent;
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = previous || 'Copy'; }, 900);
        });
        return;
      }
      if (event.target.closest('[data-inspector-highlight-index]')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.target.closest('[data-inspector-match]')) {
        runInspectorLocatorMatch();
        return;
      }
      const matchRow = event.target.closest('[data-inspector-match-index]');
      if (matchRow && elementInspector?.matchNodes) {
        const index = Number(matchRow.dataset.inspectorMatchIndex);
        const node = elementInspector.matchNodes[index];
        if (node && typeof node.getBoundingClientRect === 'function') {
          const positionMatchHighlight = () => {
            const rect = node.getBoundingClientRect();
            Object.assign(elementInspector.highlight.style, {
              display: rect.width && rect.height ? 'block' : 'none',
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            });
          };
          node.scrollIntoView({ block: 'center' });
          requestAnimationFrame(() => requestAnimationFrame(positionMatchHighlight));
        }
        return;
      }
      if (event.target.closest('[data-inspector-close]')) stopElementInspector();
    });
    document.documentElement.append(highlightLayer, highlight, panel);
    bindInspectorDrag(panel);
    elementInspector = {
      highlight,
      highlightLayer,
      panel,
      userPosition: null,
      dragState: null,
      lastTargetRect: null,
      locatorItems: [],
      highlightTimer: null,
      highlightRefreshTimer: null,
      highlightNodes: [],
      frozenHighlightRects: [],
    };
    return elementInspector;
  }

  function runInspectorLocatorMatch() {
    if (!elementInspector) return;
    const { panel } = elementInspector;
    const typeSelect = panel.querySelector('[data-inspector-locator-type]');
    const valueInput = panel.querySelector('[data-inspector-locator]');
    const errorEl = panel.querySelector('[data-inspector-match-error]');
    const resultsEl = panel.querySelector('[data-inspector-match-results]');
    if (!typeSelect || !valueInput || !errorEl || !resultsEl) return;

    inspectorLocked = true;
    document.documentElement.style.cursor = '';

    const locatorMatch = globalThis.TestifyHubLocatorMatch || {};
    const query = locatorMatch.queryLocatorMatches
      || (() => ({ error: 'Locator match unavailable', matches: [] }));
    const summarize = locatorMatch.summarizeMatch
      || (() => ({ tag: 'element', text: '', selector: '' }));
    const result = query(document, typeSelect.value, valueInput.value);
    const matches = Array.isArray(result.matches) ? result.matches : [];
    elementInspector.matchNodes = matches;

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      resultsEl.innerHTML = '';
      return;
    }

    errorEl.textContent = '';
    errorEl.style.display = 'none';

    if (!matches.length) {
      resultsEl.innerHTML = '<p style="margin:0;color:' + INSPECTOR_THEME.mutedText + '">No matches found.</p>';
      return;
    }

    resultsEl.innerHTML = matches.map((node, index) => {
      const summary = summarize(node);
      return `<button type="button" data-inspector-match-index="${index}" style="display:block;width:100%;text-align:left;margin:4px 0;padding:8px;border:1px solid ${INSPECTOR_THEME.divider};border-radius:6px;background:${INSPECTOR_THEME.subtleBg};color:${INSPECTOR_THEME.panelText};cursor:pointer;font:inherit">
        <strong>${escapeHtml(summary.tag)}</strong> ${escapeHtml(summary.selector)}${summary.text ? ` — ${escapeHtml(summary.text)}` : ''}
      </button>`;
    }).join('');
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
              <button type="button" data-inspector-highlight-index="${index}" aria-label="Highlight matches" title="Highlight matches for 5 seconds" style="display:inline-flex;align-items:center;justify-content:center;border:1px solid ${INSPECTOR_THEME.controlBorder};background:${INSPECTOR_THEME.subtleBg};color:#c026d3;border-radius:6px;padding:4px 7px;cursor:pointer;font:inherit">${highlightIcon}</button>
              <button type="button" data-inspector-copy="${escapeHtml(item.value)}" style="border:1px solid ${INSPECTOR_THEME.controlBorder};background:${INSPECTOR_THEME.subtleBg};color:${INSPECTOR_THEME.controlText};border-radius:6px;padding:4px 7px;cursor:pointer;font:inherit">Copy</button>
            </div>
          </div>
        </div>`).join('')
      : `<p style="margin:8px 0;color:${INSPECTOR_THEME.warningText}">No unique locator was found for this element.</p>`;
    const matchTypes = (globalThis.TestifyHubLocatorMatch && globalThis.TestifyHubLocatorMatch.MATCH_LOCATOR_TYPES) || [];
    const typeOptions = matchTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    const matchSection = `<div style="margin-top:12px;padding-top:12px;border-top:1px solid ${INSPECTOR_THEME.divider}">
        <strong style="display:block;margin-bottom:8px;color:${INSPECTOR_THEME.labelText}">Match locator</strong>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select data-inspector-locator-type style="border:1px solid ${INSPECTOR_THEME.controlBorder};background:${INSPECTOR_THEME.controlBg};color:${INSPECTOR_THEME.controlText};border-radius:6px;padding:4px 7px;font:inherit">${typeOptions}</select>
          <input data-inspector-locator type="text" placeholder="Locator value" style="flex:1;min-width:120px;border:1px solid ${INSPECTOR_THEME.controlBorder};background:${INSPECTOR_THEME.controlBg};color:${INSPECTOR_THEME.controlText};border-radius:6px;padding:4px 7px;font:inherit" />
          <button type="button" data-inspector-match style="border:1px solid ${INSPECTOR_THEME.primaryBtnBorder};background:${INSPECTOR_THEME.primaryBtnBg};color:${INSPECTOR_THEME.primaryBtnText};border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit">Match</button>
        </div>
        <div data-inspector-match-error style="color:${INSPECTOR_THEME.errorText};margin-top:6px;display:none"></div>
        <div data-inspector-match-results style="margin-top:8px"></div>
      </div>`;
    panel.innerHTML = `<div data-inspector-drag style="display:flex;justify-content:space-between;gap:12px;align-items:start;cursor:move;user-select:none;touch-action:none">
        <div><strong style="font-size:13px">Element inspector</strong><div style="color:${INSPECTOR_THEME.mutedText};margin-top:2px">${escapeHtml(descriptor || tag)} · ${locators.length} unique locator${locators.length === 1 ? '' : 's'}</div></div>
        <button type="button" data-inspector-close style="border:0;background:transparent;color:${INSPECTOR_THEME.closeText};font-size:18px;cursor:pointer;line-height:1" aria-label="Close inspector">×</button>
      </div>${rows}<div data-inspector-highlight-status style="display:none;margin-top:8px;font-size:11px"></div>${matchSection}<p style="margin:10px 0 0;color:${INSPECTOR_THEME.mutedText}">Drag header to move · Hover to inspect · Click to lock · Esc to close</p>`;
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
    elementInspector.matchNodes = [];
  }

  function startElementInspector() {
    ensureElementInspector();
    inspectorLocked = false;
    inspectorActive = true;
    document.documentElement.style.cursor = 'crosshair';
    broadcastInspectorState();
    return true;
  }

  function stopElementInspector() {
    if (!elementInspector) return;
    clearInspectorLocatorHighlights();
    elementInspector.highlight.style.display = 'none';
    elementInspector.panel.style.display = 'none';
    elementInspector.userPosition = null;
    elementInspector.dragState = null;
    elementInspector.lastTargetRect = null;
    inspectorTarget = null;
    inspectorLocked = false;
    inspectorActive = false;
    document.documentElement.style.cursor = '';
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

  function handleElementInspectorHover(event) {
    if (!inspectorActive || !elementInspector || inspectorLocked) return;
    const target = event.target;
    if (!(target instanceof Element) || elementInspector.panel.contains(target)) return;
    if (target === inspectorTarget) return;
    inspectorTarget = target;
    renderElementInspector(target);
  }

  function handleElementInspectorClick(event) {
    if (!inspectorActive || !elementInspector || !inspectorTarget || elementInspector.panel.contains(event.target)) return;
    if (inspectorLocked) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    inspectorLocked = true;
    document.documentElement.style.cursor = '';
    renderElementInspector(inspectorTarget);
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

  document.addEventListener('mousemove', handleElementInspectorHover, true);
  document.addEventListener('click', handleElementInspectorClick, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && inspectorActive && elementInspector) {
      event.preventDefault();
      event.stopPropagation();
      stopElementInspector();
    }
  }, true);
})();
