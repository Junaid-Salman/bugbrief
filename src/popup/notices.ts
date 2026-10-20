import { RESTRICTED_MESSAGE } from '../shared/restricted';

export interface Notice {
  kind: 'danger' | 'warn';
  text: string;
}

/**
 * Messages that explain why something is disabled or wrong. They show above the steps in every state, so a folded
 * step can never hide the reason a button is off.
 */
export function topNotices({ restricted }: { restricted: boolean }): Notice[] {
  return restricted ? [{ kind: 'danger', text: RESTRICTED_MESSAGE }] : [];
}
