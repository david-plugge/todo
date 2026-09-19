// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isBlankNote, renderNote } from './markdown';

describe('renderNote', () => {
  it('renders the common inline marks', () => {
    const html = renderNote('**fett** und *kursiv* mit `code`');
    expect(html).toContain('<strong>fett</strong>');
    expect(html).toContain('<em>kursiv</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('keeps lists and links', () => {
    const html = renderNote('- eins\n- zwei\n\n[Beleg](https://example.com)');
    expect(html).toContain('<li>eins</li>');
    expect(html).toContain('href="https://example.com"');
  });

  it('drops raw HTML instead of executing it', () => {
    const html = renderNote('<img src=x onerror="alert(1)"> <script>alert(2)</script> Text');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
    expect(html).toContain('Text');
  });

  it('rejects script URLs in links', () => {
    const html = renderNote('[klick](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });
});

describe('isBlankNote', () => {
  it('treats empty, missing and whitespace-only notes as blank', () => {
    expect(isBlankNote(undefined)).toBe(true);
    expect(isBlankNote(null)).toBe(true);
    expect(isBlankNote('   \n  ')).toBe(true);
    expect(isBlankNote('Notiz')).toBe(false);
  });
});
