import type { MessageResponse } from '../api';

const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/**
 * Flatten a MessageResponse to lowercased searchable text.
 * Inspired by References/claude-code/src/utils/transcriptSearch.ts
 * Simplified for Clean Code's message shape (role + content.parts).
 * Cached via WeakMap – messages are append-only and immutable.
 */
const searchTextCache = new WeakMap<MessageResponse, string>();

export function messageSearchText(msg: MessageResponse): string {
  const cached = searchTextCache.get(msg);
  if (cached !== undefined) return cached;
  const result = computeSearchText(msg).toLowerCase();
  searchTextCache.set(msg, result);
  return result;
}

function computeSearchText(msg: MessageResponse): string {
  const parts = msg.content.parts ?? [];
  let raw = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  // Strip <system-reminder> like claude-code does – not user-visible
  let t = raw;
  let open = t.indexOf('<system-reminder>');
  while (open >= 0) {
    const close = t.indexOf(SYSTEM_REMINDER_CLOSE, open);
    if (close < 0) break;
    t = t.slice(0, open) + t.slice(close + SYSTEM_REMINDER_CLOSE.length);
    open = t.indexOf('<system-reminder>');
  }
  return t;
}

/**
 * Count occurrences of query in text (case-insensitive) – for match badge.
 */
export function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let count = 0;
  let pos = lower.indexOf(q);
  while (pos !== -1) {
    count += 1;
    pos = lower.indexOf(q, pos + q.length);
  }
  return count;
}
