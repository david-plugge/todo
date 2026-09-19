import DOMPurify from 'dompurify';
import { marked } from 'marked';

// A task note is prose, not a document: no headings beyond the basics, no raw
// HTML, no images. Everything outside this list is dropped rather than escaped.
const allowedTags = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'hr',
];

function escapeText(source: string): string {
  return source.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

/** Renders a task note to sanitized HTML. Links stay clickable but cannot carry script URLs. */
export function renderNote(source: string): string {
  // Prerendering has no DOM for the sanitizer. Notes are client-only data, so
  // escaped text is a correct placeholder until hydration takes over.
  if (typeof window === 'undefined') return `<p>${escapeText(source)}</p>`;
  const html = marked.parse(source, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
    ADD_ATTR: ['target', 'rel'],
  });
}

/** True when the note holds nothing a reader would see. */
export function isBlankNote(source: string | null | undefined): boolean {
  return !source || source.trim() === '';
}
