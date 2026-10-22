import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

/**
 * CRXJS lists every dynamic script (the picker) under web_accessible_resources for all http and
 * https pages. `executeScript({ files })` does not need that entry, and it would let any website
 * fetch the file and detect that Conscribe is installed, so the production build drops it.
 * `renderCrxManifest` is CRXJS's own manifest hook.
 */
function dropWebAccessibleResources(): Plugin {
  return {
    name: 'conscribe:drop-web-accessible-resources',
    apply: 'build',
    enforce: 'post',
    // @ts-expect-error renderCrxManifest is a CRXJS hook, not part of Vite's Plugin type
    renderCrxManifest(crxManifest: { web_accessible_resources?: unknown }) {
      delete crxManifest.web_accessible_resources;
      return crxManifest;
    },
  };
}

export default defineConfig({
  plugins: [preact(), crx({ manifest }), dropWebAccessibleResources()],
});
