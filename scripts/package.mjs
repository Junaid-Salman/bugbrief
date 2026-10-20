// Builds the Chrome Web Store upload: bugbrief-<version>.zip from the contents of dist/.
// Usage: npm run package   (run `npm run build` first)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Every file under dir, as sorted paths relative to it. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Problems that would make the store reject or the extension misbehave. Empty means fine. */
export function checkPackage(files, manifest, readText) {
  const problems = [];
  if (!files.includes('manifest.json')) problems.push('manifest.json is missing at the top of the zip.');
  if (files.some((file) => file.endsWith('.map'))) problems.push('Source maps are in the package.');
  if (files.some((file) => /^(\.|__MACOSX|node_modules)/.test(file))) problems.push('Hidden or tool files are in the package.');
  for (const icon of Object.values(manifest.icons ?? {})) if (!files.includes(icon)) problems.push(`Icon ${icon} is missing.`);
  for (const file of files.filter((name) => /\.(js|mjs|html)$/.test(name))) {
    const text = readText(file);
    if (/\b(?:src|href)\s*=\s*["']https?:\/\//i.test(text) || /\bimport\s*\(?\s*["']https?:\/\//.test(text) || /importScripts\(\s*["']https?:/.test(text)) {
      problems.push(`${file} loads code from a remote address.`);
    }
  }
  if (manifest.content_security_policy) problems.push('A custom content_security_policy is set; review it for remote code.');
  return problems;
}

export function run() {
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ not found. Run `npm run build` first.');
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw new Error(`Version mismatch: manifest ${manifest.version}, package.json ${pkg.version}.`);
  const files = listFiles(dist);
  const problems = checkPackage(files, manifest, (file) => readFileSync(join(dist, file), 'utf8'));
  if (problems.length) throw new Error(`Package is not ready:\n- ${problems.join('\n- ')}`);
  const target = join(root, `bugbrief-${manifest.version}.zip`);
  rmSync(target, { force: true });
  try {
    execFileSync('zip', ['-rX', target, '.'], { cwd: dist, stdio: 'ignore' });
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('The `zip` command was not found. Install zip, or zip the contents of dist/ yourself.');
    throw error;
  }
  console.log(`${target} (${(statSync(target).size / 1024).toFixed(0)} KB, ${files.length} files)`);
}

/** `npm run store:check`: the images the dashboard needs are present. */
export function storeCheck() {
  const missing = [];
  if (!existsSync(join(root, 'store/assets/promo-small.png'))) missing.push('store/assets/promo-small.png');
  const shots = existsSync(join(root, 'store/assets')) ? readdirSync(join(root, 'store/assets')).filter((n) => /^shot-\d\.png$/.test(n)) : [];
  if (!shots.length) missing.push('at least one store/assets/shot-N.png (1280x800)');
  if (missing.length) throw new Error(`Store assets missing:\n- ${missing.join('\n- ')}`);
  console.log(`Store assets ok: promo tile and ${shots.length} screenshot(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'check') storeCheck();
    else run();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
