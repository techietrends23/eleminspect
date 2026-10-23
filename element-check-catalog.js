(() => {
  const SKIP_CHILD_TAGS = new Set([
    'script', 'style', 'noscript', 'link', 'meta', 'br', 'wbr', 'template', 'head',
  ]);
  const JS_PROPERTIES = [
    'id', 'className', 'tagName', 'disabled', 'hidden', 'required', 'readOnly',
    'checked', 'selected', 'multiple', 'value', 'defaultValue', 'placeholder',
    'name', 'type', 'title', 'alt', 'href', 'src', 'role', 'tabIndex',
    'contentEditable', 'spellcheck', 'maxLength', 'minLength', 'min', 'max',
    'pattern', 'accept', 'autocomplete', 'dir', 'lang',
  ];
  const SKIP_ATTRIBUTES = new Set(['style', 'onclick', 'onload']);

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!element || typeof element.getClientRects !== 'function') return true;
    try {
      if (typeof element.checkVisibility === 'function') {
        return Boolean(element.checkVisibility());
      }
    } catch (_error) {
      // fall through to rects
    }
    const rects = element.getClientRects();
    return Boolean(rects && rects.length);
  }

  function collectChildTagCounts(element) {
    const descendantCounts = {};
    let olListItems = 0;
    let ulListItems = 0;
    const walk = (nodes, parent) => {
      const list = nodes || [];
      const length = list.length || 0;
      for (let index = 0; index < length; index += 1) {
        const child = list[index];
        if (!child) continue;
        const tag = String(child.tagName || '').toLowerCase();
        const parentTag = String((parent && parent.tagName) || '').toLowerCase();
        if (tag && !SKIP_CHILD_TAGS.has(tag)) {
          descendantCounts[tag] = (descendantCounts[tag] || 0) + 1;
          if (tag === 'li' && parentTag === 'ol') olListItems += 1;
          if (tag === 'li' && parentTag === 'ul') ulListItems += 1;
        }
        walk(child.children || [], child);
      }
    };
    walk(element && element.children ? element.children : [], element);
    const options = [];
    if (olListItems) {
      options.push({
        tag: 'li',
        descendantSelector: 'ol > li',
        count: olListItems,
        label: '<li> in <ol>',
      });
    }
    if (ulListItems) {
      options.push({
        tag: 'li',
        descendantSelector: 'ul > li',
        count: ulListItems,
        label: '<li> in <ul>',
      });
    }
    Object.keys(descendantCounts)
      .sort((left, right) => descendantCounts[right] - descendantCounts[left] || left.localeCompare(right))
      .slice(0, 16)
      .forEach((tag) => {
        if (tag === 'li' && (olListItems || ulListItems)) return;
        options.push({
          tag,
          descendantSelector: tag,
          count: descendantCounts[tag],
          label: `<${tag}>`,
        });
      });
    return options;
  }

  function collectAttributes(element) {
    const rows = [];
    const attrs = element && element.attributes ? element.attributes : [];
    const length = attrs.length || Object.keys(attrs).length || 0;
    if (typeof length === 'number' && attrs[0]) {
      for (let index = 0; index < attrs.length; index += 1) {
        const item = attrs[index];
        if (!item || !item.name) continue;
        const name = String(item.name);
        if (SKIP_ATTRIBUTES.has(name.toLowerCase())) continue;
        rows.push({ name, value: item.value == null ? '' : String(item.value) });
      }
      return rows;
    }
    Object.keys(attrs).forEach((name) => {
      if (SKIP_ATTRIBUTES.has(String(name).toLowerCase())) return;
      const value = attrs[name];
      if (value && typeof value === 'object' && value.name) {
        rows.push({ name: value.name, value: String(value.value || '') });
      }
    });
    return rows;
  }

  function collectJsProperties(element) {
    const rows = [];
    JS_PROPERTIES.forEach((name) => {
      if (!element || !(name in element)) return;
      const value = element[name];
      if (value == null) return;
      if (typeof value === 'function' || typeof value === 'object') return;
      if (typeof value === 'string' && !value.trim()) return;
      rows.push({ name, value });
    });
    return rows;
  }

  function snapshotFromElement(element) {
    if (!element) {
      return { tagName: '', text: '', visible: false, childCounts: [], attributes: [], properties: [], hasDisabled: false };
    }
    const tagName = String(element.tagName || '').toLowerCase();
    const text = normalizeText(element.innerText || element.textContent || '');
    return {
      tagName,
      text,
      visible: isVisible(element),
      hasDisabled: 'disabled' in element,
      disabled: Boolean(element.disabled),
      childCounts: collectChildTagCounts(element),
      attributes: collectAttributes(element),
      properties: collectJsProperties(element),
    };
  }

  function buildCheckOptions(snapshot) {
    const options = [];
    const data = snapshot || {};
    if (data.text) {
      options.push({
        id: 'text',
        kind: 'text',
        label: 'Text',
        value: data.text,
        operators: ['contains', 'equals'],
      });
    }
    (data.childCounts || []).forEach((item) => {
      options.push({
        id: `child:${item.descendantSelector || item.tag}`,
        kind: 'child_count',
        label: item.label || `<${item.tag}> count`,
        tag: item.tag,
        descendantSelector: item.descendantSelector || item.tag,
        value: item.count,
      });
    });
    options.push({
      id: 'state:visible',
      kind: 'state',
      label: 'visible',
      value: Boolean(data.visible),
      actionType: data.visible ? 'assert_visible' : 'assert_hidden',
    });
    options.push({
      id: 'state:hidden',
      kind: 'state',
      label: 'hidden',
      value: !data.visible,
      actionType: data.visible ? 'assert_hidden' : 'assert_visible',
    });
    if (data.hasDisabled) {
      options.push({
        id: 'state:enabled',
        kind: 'state',
        label: 'enabled',
        value: !data.disabled,
        actionType: data.disabled ? 'assert_disabled' : 'assert_enabled',
      });
      options.push({
        id: 'state:disabled',
        kind: 'state',
        label: 'disabled',
        value: Boolean(data.disabled),
        actionType: data.disabled ? 'assert_disabled' : 'assert_enabled',
      });
    }
    (data.properties || []).forEach((item) => {
      options.push({
        id: `prop:${item.name}`,
        kind: 'property',
        label: item.name,
        name: item.name,
        value: item.value,
      });
    });
    (data.attributes || []).forEach((item) => {
      options.push({
        id: `attr:${item.name}`,
        kind: 'attribute',
        label: item.name,
        name: item.name,
        value: item.value,
      });
    });
    return options;
  }

  function joinChildSelector(selector, selectorType, tag) {
    const parent = String(selector || '').trim();
    const child = String(tag || '').trim().toLowerCase();
    if (!child) return parent;
    if (!parent) return child;
    if (String(selectorType || '').toLowerCase() === 'xpath') {
      return `${parent}//${child}`;
    }
    return `${parent} ${child}`;
  }

  function cloneSelectorInfo(selectorInfo, overrides) {
    const base = selectorInfo && typeof selectorInfo === 'object' ? selectorInfo : {};
    return Object.assign({
      selector: base.selector || '',
      selector_type: base.selector_type || 'css',
      locator_bundle: base.locator_bundle || null,
    }, overrides || {});
  }

  function stringifyExpected(value) {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    return value == null ? '' : String(value);
  }

  function selectedChecksToActions(options, selections, selectorInfo, timeoutMs) {
    const actions = [];
    const chosen = selections || {};
    (options || []).forEach((option) => {
      const selection = chosen[option.id];
      if (!selection || !selection.selected) return;
      const timeout = timeoutMs || 5000;
      const base = cloneSelectorInfo(selectorInfo);
      if (option.kind === 'text') {
        const operator = String(selection.operator || 'contains').toLowerCase() === 'equals' ? 'equals' : 'contains';
        actions.push({
          action_type: 'assert_text',
          selector: base.selector,
          selector_type: base.selector_type,
          locator_bundle: base.locator_bundle,
          timeout_ms: timeout,
          text_value: selection.value == null ? option.value : String(selection.value),
          assertion_operator: operator,
          name: operator === 'equals' ? 'Check text equals' : 'Check text contains',
        });
        return;
      }
      if (option.kind === 'child_count') {
        const count = selection.value == null ? option.value : selection.value;
        const descendant = option.descendantSelector || option.tag;
        actions.push({
          action_type: 'assert_count',
          selector: base.selector,
          selector_type: base.selector_type,
          locator_bundle: base.locator_bundle,
          timeout_ms: timeout,
          text_value: String(count),
          assertion_operator: descendant,
          name: `Check ${option.label || '<' + option.tag + '>'} count`,
        });
        return;
      }
      if (option.kind === 'state') {
        let actionType = option.actionType;
        if (option.label === 'visible') actionType = 'assert_visible';
        if (option.label === 'hidden') actionType = 'assert_hidden';
        if (option.label === 'enabled') actionType = 'assert_enabled';
        if (option.label === 'disabled') actionType = 'assert_disabled';
        actions.push({
          action_type: actionType,
          selector: base.selector,
          selector_type: base.selector_type,
          locator_bundle: base.locator_bundle,
          timeout_ms: timeout,
          name: `Check ${option.label}`,
        });
        return;
      }
      if (option.kind === 'property') {
        actions.push({
          action_type: 'assert_property',
          selector: base.selector,
          selector_type: base.selector_type,
          locator_bundle: base.locator_bundle,
          timeout_ms: timeout,
          assertion_operator: option.name,
          text_value: stringifyExpected(selection.value == null ? option.value : selection.value),
          name: `Check property ${option.name}`,
        });
        return;
      }
      if (option.kind === 'attribute') {
        actions.push({
          action_type: 'assert_attribute',
          selector: base.selector,
          selector_type: base.selector_type,
          locator_bundle: base.locator_bundle,
          timeout_ms: timeout,
          assertion_operator: option.name,
          text_value: stringifyExpected(selection.value == null ? option.value : selection.value),
          name: `Check attribute ${option.name}`,
        });
      }
    });
    return actions;
  }

  function legacyCheckFromProperty(selectorInfo, property, timeoutMs, valueText) {
    const base = cloneSelectorInfo(selectorInfo);
    const action = {
      action_type: 'assert_visible',
      selector: base.selector,
      selector_type: base.selector_type,
      locator_bundle: base.locator_bundle,
      timeout_ms: timeoutMs,
      name: 'Check selected element',
    };
    const normalized = String(property || 'visible').toLowerCase();
    if (normalized === 'hidden') {
      action.action_type = 'assert_hidden';
      action.name = 'Check hidden';
      return action;
    }
    if (normalized === 'enabled') {
      action.action_type = 'assert_enabled';
      action.name = 'Check enabled';
      return action;
    }
    if (normalized === 'disabled') {
      action.action_type = 'assert_disabled';
      action.name = 'Check disabled';
      return action;
    }
    if (normalized === 'text_contains') {
      action.action_type = 'assert_text';
      action.text_value = valueText || '';
      action.assertion_operator = 'contains';
      action.name = 'Check text contains';
      return action;
    }
    if (normalized === 'value_equals') {
      action.action_type = 'assert_value';
      action.text_value = valueText || '';
      action.name = 'Check value';
      return action;
    }
    action.action_type = 'assert_visible';
    action.name = 'Check visible';
    return action;
  }

  globalThis.TestifyHubElementChecks = {
    snapshotFromElement,
    buildCheckOptions,
    selectedChecksToActions,
    joinChildSelector,
    legacyCheckFromProperty,
  };
})();
