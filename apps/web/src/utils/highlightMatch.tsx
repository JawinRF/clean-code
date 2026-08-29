import * as React from 'react';

/**
 * Inverse-highlight every occurrence of `query` in `text` (case-insensitive).
 * Ported from References/claude-code/src/utils/highlightMatch.tsx
 * Adapted for web: uses <mark> with clean-code styling instead of Ink inverse.
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let offset = 0;
  let idx = textLower.indexOf(queryLower, offset);
  if (idx === -1) return text;
  let key = 0;
  while (idx !== -1) {
    if (idx > offset) parts.push(text.slice(offset, idx));
    parts.push(
      <mark key={key++} className="search-highlight">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    offset = idx + query.length;
    idx = textLower.indexOf(queryLower, offset);
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return <>{parts}</>;
}
