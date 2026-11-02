"use strict";
/**
 * Page-side logic that splits the Hark transcript into message rows and returns
 * only Hark's rows after the message sent from the glasses, stopping at the
 * next user message (for example something Ray typed on the computer).
 *
 * Hark's DOM is not documented, so user rows are recognised by shape: a row
 * that looks like the row holding the glasses message (same tag/class chain and
 * the same alignment styles) is a user row. When an earlier glasses message is
 * on the page we use it to find the message list and to check that the shape
 * really tells user rows from Hark rows.
 *
 * `harkSplit` runs inside the browser (stringified and injected), and in tests
 * against a fake DOM. It must only use the globals passed in `env`.
 */
function harkSplit(env, sent, previous, opts) {
  const doc = env.document;
  const style = env.getComputedStyle || (() => ({}));
  const o = opts || {};
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const keyOf = (s) => norm(s).slice(0, 40);
  const root = o.root || doc.body;
  const all = Array.from(root.querySelectorAll("*"));

  // Deepest element of the LAST occurrence of `text` (optionally before `limit`).
  function locate(text, limit) {
    const key = keyOf(text);
    if (!key) return null;
    let end = all.length;
    if (limit) {
      const i = all.indexOf(limit);
      if (i >= 0) end = i;
    }
    for (let i = end - 1; i >= 0; i--) {
      const el = all[i];
      if (norm(el.textContent).includes(key)) {
        // walk down while a child still holds the whole key
        let cur = el;
        for (;;) {
          const kid = Array.from(cur.children || []).find((c) => norm(c.textContent).includes(key));
          if (!kid) break;
          cur = kid;
        }
        if (!limit || !contains(cur, limit)) return cur;
      }
    }
    return null;
  }
  function contains(a, b) {
    for (let n = b; n; n = n.parentElement) if (n === a) return true;
    return false;
  }
  function ancestors(el) {
    const out = [];
    for (let n = el; n; n = n.parentElement) out.push(n);
    return out;
  }
  function lca(a, b) {
    const set = new Set(ancestors(a));
    for (let n = b; n; n = n.parentElement) if (set.has(n)) return n;
    return null;
  }
  function childToward(list, el) {
    let n = el;
    while (n && n.parentElement !== list) n = n.parentElement;
    return n;
  }
  function styleSig(el) {
    const s = style(el) || {};
    return [s.justifyContent, s.alignItems, s.alignSelf, s.textAlign, s.flexDirection, s.marginLeft === "auto" ? "ml-auto" : ""]
      .map((v) => v || "").join("|");
  }
  function sig(el, depth) {
    const parts = [];
    let n = el;
    for (let d = 0; n && d < depth; d++) {
      const cls = String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || "")
        .split(/\s+/).filter((c) => c && !/\d{3,}/.test(c)).sort().join(".");
      parts.push(`${String(n.tagName).toLowerCase()}.${cls}#${styleSig(n)}`);
      n = (n.children && n.children[0]) || null;
    }
    return parts.join(">");
  }
  function rowText(el) {
    return String(el.innerText !== undefined ? el.innerText : el.textContent || "");
  }

  const el = locate(sent);
  if (!el) return { ok: false, reason: "sent_not_found" };

  // Find the message list and the row holding our message.
  let list = null;
  let prevRow = null;
  for (const p of previous || []) {
    if (!keyOf(p) || keyOf(p) === keyOf(sent)) continue;
    const el2 = locate(p, el);
    if (!el2) continue;
    const l = lca(el, el2);
    if (l && l !== el && l !== el2) {
      list = l;
      prevRow = childToward(l, el2);
      break;
    }
  }
  if (!list) return { ok: false, reason: "list_not_found" };
  const rows = Array.from(list.children);
  const row = childToward(list, el);
  const at = rows.indexOf(row);
  if (at < 0) return { ok: false, reason: "row_not_found" };

  const isUser = (() => {
    if (o.userRowSelector) {
      return (r) => Boolean((r.matches && r.matches(o.userRowSelector)) || (r.querySelector && r.querySelector(o.userRowSelector)));
    }
    // Pick the shallowest depth whose signature matches both glasses rows and
    // differs from the Hark row that followed the earlier one.
    const pAt = rows.indexOf(prevRow);
    const hark = pAt >= 0 ? rows.slice(pAt + 1, at).find((r) => norm(r.textContent)) : null;
    for (let depth = 1; depth <= 4; depth++) {
      const s = sig(row, depth);
      if (prevRow && sig(prevRow, depth) !== s) continue;
      if (hark && sig(hark, depth) === s) continue;
      return (r) => sig(r, depth) === s;
    }
    return null;
  })();
  if (!isUser) return { ok: false, reason: "user_shape_ambiguous" };

  const out = [];
  let interrupted = false;
  for (const r of rows.slice(at + 1)) {
    if (isUser(r)) {
      interrupted = true;
      break;
    }
    const t = rowText(r).trim();
    if (t) out.push(t);
  }
  return { ok: true, text: out.join("\n\n"), interrupted };
}

module.exports = { harkSplit };
