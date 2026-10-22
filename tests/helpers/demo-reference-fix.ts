import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const demo = new URL('../../demo', import.meta.url).pathname;

export interface DemoCopy {
  folder: string;
  edit: (file: string, from: string, to: string) => void;
  remove: () => void;
}

/** A scratch copy of demo/ that a test can break or fix without touching the real files. */
export function copyDemo(): DemoCopy {
  const folder = mkdtempSync(join(tmpdir(), 'conscribe-demo-'));
  cpSync(demo, folder, { recursive: true });
  return {
    folder,
    edit(file, from, to) {
      const path = join(folder, file);
      const source = readFileSync(path, 'utf8');
      if (!source.includes(from)) throw new Error(`"${from}" not found in ${file}`);
      writeFileSync(path, source.replace(from, to));
    },
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
}

/** The page guards the field that only the first cart item has. */
export function fixSummary(copy: DemoCopy): void {
  copy.edit('shop/app.js', 'item.discounts.map', '(item.discounts ?? []).map');
}

/** The service computes the total from the items, which is what the page sends. */
export function fixOrderService(copy: DemoCopy): void {
  copy.edit('shop/orders.mjs', 'return order.total.toFixed(2);', 'return order.items.reduce((total, item) => total + Number(item.price) * item.qty, 0).toFixed(2);');
}

/** Both planted bugs fixed the way a developer would. */
export function applyReferenceFix(copy: DemoCopy): void {
  fixSummary(copy);
  fixOrderService(copy);
}
