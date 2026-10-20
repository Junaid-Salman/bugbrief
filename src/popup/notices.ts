import { COPY } from './copy';
import { RESTRICTED_MESSAGE } from '../shared/restricted';

export interface Notice {
  kind: 'danger' | 'ok';
  text: string;
}

export interface NoticeInput {
  restricted: boolean;
  /** False when the worker could not write its buffer. Undefined means not known yet. */
  persistenceOk?: boolean;
  error?: string;
  /** A success message, such as "Copied to the clipboard." */
  notice?: string;
}

/**
 * Messages that explain why something is disabled or wrong, or what just happened. They show in the sticky top in
 * every state, so a folded step or a scrolled popup can never hide them. Order: restricted page, persistence off,
 * error, success. An error wins over a success notice, because both can be set after a failed action (BL-040).
 */
export function topNotices({ restricted, persistenceOk, error, notice }: NoticeInput): Notice[] {
  const notices: Notice[] = [];
  if (restricted) notices.push({ kind: 'danger', text: RESTRICTED_MESSAGE });
  if (persistenceOk === false) notices.push({ kind: 'danger', text: COPY.persistenceOff });
  if (error) notices.push({ kind: 'danger', text: error });
  else if (notice) notices.push({ kind: 'ok', text: notice });
  return notices;
}
