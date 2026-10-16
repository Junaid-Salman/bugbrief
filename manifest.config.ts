import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'BugBrief',
  version: '0.1.0',
  description:
    'Package console errors, failed requests, the broken element and a screenshot into one agent-ready Markdown report.',
  minimum_chrome_version: '118',
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  permissions: ['debugger', 'activeTab', 'scripting', 'storage', 'downloads'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  action: { default_popup: 'src/popup/index.html', default_title: 'BugBrief' },
});
