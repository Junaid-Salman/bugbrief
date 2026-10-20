import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyDemo } from '../scripts/demo-verify.mjs';
import { applyReferenceFix, copyDemo, fixOrderService, fixSummary, type DemoCopy } from './helpers/demo-reference-fix';

const copies: DemoCopy[] = [];
function fresh(): DemoCopy {
  const copy = copyDemo();
  copies.push(copy);
  return copy;
}
afterEach(() => {
  while (copies.length > 0) copies.pop()?.remove();
});

const failed = (results: Array<{ name: string; ok: boolean }>) => results.filter((result) => !result.ok).map((result) => result.name);

describe('demo:verify', () => {
  it('is red on the unfixed demo and names the three broken checks', async () => {
    const { ok, results } = await verifyDemo(fresh().folder);
    expect(ok).toBe(false);
    expect(failed(results)).toEqual([
      'no uncaught error while the page loads',
      'the order request succeeds with the right total',
      'the page logs no console error',
    ]);
  }, 30_000);

  it('is green on a reference fix', async () => {
    const copy = fresh();
    applyReferenceFix(copy);
    const { ok, results } = await verifyDemo(copy.folder);
    expect(failed(results)).toEqual([]);
    expect(ok).toBe(true);
  }, 30_000);

  it('is still red when only the page is fixed', async () => {
    const copy = fresh();
    fixSummary(copy);
    const { results } = await verifyDemo(copy.folder);
    expect(failed(results)).toEqual(['the order request succeeds with the right total', 'the page logs no console error']);
  }, 30_000);

  it('is still red when only the service is fixed', async () => {
    const copy = fresh();
    fixOrderService(copy);
    const { results } = await verifyDemo(copy.folder);
    expect(failed(results)).toEqual(['no uncaught error while the page loads']);
  }, 30_000);

  it('is red on a "fix" that deletes the request', async () => {
    const copy = fresh();
    fixSummary(copy);
    copy.edit('shop/app.js', "window.addEventListener('load', placeOrder);", '');
    const { ok, results } = await verifyDemo(copy.folder);
    expect(ok).toBe(false);
    expect(failed(results)).toContain('the order request succeeds with the right total');
  }, 30_000);

  it('is red on a "fix" that hard-codes a success with the wrong total', async () => {
    const copy = fresh();
    fixSummary(copy);
    copy.edit('shop/orders.mjs', 'return { status: 201, body: { id: 1046, total: orderTotal(order) } };', "return { status: 201, body: { id: 1046, total: '0.00' } };");
    const { ok, results } = await verifyDemo(copy.folder);
    expect(ok).toBe(false);
    expect(failed(results)).toEqual(['the order request succeeds with the right total']);
  }, 30_000);

  it('is red on a "fix" that swallows the TypeError and so loses the discount label', async () => {
    const copy = fresh();
    fixOrderService(copy);
    copy.edit('shop/app.js', 'const codes = items.map((item) => item.discounts.map((discount) => discount.code));', 'let codes = [];\n  try { codes = items.map((item) => item.discounts.map((discount) => discount.code)); } catch {}');
    const { ok, results } = await verifyDemo(copy.folder);
    expect(ok).toBe(false);
    expect(failed(results)).toEqual(['the cart still shows three items and the discount label']);
  }, 30_000);

  it('is green when the missing field is handled so the label stays right', async () => {
    const copy = fresh();
    fixOrderService(copy);
    copy.edit('shop/app.js', 'item.discounts.map', '(item.discounts || []).map');
    expect((await verifyDemo(copy.folder)).ok).toBe(true);
  }, 30_000);

  it('is red when the page leaves a rejected promise behind', async () => {
    const copy = fresh();
    applyReferenceFix(copy);
    copy.edit('shop/app.js', 'async function placeOrder() {', "async function placeOrder() {\n  throw new Error('boom');");
    const { ok, results } = await verifyDemo(copy.folder);
    expect(ok).toBe(false);
    expect(failed(results)).toContain('no uncaught error while the page loads');
  }, 30_000);

  it('reports a missing file instead of crashing', async () => {
    const copy = fresh();
    rmSync(`${copy.folder}/shop/orders.mjs`);
    const { ok, results } = await verifyDemo(copy.folder);
    expect(ok).toBe(false);
    expect(results[0]).toMatchObject({ name: 'the demo files exist', ok: false });
  }, 30_000);

  it('can run twice in a row, so nothing is left open', async () => {
    const copy = fresh();
    applyReferenceFix(copy);
    expect((await verifyDemo(copy.folder)).ok).toBe(true);
    expect((await verifyDemo(copy.folder)).ok).toBe(true);
  }, 60_000);
});
