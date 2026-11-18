/* Antigravity UI i18n Runtime Injector (Injected into dist/preload.js) */
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__AGY_I18N_INSTALLED__) return;
  window.__AGY_I18N_INSTALLED__ = true;

  // Placeholder replaced by patch.mjs during build
  const DICT = __AGY_I18N_DICT__;
  const STORAGE_KEY = 'agy_ui_lang';

  const COMPILED_PATTERNS = (DICT.patterns || []).map((p) => ({
    re: new RegExp(p.regex),
    replace: p.replace,
    translateTimeUnits: Boolean(p.translateTimeUnits),
  }));

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'PRE',
    'CODE',
    'KBD',
    'SAMP',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'SVG',
  ]);

  const MAX_TEXT_LEN = 300;
  const originalTextMap = new WeakMap();
  const originalAttrMap = new WeakMap();

  let currentLang = 'zh';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') currentLang = saved;
  } catch {
    // Ignore storage access errors on about:blank or restricted origins
  }

  let isApplying = false;
  let scheduled = false;
  let toggleBtnEl = null;
  let toastEl = null;
  let toastTimer = null;

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (SKIP_TAGS.has(cur.tagName)) return true;
      if (
        cur.hasAttribute('data-agy-i18n-ignore') ||
        cur.getAttribute('contenteditable') === 'true' ||
        cur.classList?.contains('monaco-editor') ||
        cur.classList?.contains('xterm') ||
        cur.classList?.contains('cm-editor')
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function localizeTimeUnits(str) {
    return str
      .replace(/(\d+)\s*days?/gi, '$1 天')
      .replace(/(\d+)\s*hours?/gi, '$1 小时')
      .replace(/(\d+)\s*minutes?/gi, '$1 分钟')
      .replace(/(\d+)\s*seconds?/gi, '$1 秒')
      .replace(/,\s*/g, ' ');
  }

  function translateString(raw, table, usePatterns = false) {
    if (!raw || raw.length > MAX_TEXT_LEN) return null;
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    if (!match) return null;
    const [, lead, core, trail] = match;
    if (!core) return null;
    const normalized = core.replace(/\s+/g, ' ');
    const exactHit = table[core] ?? table[normalized];
    if (exactHit) {
      return lead + exactHit + trail;
    }
    if (usePatterns) {
      for (const pat of COMPILED_PATTERNS) {
        const m = pat.re.exec(normalized);
        if (m) {
          let out = pat.replace.replace(/\$(\d+)/g, (_, idx) => {
            const val = m[Number(idx)] ?? '';
            return pat.translateTimeUnits ? localizeTimeUnits(val) : val;
          });
          return lead + out + trail;
        }
      }
    }
    return null;
  }

  function processTextNode(node) {
    const parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) return;

    const curVal = node.nodeValue;
    if (!curVal || !curVal.trim()) return;

    let orig = originalTextMap.get(node);
    if (orig === undefined) {
      if (!translateString(curVal, DICT.exact, true)) return;
      orig = curVal;
      originalTextMap.set(node, orig);
    }

    const target = currentLang === 'zh'
      ? (translateString(orig, DICT.exact, true) ?? orig)
      : orig;

    if (curVal !== target) {
      node.nodeValue = target;
    }
  }

  function shouldSkipAttributeElement(el) {
    if (!el || el.nodeType !== 1) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.tagName === 'SCRIPT' || cur.tagName === 'STYLE' || cur.tagName === 'SVG') {
        return true;
      }
      if (
        cur.hasAttribute('data-agy-i18n-ignore') ||
        cur.classList?.contains('monaco-editor') ||
        cur.classList?.contains('xterm') ||
        cur.classList?.contains('cm-editor')
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function processAttributes(el) {
    if (!el || el.nodeType !== 1 || shouldSkipAttributeElement(el)) return;
    const attrs = ['placeholder', 'data-placeholder', 'aria-label', 'title'];
    for (const attr of attrs) {
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr);
      if (!val || val.length > MAX_TEXT_LEN) continue;

      let record = originalAttrMap.get(el);
      if (!record) {
        record = {};
        originalAttrMap.set(el, record);
      }
      if (!(attr in record)) {
        const hit =
          translateString(val, DICT.attributes, false) ||
          translateString(val, DICT.exact, true);
        if (!hit) continue;
        record[attr] = val;
      }
      const orig = record[attr];
      const target = currentLang === 'zh'
        ? (
          translateString(orig, DICT.attributes, false) ??
          translateString(orig, DICT.exact, true) ??
          orig
        )
        : orig;
      if (val !== target) {
        el.setAttribute(attr, target);
      }
    }
  }

  function applyTree(root) {
    if (!root) return;
    isApplying = true;
    try {
      if (root.nodeType === 3) {
        processTextNode(root);
        return;
      }
      if (root.nodeType === 1) {
        processAttributes(root);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let cur = walker.nextNode();
      while (cur) {
        if (cur.nodeType === 3) {
          processTextNode(cur);
        } else if (cur.nodeType === 1) {
          processAttributes(cur);
        }
        cur = walker.nextNode();
      }
    } finally {
      isApplying = false;
    }
  }

  function scheduleFullApply() {
    if (scheduled || !document.body) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      applyTree(document.body);
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = '0';
    }, 2400);
  }

  function collectUntranslated() {
    if (!document.body) return;
    const found = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !shouldSkipElement(parent)) {
        const raw = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (
          raw &&
          raw.length <= MAX_TEXT_LEN &&
          /[A-Za-z]{2,}/.test(raw) &&
          !originalTextMap.has(node) &&
          !(raw in DICT.exact) &&
          !/^(https?:\/\/|file:\/\/|[0-9.\-:/]+$)/.test(raw)
        ) {
          found.add(raw);
        }
      }
      node = walker.nextNode();
    }
    const list = [...found];
    const payload = JSON.stringify(list, null, 2);
    try {
      navigator.clipboard?.writeText(payload).then(
        () => showToast(`已复制 ${list.length} 条英文词条`),
        () => showToast(`采集到 ${list.length} 条，请检查剪贴板权限`)
      );
    } catch {
      showToast(`采集到 ${list.length} 条`);
    }
  }

  function updateToggleButton() {
    if (!toggleBtnEl) return;
    toggleBtnEl.textContent = currentLang === 'zh' ? '中' : 'En';
    toggleBtnEl.title = currentLang === 'zh'
      ? '左键或 Alt+Shift+L 切换英文；右键或 Ctrl+Shift+U 复制本页未翻译词条'
      : 'Click or Alt+Shift+L for Chinese; Right-click or Ctrl+Shift+U to copy untranslated strings';
  }

  function setLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    try {
      window.localStorage.setItem(STORAGE_KEY, currentLang);
    } catch {
      // Ignore storage errors
    }
    updateToggleButton();
    if (document.body) {
      applyTree(document.body);
    }
  }

  function toggleLanguage() {
    setLanguage(currentLang === 'zh' ? 'en' : 'zh');
  }

  function mountToggleUI() {
    if (window !== window.top || window.innerWidth < 480) return;
    if (!document.body || document.getElementById('agy-i18n-host')) return;

    const host = document.createElement('div');
    host.id = 'agy-i18n-host';
    host.setAttribute('data-agy-i18n-ignore', '1');
    host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:auto;display:flex;align-items:center;gap:6px;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .toast {
        padding: 4px 8px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.88);
        color: #f8fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 11px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
        white-space: nowrap;
      }
      button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 26px;
        padding: 0 8px;
        border-radius: 999px;
        border: 1px solid rgba(128, 128, 128, 0.35);
        background: rgba(30, 41, 59, 0.78);
        color: #f8fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        backdrop-filter: blur(6px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
        opacity: 0.72;
        transition: opacity 0.15s, transform 0.15s;
      }
      button:hover {
        opacity: 1;
        transform: translateY(-1px);
      }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const toast = document.createElement('span');
    toast.className = 'toast';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLanguage();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      collectUntranslated();
    });

    wrap.appendChild(toast);
    wrap.appendChild(btn);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.body.appendChild(host);
    toggleBtnEl = btn;
    toastEl = toast;
    updateToggleButton();
  }

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 50);
      return;
    }
    applyTree(document.body);
    mountToggleUI();

    const observer = new MutationObserver((mutations) => {
      if (isApplying) return;
      let needsApply = false;
      for (const m of mutations) {
        if (m.type === 'characterData') {
          const t = m.target;
          if (t.parentElement && !shouldSkipElement(t.parentElement)) {
            const newVal = t.nodeValue;
            if (translateString(newVal, DICT.exact, true)) {
              originalTextMap.set(t, newVal);
            }
            needsApply = true;
          }
        } else if (m.type === 'childList' && m.addedNodes.length > 0) {
          needsApply = true;
        } else if (m.type === 'attributes') {
          const el = m.target;
          if (!shouldSkipAttributeElement(el)) {
            const attr = m.attributeName;
            const val = el.getAttribute(attr);
            if (
              val &&
              (translateString(val, DICT.attributes, false) ||
                translateString(val, DICT.exact, true))
            ) {
              let rec = originalAttrMap.get(el);
              if (!rec) {
                rec = {};
                originalAttrMap.set(el, rec);
              }
              rec[attr] = val;
            }
            needsApply = true;
          }
        }
      }
      if (needsApply) {
        scheduleFullApply();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'data-placeholder', 'aria-label', 'title'],
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      toggleLanguage();
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'U' || e.key === 'u')) {
      e.preventDefault();
      collectUntranslated();
    }
  }, true);

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
