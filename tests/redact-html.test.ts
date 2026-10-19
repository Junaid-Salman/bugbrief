/** Step 8: outerHTML scanner (G19, Q7, Q10, §2.4) and the selector helper (G20). */
import { describe, expect, it } from 'vitest';
import { redactHtml, redactSelector } from '../src/core/redact/redact-html';

const R = '[REDACTED]';

describe('redactHtml', () => {
  it('masks value on password and hidden inputs, and on inputs with sensitive names', () => {
    expect(redactHtml('<input type="password" value="hunter2">').text).toBe(`<input type="password" value="${R}">`);
    expect(redactHtml("<input type='hidden' name='csrf' value='abc123'>").text).toBe(`<input type='hidden' name='csrf' value='${R}'>`);
    expect(redactHtml('<input name="api_key" value="k-123">').text).toBe(`<input name="api_key" value="${R}">`);
    expect(redactHtml('<input id="authToken" value=xyz>').text).toBe(`<input id="authToken" value=${R}>`);
    expect(redactHtml('<input autocomplete="current-password" value="pw">').text).toBe(
      `<input autocomplete="current-password" value="${R}">`,
    );
  });

  it('leaves ordinary inputs alone', () => {
    const html = '<input type="text" name="username" value="ann"><button class="author">Go</button>';
    expect(redactHtml(html)).toEqual({ text: html, count: 0 });
  });

  it('masks textarea content only when the field is sensitive', () => {
    expect(redactHtml('<textarea name="secret">top secret</textarea>').text).toBe(`<textarea name="secret">${R}</textarea>`);
    expect(redactHtml('<textarea name="note">hello</textarea>').text).toBe('<textarea name="note">hello</textarea>');
  });

  it('masks data-* attributes with sensitive names and csrf meta tags (Q10)', () => {
    expect(redactHtml('<div data-token="abc" data-id="7"></div>').text).toBe(`<div data-token="${R}" data-id="7"></div>`);
    expect(redactHtml('<meta name="csrf-token" content="abc123def">').text).toBe(`<meta name="csrf-token" content="${R}">`);
    expect(redactHtml('<meta name="viewport" content="width=device-width">').count).toBe(0);
  });

  it('is quote-aware: a > inside a value does not end the tag', () => {
    expect(redactHtml('<input type="password" title="a > b" value="hunter2">').text).toBe(
      `<input type="password" title="a > b" value="${R}">`,
    );
  });

  it('runs the free-text rules over text nodes, script text and attribute values', () => {
    expect(redactHtml('<p>mail jane@example.com</p>').text).toBe('<p>mail j***@example.com</p>');
    expect(redactHtml('<script>window.__S={"token":"abc","a":"<b>"};</script>').text).toBe(
      `<script>window.__S={"token":"${R}","a":"<b>"};</script>`,
    );
    expect(redactHtml('<a href="https://x.com/cb?token=abc&amp;x=1">go</a>').text).toBe(
      `<a href="https://x.com/cb?token=${R}&amp;x=1">go</a>`,
    );
    expect(redactHtml('<div data-config=\'{"password":"x"}\'></div>').text).toBe(`<div data-config='{"password":"${R}"}'></div>`);
  });

  it('masks entity-encoded secrets as a whole attribute value (Q7)', () => {
    expect(redactHtml('<div title="&#106;ane&#64;example.com"></div>').text).toBe(`<div title="${R}"></div>`);
    expect(redactHtml('<div title="a &amp; b"></div>').count).toBe(0);
    expect(redactHtml('<div title="x&#61;1 token&#61;abc123"></div>').text).toBe(`<div title="${R}"></div>`);
  });

  it('keeps SRI hashes and clean markup untouched', () => {
    const html =
      '<script src="/a.js" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" crossorigin></script><!-- note --><div class="a-b">x &lt; y</div>';
    expect(redactHtml(html)).toEqual({ text: html, count: 0 });
  });

  it('handles tags cut mid-attribute and trailing unterminated tags', () => {
    expect(redactHtml('<input type="password" value="hunt').text).toBe(`<input type="password" value="${R}`);
    expect(redactHtml('<div class="x" data-token="abc').text).toBe(`<div class="x" data-token="${R}`);
    expect(redactHtml('<div').text).toBe('<div');
    expect(redactHtml('a < b and c > d').text).toBe('a < b and c > d');
  });

  it('applies the tolerant token forms only to cut HTML (Q19, criterion 15)', () => {
    const html = '<div title="x">eyJhbGciOiJ';
    expect(redactHtml(html).text).toBe(html);
    expect(redactHtml(html, { cut: true }).text).toBe(`<div title="x">${R}`);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij';
    for (let length = 3; length <= jwt.length; length++) {
      const out = redactHtml(`<p>${jwt.slice(0, length)}`, { cut: true }).text;
      const unmasked = out.replace('<p>', '').split(R)[0] ?? '';
      expect(unmasked.length, `cut at ${length}`).toBeLessThan(12);
    }
    // A tag cut mid-attribute value also counts.
    expect(redactHtml('<div title="eyJhbGciOiJ', { cut: true }).text).toBe(`<div title="${R}`);
  });

  it('is idempotent', () => {
    const once = redactHtml('<input type="password" value="x"><p>jo@x.org</p>').text;
    const twice = redactHtml(once);
    expect(twice.text).toBe(once);
    expect(twice.count).toBe(0);
  });
});

describe('redactSelector', () => {
  it('always masks [value=…] and attributes with sensitive names', () => {
    expect(redactSelector('input[value="hunter2"]').text).toBe(`input[value="${R}"]`);
    expect(redactSelector("div[data-token='abc'] > span").text).toBe(`div[data-token='${R}'] > span`);
    expect(redactSelector('a[href=secret-x]').text).toBe('a[href=secret-x]');
  });

  it('leaves ordinary selectors alone', () => {
    for (const selector of ['#app > div.card:nth-child(2) > button', 'input[type="text"]', 'form[name="login"]']) {
      expect(redactSelector(selector)).toEqual({ text: selector, count: 0 });
    }
  });
});
