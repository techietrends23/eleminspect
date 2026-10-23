(function (root) {
  const MATCH_LOCATOR_TYPES = [
    'css', 'xpath', 'id', 'role', 'text', 'label', 'placeholder', 'alt', 'testid', 'title', 'name',
  ];

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function queryAllSafe(doc, selector) {
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch (error) {
      return { error: error.message || 'Invalid CSS selector' };
    }
  }

  function normalizeId(value) {
    const raw = String(value || '').trim();
    return raw.startsWith('#') ? raw.slice(1) : raw;
  }

  function xpathVariants(raw) {
    const variants = [];
    const seen = new Set();
    const add = (value) => {
      const expr = String(value || '').trim().replace(/^xpath=/i, '');
      if (!expr || seen.has(expr)) return;
      seen.add(expr);
      variants.push(expr);
    };
    add(raw);
    const grouped = String(raw || '').trim().match(/^\((.+)\)\[(\d+)\]$/s);
    if (grouped && grouped[1]) add(grouped[1]);
    if (/contains\s*\(\s*text\s*\(\s*\)\s*,/i.test(raw)) {
      add(String(raw).replace(/contains\s*\(\s*text\s*\(\s*\)\s*,/gi, 'contains(normalize-space(.) ,'));
      add(String(raw).replace(/contains\s*\(\s*text\s*\(\s*\)\s*,/gi, 'contains(.,'));
    }
    return variants;
  }

  function queryLocatorMatches(doc, type, value) {
    const locatorType = String(type || '').toLowerCase();
    const raw = String(value || '').trim();
    if (!raw) return { error: 'Enter a locator value', matches: [] };
    if (!MATCH_LOCATOR_TYPES.includes(locatorType)) {
      return { error: `Unsupported locator type: ${locatorType}`, matches: [] };
    }
    try {
      if (locatorType === 'css') {
        const found = queryAllSafe(doc, raw);
        if (found && found.error) return { error: found.error, matches: [] };
        return { error: null, matches: found };
      }
      if (locatorType === 'id') {
        const id = normalizeId(raw);
        const node = doc.getElementById(id);
        return { error: null, matches: node ? [node] : [] };
      }
      if (locatorType === 'xpath') {
        const variants = xpathVariants(raw);
        let lastError = null;
        for (const variant of variants) {
          try {
            const result = doc.evaluate(variant, doc, null, 7, null); // ORDERED_NODE_SNAPSHOT_TYPE
            const matches = [];
            for (let i = 0; i < result.snapshotLength; i += 1) matches.push(result.snapshotItem(i));
            if (matches.length) return { error: null, matches };
          } catch (error) {
            lastError = error;
          }
        }
        if (lastError) return { error: lastError.message || 'Locator query failed', matches: [] };
        return { error: null, matches: [] };
      }
      const attrMap = {
        testid: (v) => `[data-testid="${v}"]`,
        title: (v) => `[title="${v}"]`,
        name: (v) => `[name="${v}"]`,
        placeholder: (v) => `[placeholder="${v}"]`,
        alt: (v) => `[alt="${v}"]`,
        label: (v) => `[aria-label="${v}"]`,
        role: (v) => `[role="${v}"]`,
      };
      if (attrMap[locatorType]) {
        const found = queryAllSafe(doc, attrMap[locatorType](raw));
        if (found && found.error) return { error: found.error, matches: [] };
        return { error: null, matches: found };
      }
      if (locatorType === 'text') {
        const needle = raw.toLowerCase();
        const all = Array.from((doc.body || doc).querySelectorAll('*'));
        return {
          error: null,
          matches: all.filter((node) => String(node.textContent || '').toLowerCase().includes(needle)),
        };
      }
      return { error: null, matches: [] };
    } catch (error) {
      return { error: error.message || 'Locator query failed', matches: [] };
    }
  }

  function summarizeMatch(node) {
    const tag = String(node && node.tagName ? node.tagName : 'element').toLowerCase();
    const text = String(node && (node.innerText || node.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const id = node && node.id ? `#${node.id}` : '';
    return { tag, text, selector: id || tag };
  }

  root.TestifyHubLocatorMatch = { MATCH_LOCATOR_TYPES, queryLocatorMatches, summarizeMatch };
})(typeof globalThis !== 'undefined' ? globalThis : window);
