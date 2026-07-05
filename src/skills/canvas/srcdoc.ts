// Canvas — srcdoc helpers.
//
// Preview surfaces (the inline /canvas iframe, the expand overlay, and the
// /view route) render artifacts via `srcdoc` rather than a tokened URL — see
// docs/superpowers/specs/2026-05-15-canvas-tab-preview-and-logs-design.md §2.
// Because a srcdoc document has no HTTP response, the §7 CSP must travel
// inside the document as a <meta> tag.

/** The artifact CSP — identical to the header the /file route sets. */
export const CANVAS_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: https:",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  // NOTE: frame-ancestors is ignored when this CSP is delivered via <meta>
  // (header-only directive). Kept here so CANVAS_CSP stays byte-identical to
  // the /file route's HTTP-header CSP. iframe sandbox is the real frame guard.
  "frame-ancestors 'self'",
].join('; ');

/**
 * Inject the CSP <meta> as the first child of <head>. Does NOT assume a
 * <head> exists: extractHtml() guarantees one only when it wraps a bare
 * fragment, not when the model emits <html> without <head>.
 *
 * Returns raw HTML; callers embedding the result in a srcdoc="..." attribute
 * must wrap it with escapeHtmlAttr first.
 */
export function withCspMeta(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;
  const s = html || '';
  if (/<head[^>]*>/i.test(s)) {
    return s.replace(/<head[^>]*>/i, (m) => m + meta);
  }
  if (/<html[^>]*>/i.test(s)) {
    return s.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  }
  return `<head>${meta}</head>${s}`;
}

/** Escape a string for use inside a double-quoted HTML attribute. */
export function escapeHtmlAttr(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Escape a string for use as HTML text content. */
export function escapeHtmlText(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
