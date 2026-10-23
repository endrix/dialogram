/**
 * Shared Markdown rendering for webview UI (chat panel, property panel).
 *
 * CommonMark via markdown-it, sanitized with DOMPurify before any DOM
 * injection. Raw HTML in the source is disabled; links are linkified.
 */

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// CommonMark's own line handling: a single newline joins the lines. Text a
// producer took from a document is wrapped at a column, and chat's
// line-per-newline breaks it mid-sentence at every one of them.
const documentMd = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Render Markdown to sanitized HTML, safe for innerHTML/unsafeHTML. */
export function renderMarkdownSafe(src: string): string {
  return DOMPurify.sanitize(md.render(src));
}

/** Render Markdown written in a document (wrapped prose) to sanitized HTML. */
export function renderDocumentMarkdownSafe(src: string): string {
  return DOMPurify.sanitize(documentMd.render(src));
}

/** Render inline Markdown (no block wrapping) to sanitized HTML. */
export function renderInlineMarkdownSafe(src: string): string {
  return DOMPurify.sanitize(md.renderInline(src));
}

/**
 * Cheap heuristic for "is this worth rendering as Markdown?" — used to keep
 * plain text in pre-wrap form instead of paying markdown layout for it.
 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(
    text
  );
}
