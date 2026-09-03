/**
 * LiveKit — zero-flicker list reconciliation for the dashboard.
 *
 * Uses the vendored morphdom UMD (src/web/vendor/morphdom.js) to diff existing DOM nodes
 * against fresh template HTML in place: DOM identity, focus, scroll, and CSS transitions are
 * preserved, and nothing is ever rebuilt from scratch on a data refresh.
 *
 * Load order: morphdom → live-kit.js → dashboard.js → antigravity.js (all defer).
 */
window.LiveKit = (() => {
  "use strict";

  const morpher = window.morphdom || null;

  function parseHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content.firstElementChild;
  }

  /**
   * keyedMorph(root, items, options)
   *
   * root      - element whose *direct children* are the list items (cards, rows)
   * items     - array of data items
   * options:
   *   key(item)  -> stable string key
   *   html(item) -> full HTML string for the item's element; the outer tag must match the
   *                 existing child (morphdom diffs in place)
   *   keyAttr    -> attribute written onto each item element before/after render
   *                 (default "key"); existing elements are matched by reading it
   *   onMoved(el)-> optional callback after an item is re-ordered
   *
   * Guarantees:
   * - Existing children are diffed in place by morphdom (never rebuilt).
   * - New keys are appended as fresh parsed elements; removed keys are detached.
   * - Child order always matches `items` order (nodes are moved, never recreated).
   */
  function keyedMorph(root, items, options) {
    if (!root || !Array.isArray(items)) return;
    const keyAttr = options.keyAttr || "key";
    const readKey = (el) => (el && el.dataset ? el.dataset[keyAttr] : undefined);

    const existing = Array.from(root.children);
    const existingByKey = new Map();
    for (const el of existing) {
      const k = readKey(el);
      if (k) existingByKey.set(String(k), el);
    }

    const liveKeys = new Set();
    const ordered = [];
    for (const item of items) {
      const key = String(options.key(item));
      if (!key) continue;
      liveKeys.add(key);
      const html = options.html(item);
      let el = existingByKey.get(key);
      if (!el) {
        el = parseHtml(html);
        if (!el) continue;
        el.setAttribute(`data-${keyAttr}`, key);
        root.appendChild(el);
      } else {
        el.setAttribute(`data-${keyAttr}`, key);
        if (morpher) {
          morpher(el, html);
        } else {
          // No morphdom (dev/tests): fall back to a full in-place replace of children.
          const fresh = parseHtml(html);
          el.replaceWith(fresh);
          el = fresh;
        }
      }
      ordered.push(el);
    }

    for (const el of existing) {
      const k = readKey(el);
      if (k && !liveKeys.has(String(k))) el.remove();
    }

    for (let i = 0; i < ordered.length; i += 1) {
      const expected = ordered[i];
      if (root.children[i] !== expected) {
        root.insertBefore(expected, root.children[i] || null);
        if (options.onMoved) options.onMoved(expected);
      }
    }
  }

  /** Single-element morph helper. */
  function morphEl(el, html) {
    if (morpher) {
      morpher(el, html);
      return;
    }
    const fresh = parseHtml(html);
    if (fresh) el.replaceWith(fresh);
  }

  return { keyedMorph, morphEl, hasMorphdom: Boolean(morpher) };
})();
