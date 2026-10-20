/**
 * The fake secrets planted in the demo shop (demo/shop/). The agent test and the manual leak check use this list:
 * none of these values may appear in a capsule. They are obviously fake and use no vendor key format.
 */
export const DEMO_SECRETS = {
  urlToken: 'demo-session-3b7f1c9e2a',
  bearer: 'demo-bearer-5d2e8f0a1b',
  email: 'jane.doe@example.com',
  emailLocal: 'jane.doe',
  csrf: 'demo-csrf-77c0a41e',
} as const;
