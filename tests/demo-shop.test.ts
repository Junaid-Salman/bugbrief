import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_SECRETS } from './helpers/demo-secrets';

const read = (name: string): string => readFileSync(new URL(`../demo/shop/${name}`, import.meta.url), 'utf8');
const files = ['index.html', 'app.js', 'styles.css', 'orders.mjs'] as const;

describe('the planted bugs are in place and the page matches the design', () => {
  it('the cart summary maps over a field only the first item has (TypeError)', () => {
    expect(read('app.js')).toContain('item.discounts.map');
    expect(read('app.js')).not.toMatch(/discounts\s*\?\?|discounts\?\./);
  });

  it('the order service reads a total the client never sends (500)', () => {
    expect(read('orders.mjs')).toContain('order.total.toFixed');
    expect(read('app.js')).not.toContain('total:');
  });

  it('the cart items stack in a column, as in the design', () => {
    const css = read('styles.css');
    expect(css).toMatch(/\.cart-list \{[^}]*flex-direction: column/);
    expect(css).not.toMatch(/\.cart-list \{[^}]*flex-direction: row/);
  });

  it('the failure is silent on the page: no status text is rendered', () => {
    expect(read('index.html')).not.toContain('role="status"');
    expect(read('app.js')).not.toContain('textContent = \'Could not');
  });
});

describe('the demo does not give the answer away', () => {
  it.each(files)('%s has no comments', (name) => {
    const source = read(name);
    expect(source).not.toMatch(/(^|\s)\/\/\s/);
    expect(source).not.toContain('/*');
    expect(source).not.toContain('<!--');
  });
});

describe('seeded secrets are where the leak check expects them', () => {
  it('the bearer token is sent by the script and the email and csrf value are in the page', () => {
    expect(read('app.js')).toContain(DEMO_SECRETS.bearer);
    expect(read('index.html')).toContain(DEMO_SECRETS.email);
    expect(read('index.html')).toContain(DEMO_SECRETS.csrf);
  });

  it('every secret is fake and marked as such', () => {
    for (const value of [DEMO_SECRETS.urlToken, DEMO_SECRETS.bearer, DEMO_SECRETS.csrf]) expect(value).toMatch(/^demo-/);
    expect(DEMO_SECRETS.email.endsWith('@example.com')).toBe(true);
  });
});
