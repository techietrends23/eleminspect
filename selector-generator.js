(() => {
  const DEFAULT_PREFERRED_TEST_ATTRIBUTES = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-qa',
    'data-cy',
    'data-e2e',
  ];

  function getPreferredTestAttributes() {
    const custom = window.WebRecorderSelectorConfig?.preferredTestAttributes;
    if (Array.isArray(custom) && custom.length) {
      return custom.map((attr) => String(attr || '').trim().toLowerCase()).filter(Boolean);
    }
    return DEFAULT_PREFERRED_TEST_ATTRIBUTES;
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return value.replace(/([#.;?+*~\':"!^$\[\]()=>|/@])/g, '\\$1');
  }

  function isUnique(selector, root = document) {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function isDynamicClassName(cls) {
    if (!cls || cls.length < 2) return true;
    // Skip hash-like classes: e.g. css-1a2b3c, sc-abc123, _1fGk2
    if (/^(css|sc|styled|emotion|jss|makeStyles)-/i.test(cls)) return true;
    if (/^_[a-zA-Z0-9]{4,}$/.test(cls)) return true;
    if (/[a-f0-9]{6,}/i.test(cls) && !/^(header|footer|nav|main|sidebar|container|wrapper)/i.test(cls)) return true;
    // Skip single random-looking tokens
    if (/^[A-Z][a-z]{1,3}[A-Z][a-z]{1,3}$/.test(cls)) return true;
    return false;
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function quoteText(text) {
    return JSON.stringify(text);
  }

  function getElementText(el) {
    if (!el) return '';
    if (el.matches('input[type="button"], input[type="submit"], input[type="reset"]')) {
      return normalizeText(el.value || '');
    }
    return normalizeText(el.innerText || el.textContent || '');
  }

  function getLabelText(el) {
    if (!el) return '';
    if (el.labels && el.labels.length) {
      const labelText = normalizeText(el.labels[0].innerText || el.labels[0].textContent || '');
      if (labelText) return labelText;
    }
    const labelParent = el.closest('label');
    if (labelParent) {
      const labelText = normalizeText(labelParent.innerText || labelParent.textContent || '');
      if (labelText) return labelText;
    }
    const id = el.getAttribute('id');
    if (id) {
      const explicit = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (explicit) {
        const labelText = normalizeText(explicit.innerText || explicit.textContent || '');
        if (labelText) return labelText;
      }
    }
    return '';
  }

  function getAccessibleName(el) {
    if (!el) return '';
    const ariaLabel = normalizeText(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => normalizeText(node.innerText || node.textContent || ''))
        .filter(Boolean);
      const combined = normalizeText(parts.join(' '));
      if (combined) return combined;
    }
    const labelText = getLabelText(el);
    if (labelText) return labelText;
    const altText = normalizeText(el.getAttribute('alt'));
    if (altText) return altText;
    return getElementText(el);
  }

  function getImplicitRole(el) {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (['checkbox'].includes(type)) return 'checkbox';
      if (['radio'].includes(type)) return 'radio';
      if (['range'].includes(type)) return 'slider';
      if (['search', 'text', 'email', 'tel', 'url', 'password', 'number'].includes(type)) return 'textbox';
    }
    return '';
  }

  function getRole(el) {
    const explicitRole = normalizeText(el.getAttribute('role'));
    if (explicitRole) return explicitRole;
    return getImplicitRole(el);
  }

  function getRoleCandidates(role) {
    switch (role) {
      case 'button':
        return document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]');
      case 'link':
        return document.querySelectorAll('a[href], [role="link"]');
      case 'textbox':
        return document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), textarea, [role="textbox"]');
      case 'checkbox':
        return document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
      case 'radio':
        return document.querySelectorAll('input[type="radio"], [role="radio"]');
      case 'combobox':
        return document.querySelectorAll('select, [role="combobox"]');
      case 'img':
        return document.querySelectorAll('img, [role="img"]');
      default:
        return document.querySelectorAll(`[role="${cssEscape(role)}"]`);
    }
  }

  function countMatchingText(candidates, text) {
    const normalized = normalizeText(text);
    if (!normalized) return 0;
    let count = 0;
    candidates.forEach((node) => {
      if (!(node instanceof Element)) return;
      if (getAccessibleName(node) === normalized) count += 1;
    });
    return count;
  }

  function isUniqueText(text, candidates) {
    return countMatchingText(candidates, text) === 1;
  }

  function asSelectorResult(selector, selectorType, label, reliability) {
    return {
      selector,
      selector_type: selectorType,
      label: label || selector,
      reliability: typeof reliability === 'number' ? reliability : null,
    };
  }

  function labelSelectorForElement(el) {
    const labelText = getLabelText(el);
    if (!labelText || labelText.length > 80) return null;
    const labels = Array.from(document.querySelectorAll('label'));
    if (!isUniqueText(labelText, labels)) return null;
    return asSelectorResult(labelText, 'label', `getByLabel(${quoteText(labelText)})`, 0.87);
  }

  function placeholderSelectorForElement(el) {
    const placeholder = normalizeText(el.getAttribute('placeholder'));
    if (!placeholder || placeholder.length > 80) return null;
    const placeholderSelector = `[placeholder="${cssEscape(placeholder)}"]`;
    if (!isUnique(placeholderSelector)) return null;
    return asSelectorResult(placeholder, 'placeholder', `getByPlaceholder(${quoteText(placeholder)})`, 0.83);
  }

  function altTextSelectorForElement(el) {
    const alt = normalizeText(el.getAttribute('alt'));
    if (!alt || alt.length > 80) return null;
    const candidates = document.querySelectorAll('img, [role="img"]');
    if (!isUniqueText(alt, candidates)) return null;
    return asSelectorResult(alt, 'alt', `getByAltText(${quoteText(alt)})`, 0.82);
  }

  function roleSelectorForElement(el) {
    const role = getRole(el);
    const name = getAccessibleName(el);
    if (!role || !name || name.length > 80) return null;
    const candidates = getRoleCandidates(role);
    if (!isUniqueText(name, candidates)) return null;
    const meta = { role, name, exact: true };
    return asSelectorResult(JSON.stringify(meta), 'role', `getByRole(${quoteText(role)}, { name: ${quoteText(name)} })`, 0.91);
  }

  function textSelectorForElement(el) {
    if (!el.matches('button, a, label, [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"]')) {
      return null;
    }
    const text = getElementText(el);
    if (!text || text.length > 80) return null;

    const candidates = document.querySelectorAll(
      'button, a, label, [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"]'
    );
    if (!isUniqueText(text, candidates)) return null;
    return asSelectorResult(text, 'text', `getByText(${quoteText(text)})`, 0.78);
  }

  function nameAttrSelectorForElement(el) {
    const name = el.getAttribute('name');
    if (!name) return null;
    const tag = el.tagName.toLowerCase();
    const selector = `${tag}[name="${cssEscape(name)}"]`;
    if (isUnique(selector)) return asSelectorResult(selector, 'css', selector, 0.88);
    // Try combining with type for inputs
    const type = el.getAttribute('type');
    if (type) {
      const combo = `${tag}[name="${cssEscape(name)}"][type="${cssEscape(type)}"]`;
      if (isUnique(combo)) return asSelectorResult(combo, 'css', combo, 0.87);
    }
    return null;
  }

  function dataAttrSelectorForElement(el) {
    const preferred = new Set(getPreferredTestAttributes());
    const commonDataAttrs = [
      'data-id', 'data-name', 'data-type', 'data-action', 'data-value',
      'data-target', 'data-toggle', 'data-cy', 'data-e2e', 'data-automation',
      'data-component', 'data-page', 'data-section',
      'data-testid', 'data-test-id', 'data-test', 'data-qa',
    ].filter((attr) => !preferred.has(attr));
    for (const attr of commonDataAttrs) {
      const value = el.getAttribute(attr);
      if (value && value.length <= 80) {
        const selector = `[${attr}="${cssEscape(value)}"]`;
        if (isUnique(selector)) return asSelectorResult(selector, 'css', selector, 0.85);
      }
    }
    return null;
  }

  function testIdSelectorForElement(el) {
    for (const attr of getPreferredTestAttributes()) {
      const testId = el.getAttribute(attr);
      if (!testId || testId.length > 80) continue;
      const selector = `[${attr}="${cssEscape(testId)}"]`;
      if (!isUnique(selector)) continue;
      const reliability = attr.includes('test') ? 0.95 : 0.93;
      const label = attr === 'data-testid'
        ? `getByTestId(${quoteText(testId)})`
        : selector;
      return asSelectorResult(testId, 'testid', label, reliability);
    }
    return null;
  }

  function titleSelectorForElement(el) {
    const title = normalizeText(el.getAttribute('title'));
    if (!title || title.length > 80) return null;
    const selector = `[title="${cssEscape(title)}"]`;
    if (isUnique(selector)) return asSelectorResult(selector, 'css', selector, 0.75);
    return null;
  }

  function ariaDescribedBySelectorForElement(el) {
    const describedBy = el.getAttribute('aria-describedby');
    if (!describedBy) return null;
    const selector = `[aria-describedby="${cssEscape(describedBy)}"]`;
    if (isUnique(selector)) return asSelectorResult(selector, 'css', selector, 0.74);
    return null;
  }

  function cssSelectorForElement(el) {
    const ariaLabel = normalizeText(el.getAttribute('aria-label'));
    if (ariaLabel) {
      const ariaSelector = `[aria-label="${cssEscape(ariaLabel)}"]`;
      if (isUnique(ariaSelector)) return asSelectorResult(ariaSelector, 'css', ariaSelector, 0.72);
    }

    if (el.id) {
      const idSelector = `#${cssEscape(el.id)}`;
      if (isUnique(idSelector)) return asSelectorResult(idSelector, 'css', idSelector, 0.76);
    }

    // Filter out dynamic/framework-generated class names
    const stableClasses = Array.from(el.classList || []).filter((c) => c && !isDynamicClassName(c));
    if (stableClasses.length) {
      const classSelector = stableClasses.slice(0, 3).map((c) => `.${cssEscape(c)}`).join('');
      const selector = `${el.tagName.toLowerCase()}${classSelector}`;
      if (isUnique(selector)) return asSelectorResult(selector, 'css', selector, 0.68);
    }

    // Combo: tag + stable attributes
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    if (type && stableClasses.length) {
      const combo = `${tag}[type="${cssEscape(type)}"]${stableClasses.slice(0, 2).map((c) => `.${cssEscape(c)}`).join('')}`;
      if (isUnique(combo)) return asSelectorResult(combo, 'css', combo, 0.66);
    }

    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      let selector = node.tagName.toLowerCase();
      const nodeStableClasses = Array.from(node.classList || []).filter((c) => c && !isDynamicClassName(c));
      if (nodeStableClasses.length) {
        selector += `.${nodeStableClasses.slice(0, 2).map((c) => cssEscape(c)).join('.')}`;
      }

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      const candidate = path.join(' > ');
      if (isUnique(candidate)) return asSelectorResult(candidate, 'css', candidate, 0.60);
      node = parent;
    }

    const fallback = path.join(' > ');
    return asSelectorResult(fallback, 'css', fallback, 0.50);
  }

  function textXPathSelectorForElement(el) {
    const tag = el.tagName.toLowerCase();
    const text = getElementText(el);
    if (!text || text.length > 60) return null;
    const shortText = text.slice(0, 40);
    const exactXpath = `//${tag}[normalize-space(.)=${quoteText(text)}]`;
    try {
      const result = document.evaluate(exactXpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      if (result.snapshotLength === 1) {
        return asSelectorResult(exactXpath, 'xpath', exactXpath, 0.73);
      }
    } catch (e) { /* ignore */ }
    const containsXpath = `//${tag}[contains(normalize-space(.), ${quoteText(shortText)})]`;
    try {
      const result = document.evaluate(containsXpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      if (result.snapshotLength === 1) {
        return asSelectorResult(containsXpath, 'xpath', containsXpath, 0.65);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function anchoredTextXPathSelectorForElement(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    const text = normalizeText(el.innerText || el.textContent || '');
    if (!text || text.length > 60) return null;
    const shortText = text.slice(0, 40);
    const anchor = el.closest('[data-testid]');
    if (!anchor) return null;
    const testId = normalizeText(getStableTestId(anchor));
    if (!testId) return null;
    const anchorTag = anchor.tagName.toLowerCase();
    const base = `//${anchorTag}[@data-testid=${xpathEscape(testId)}]//${tag}[contains(normalize-space(.), ${xpathEscape(shortText)})]`;
    const variants = [base, `(${base})[1]`];
    for (const xpath of variants) {
      try {
        if (!isUniqueXPath(xpath, el)) continue;
        return asSelectorResult(xpath, 'xpath', xpath, 0.84);
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function xpathEscape(value) {
    const text = String(value || '');
    if (!text.includes('"')) return `"${text}"`;
    if (!text.includes("'")) return `'${text}'`;
    const parts = text.split('"').map((part) => `"${part}"`);
    return `concat(${parts.join(', \'"\', ')})`;
  }

  function countAttributeMatches(attr, value) {
    const attrValue = String(value || '').trim();
    if (!attrValue) return 0;
    try {
      return document.querySelectorAll(`[${attr}="${cssEscape(attrValue)}"]`).length;
    } catch (e) {
      return 0;
    }
  }

  function countIdMatches(id) {
    const attributeCount = countAttributeMatches('id', id);
    if (attributeCount) return attributeCount;
    const value = String(id || '').trim();
    if (!value) return 0;
    try {
      const result = document.evaluate(
        `//*[@id=${xpathEscape(value)}]`,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return result.snapshotLength;
    } catch (e) {
      return 0;
    }
  }
  function isDynamicId(id) {
    const value = String(id || '').trim();
    if (!value) return true;
    if (/^mui-\d+$/i.test(value)) return true;
    if (/^:r[a-z0-9]+:$/i.test(value)) return true;
    if (/^[a-f0-9-]{20,}$/i.test(value)) return true;
    if (/^\d+$/.test(value)) return true;
    return false;
  }

  function isUniqueIdElement(el) {
    const id = String(el?.id || '').trim();
    if (!id || isDynamicId(id)) return false;
    try {
      return document.getElementById(id) === el && countIdMatches(id) === 1;
    } catch (e) {
      return false;
    }
  }

  function getStableTestId(el) {
    return el?.getAttribute?.('data-testid')
      || el?.getAttribute?.('data-test-id')
      || el?.getAttribute?.('data-test')
      || '';
  }

  function isUniqueTestIdElement(el) {
    const testId = normalizeText(getStableTestId(el));
    if (!testId) return false;
    try {
      const count = countAttributeMatches('data-testid', testId);
      if (count !== 1) return false;
      const selector = `[data-testid="${cssEscape(testId)}"]`;
      const nodes = document.querySelectorAll(selector);
      return nodes.length === 1 && nodes[0] === el;
    } catch (e) {
      return false;
    }
  }

  function xpathUsesDuplicateIdAnchor(xpath) {
    const pattern = /@id=(?:"([^"]+)"|'([^']+)')/g;
    let match = pattern.exec(String(xpath || ''));
    while (match) {
      const id = match[1] || match[2];
      if (id && countIdMatches(id) > 1) return true;
      match = pattern.exec(String(xpath || ''));
    }
    return false;
  }

  function isUniqueXPath(xpath, targetEl) {
    if (xpathUsesDuplicateIdAnchor(xpath)) return false;
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      if (result.snapshotLength !== 1) return false;
      if (targetEl && result.snapshotItem(0) !== targetEl) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isUniqueCssForElement(selector, targetEl) {
    try {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length !== 1) return false;
      if (targetEl && nodes[0] !== targetEl) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isUniqueLocatorForElement(candidate, targetEl) {
    if (!candidate?.selector || !targetEl) return false;
    const type = String(candidate.selector_type || 'css').toLowerCase();
    const value = String(candidate.selector || '').trim();
    if (!value) return false;
    if (type === 'xpath') return isUniqueXPath(value, targetEl);
    if (type === 'css') return isUniqueCssForElement(value, targetEl);
    if (type === 'id') {
      const id = value.startsWith('#') ? value.slice(1) : value;
      return countIdMatches(id) === 1 && document.getElementById(id) === targetEl;
    }
    if (type === 'testid') {
      try {
        const nodes = document.querySelectorAll(`[data-testid="${cssEscape(value)}"]`);
        return nodes.length === 1 && nodes[0] === targetEl;
      } catch (e) {
        return false;
      }
    }
    if (type === 'role') {
      try {
        const meta = JSON.parse(value);
        const role = normalizeText(meta.role);
        const name = normalizeText(meta.name);
        if (!role || !name) return false;
        const candidates = getRoleCandidates(role);
        if (!isUniqueText(name, candidates)) return false;
        let match = null;
        candidates.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (getAccessibleName(node) === name) match = node;
        });
        return match === targetEl;
      } catch (e) {
        return false;
      }
    }
    if (type === 'text') {
      const candidates = document.querySelectorAll(
        'button, a, label, [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"]',
      );
      if (!isUniqueText(value, candidates)) return false;
      let match = null;
      candidates.forEach((node) => {
        if (getElementText(node) === normalizeText(value)) match = node;
      });
      return match === targetEl;
    }
    if (type === 'label' || type === 'placeholder' || type === 'alt') {
      return true;
    }
    return false;
  }

  function anchorExpression(el) {
    if (isUniqueIdElement(el)) return `//*[@id=${xpathEscape(el.id)}]`;
    const testId = normalizeText(getStableTestId(el));
    if (testId && isUniqueTestIdElement(el)) return `//*[@data-testid=${xpathEscape(testId)}]`;
    return '';
  }

  function isDescendantOf(ancestor, node) {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentElement;
    }
    return false;
  }

  function buildSegmentForNode(node, options = {}) {
    const includeText = Boolean(options.includeText);
    const tag = node.tagName.toLowerCase();
    const attrParts = [];
    const testId = normalizeText(getStableTestId(node));
    const name = normalizeText(node.getAttribute('name'));
    const type = normalizeText(node.getAttribute('type'));
    const placeholder = normalizeText(node.getAttribute('placeholder'));
    const ariaLabel = normalizeText(node.getAttribute('aria-label'));

    if (testId) attrParts.push(`@data-testid=${xpathEscape(testId)}`);
    if (name) attrParts.push(`@name=${xpathEscape(name)}`);
    if (type) attrParts.push(`@type=${xpathEscape(type)}`);
    if (placeholder) attrParts.push(`@placeholder=${xpathEscape(placeholder)}`);
    if (ariaLabel) attrParts.push(`@aria-label=${xpathEscape(ariaLabel)}`);

    if (attrParts.length) return `${tag}[${attrParts.join(' and ')}]`;

    if (includeText) {
      const text = normalizeText(node.innerText || node.textContent || '');
      if (text && text.length <= 60) {
        const shortText = text.slice(0, 40);
        return `${tag}[contains(normalize-space(.), ${xpathEscape(shortText)})]`;
      }
    }

    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    return `${tag}[${index}]`;
  }

  function buildChildPathFromAnchor(anchor, target, options = {}) {
    const anchorExpr = anchorExpression(anchor);
    if (!anchorExpr || !isDescendantOf(anchor, target)) return '';
    const nodes = [];
    let node = target;
    while (node && node !== anchor) {
      nodes.unshift(node);
      node = node.parentElement;
    }
    if (node !== anchor || !nodes.length) return '';
    const segments = nodes.map((segmentNode, index) => {
      const useText = Boolean(options.includeText) && index === nodes.length - 1;
      return buildSegmentForNode(segmentNode, { includeText: useText });
    });
    return `${anchorExpr}/${segments.join('/')}`;
  }

  function buildUniqueChildPathFromAnchor(anchor, target) {
    const variants = [
      buildChildPathFromAnchor(anchor, target),
      buildChildPathFromAnchor(anchor, target, { includeText: true }),
    ];
    for (const xpath of variants) {
      if (xpath && isUniqueXPath(xpath, target)) return xpath;
    }
    return '';
  }

  function buildDescendantPathFromAnchor(anchor, target) {
    const anchorExpr = anchorExpression(anchor);
    if (!anchorExpr || !isDescendantOf(anchor, target) || anchor === target) return '';
    const targetSegment = buildSegmentForNode(target);
    if (!targetSegment.includes('@')) return '';
    return `${anchorExpr}//${targetSegment}`;
  }

  function buildSiblingXPathFromAnchor(anchor, target, axis) {
    if (!anchor || !target || anchor.parentElement !== target.parentElement) return '';
    const anchorExpr = anchorExpression(anchor);
    if (!anchorExpr) return '';
    const tag = target.tagName.toLowerCase();
    let index = 1;
    let sibling = axis === 'following-sibling' ? anchor.nextElementSibling : anchor.previousElementSibling;
    while (sibling && sibling !== target) {
      if (sibling.tagName === target.tagName) index += 1;
      sibling = axis === 'following-sibling' ? sibling.nextElementSibling : sibling.previousElementSibling;
    }
    if (sibling !== target) return '';
    return `${anchorExpr}/${axis}::${tag}[${index}]`;
  }

  function findAnchorElements(target) {
    const anchors = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || seen.has(node)) return;
      if (!isUniqueIdElement(node) && !isUniqueTestIdElement(node)) return;
      seen.add(node);
      anchors.push(node);
    };

    let node = target;
    while (node && node.nodeType === 1) {
      add(node);
      node = node.parentElement;
    }

    let previous = target.previousElementSibling;
    while (previous) {
      add(previous);
      previous = previous.previousElementSibling;
    }

    let next = target.nextElementSibling;
    while (next) {
      add(next);
      next = next.nextElementSibling;
    }

    return anchors;
  }

  function buildAxisPathFromAnchor(anchor, target, axis) {
    if (!anchor || !target || anchor === target) return '';
    const anchorExpr = anchorExpression(anchor);
    if (!anchorExpr) return '';
    const segment = buildSegmentForNode(target);
    if (!segment.includes('@')) return '';
    return `${anchorExpr}/${axis}::${segment}[1]`;
  }

  function xpathAnchoredSelectorsForElement(el) {
    if (!el || el.nodeType !== 1) return [];
    const results = [];
    const add = (xpath, reliability) => {
      if (!xpath || !isUniqueXPath(xpath, el)) return;
      results.push(asSelectorResult(xpath, 'xpath', xpath, reliability));
    };

    findAnchorElements(el).forEach((anchor) => {
      if (isDescendantOf(anchor, el)) {
        add(buildUniqueChildPathFromAnchor(anchor, el), anchor === el ? 0.94 : 0.9);
        add(buildDescendantPathFromAnchor(anchor, el), 0.88);
      }
      add(buildSiblingXPathFromAnchor(anchor, el, 'following-sibling'), 0.86);
      add(buildSiblingXPathFromAnchor(anchor, el, 'preceding-sibling'), 0.84);
      add(buildAxisPathFromAnchor(anchor, el, 'following'), 0.83);
      add(buildAxisPathFromAnchor(anchor, el, 'preceding'), 0.81);
    });

    return dedupeBySelector(results);
  }

  function xpathSelectorForElement(el) {
    const anchored = xpathAnchoredSelectorsForElement(el);
    if (anchored.length) return anchored[0];

    // Try text-based xpath first (more readable and robust)
    const textXpath = textXPathSelectorForElement(el);
    if (textXpath) return textXpath;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
      if (parts.length >= 6) break;
    }

    if (!parts.length) return null;
    const xpath = `//${parts.join('/')}`;
    if (!isUniqueXPath(xpath, el)) return null;
    return asSelectorResult(xpath, 'xpath', xpath, 0.45);
  }

  function dedupeBySelector(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (!item || !item.selector) return false;
      const key = `${item.selector_type || 'css'}::${item.selector}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function buildLocatorBundle(el) {
    const fastCandidates = dedupeBySelector([
      testIdSelectorForElement(el),
      nameAttrSelectorForElement(el),
      dataAttrSelectorForElement(el),
      roleSelectorForElement(el),
      labelSelectorForElement(el),
      placeholderSelectorForElement(el),
      altTextSelectorForElement(el),
      titleSelectorForElement(el),
      ariaDescribedBySelectorForElement(el),
      textSelectorForElement(el),
      cssSelectorForElement(el),
    ]);
    fastCandidates.sort((a, b) => (b.reliability || 0) - (a.reliability || 0));

    let candidates = fastCandidates;
    let primary = candidates[0] || cssSelectorForElement(el);

    const primaryReliability = Number(primary?.reliability) || 0;
    if (primaryReliability < 0.72) {
      const xpathFallback = dedupeBySelector([
        anchoredTextXPathSelectorForElement(el),
        xpathSelectorForElement(el),
      ].filter(Boolean));
      if (xpathFallback.length) {
        candidates = dedupeBySelector([...candidates, ...xpathFallback]);
        candidates.sort((a, b) => (b.reliability || 0) - (a.reliability || 0));
        primary = candidates[0] || primary;
      }
    }

    if (!primary) {
      primary = cssSelectorForElement(el);
    }
    if (primary && !candidates.length) {
      candidates = [primary];
    }

    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width >= 1 && rect.height >= 1) {
      const clientX = Math.round(rect.left + (rect.width / 2));
      const clientY = Math.round(rect.top + (rect.height / 2));
      const coordSelector = JSON.stringify({
        x: Math.round(clientX + window.scrollX),
        y: Math.round(clientY + window.scrollY),
        clientX,
        clientY,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      candidates = dedupeBySelector([
        ...candidates,
        asSelectorResult(coordSelector, 'coordinates', `(${clientX}, ${clientY})`, 0.4),
      ]);
    }

    return {
      primary,
      candidates,
      strategy_order: ['testid', 'name', 'data-attr', 'role', 'label', 'placeholder', 'alt', 'title', 'aria-describedby', 'text', 'css', 'xpath', 'coordinates'],
    };
  }

  function selectorFromElement(el) {
    if (!el || el.nodeType !== 1) return '';
    const bundle = buildLocatorBundle(el);
    const primary = bundle.primary;
    if (!primary) return '';
    return {
      selector: primary.selector,
      selector_type: primary.selector_type || 'css',
      label: primary.label || primary.selector,
      locator_bundle: bundle,
    };
  }

  window.WebRecorderSelector = {
    selectorFromElement,
    locatorBundleFromElement: buildLocatorBundle,
    xpathAnchoredSelectorsForElement,
    isUniqueLocatorForElement,
    setPreferredTestAttributes(attributes) {
      window.WebRecorderSelectorConfig = {
        ...(window.WebRecorderSelectorConfig || {}),
        preferredTestAttributes: Array.isArray(attributes) ? attributes : [],
      };
    },
  };
})();
