import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageResponse } from '../api';
import { countMatches, messageSearchText } from '../utils/transcriptSearch';

type Props = {
  messages: MessageResponse[];
  isOpen: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  onNavigate: (messageId: string | null, matchIndex: number) => void;
};

function getMatchPositions(text: string, query: string): number[] {
  if (!query) return [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const positions: number[] = [];
  let pos = lower.indexOf(q);
  while (pos !== -1) {
    positions.push(pos);
    pos = lower.indexOf(q, pos + q.length);
  }
  return positions;
}

export function ConversationSearchBar({ messages, isOpen, query, onQueryChange, onClose, onNavigate }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matchInfo = useMemo(() => {
    if (!query.trim()) return { total: 0, perMessage: [] as Array<{ id: string; count: number }> };
    const q = query.trim();
    let total = 0;
    const perMessage: Array<{ id: string; count: number }> = [];
    for (const msg of messages) {
      const text = messageSearchText(msg);
      const c = countMatches(text, q);
      if (c > 0) {
        perMessage.push({ id: msg.id, count: c });
        total += c;
      }
    }
    return { total, perMessage };
  }, [messages, query]);

  const flatMatches = useMemo(() => {
    if (!query.trim()) return [] as Array<{ messageId: string; matchIndex: number }>;
    const q = query.trim();
    const out: Array<{ messageId: string; matchIndex: number }> = [];
    for (const msg of messages) {
      const text = messageSearchText(msg);
      const positions = getMatchPositions(text, q);
      for (let i = 0; i < positions.length; i += 1) {
        out.push({ messageId: msg.id, matchIndex: i });
      }
    }
    return out;
  }, [messages, query]);

  useEffect(() => {
    if (!isOpen) {
      setActiveIndex(0);
      onNavigate(null, 0);
      return;
    }
    window.setTimeout(() => inputRef.current?.focus(), 10);
  }, [isOpen, onNavigate]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (flatMatches.length === 0) {
      onNavigate(null, 0);
      setActiveIndex(0);
      return;
    }
    const clamped = Math.min(activeIndex, flatMatches.length - 1);
    if (clamped !== activeIndex) setActiveIndex(clamped);
    const current = flatMatches[clamped];
    if (current) onNavigate(current.messageId, current.matchIndex);
  }, [flatMatches, activeIndex, onNavigate]);

  const goNext = () => {
    if (flatMatches.length === 0) return;
    setActiveIndex((i) => (i + 1) % flatMatches.length);
  };
  const goPrev = () => {
    if (flatMatches.length === 0) return;
    setActiveIndex((i) => (i - 1 + flatMatches.length) % flatMatches.length);
  };

  if (!isOpen) return null;

  return (
    <div className="conversation-search-bar" role="search" aria-label="Search conversation">
      <div className="conversation-search-field">
        <span className="conversation-search-icon">⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            }
          }}
          placeholder="Search conversation…"
          aria-label="Search conversation"
        />
        {query && (
          <button type="button" className="conversation-search-clear" onClick={() => onQueryChange('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>
      <span className="conversation-search-count">
        {query.trim() ? `${matchInfo.total ? `${activeIndex + 1} / ${matchInfo.total}` : 'No matches'}` : `${messages.length} messages`}
      </span>
      <div className="conversation-search-actions">
        <button type="button" onClick={goPrev} disabled={flatMatches.length === 0} aria-label="Previous match">
          ↑
        </button>
        <button type="button" onClick={goNext} disabled={flatMatches.length === 0} aria-label="Next match">
          ↓
        </button>
        <button type="button" onClick={onClose} aria-label="Close search">
          ✕
        </button>
      </div>
    </div>
  );
}
