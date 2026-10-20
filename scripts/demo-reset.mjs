// Puts demo/shop/ back to the broken state in git, so the agent test can be run again.
// It only ever touches demo/shop/. Nothing else in the repository is checked out or cleaned.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = 'demo/shop/';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const changed = git('status', '--porcelain', '--', target).trim();
if (!changed) {
  console.log(`${target} already matches git. Nothing to reset.`);
} else {
  console.log(`Resetting ${target}:\n${changed}`);
  git('checkout', 'HEAD', '--', target);
  git('clean', '-fd', '--', target);
  console.log('Done.');
}
