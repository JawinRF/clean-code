import { useEffect, useRef, useState } from 'react';
import { highlightMatch } from '../utils/highlightMatch';

type SearchMatch = {
  file: string;
  line: number;
  text: string;
};

type Preview = {
  file: string;
  line: number;
  content: string;
  totalLines: number;
} | null;

type Props = {
  workspaceId: string | null;
  workspaceName: string | null;
  onClose: () => void;
};

const DEBOUNCE_MS = 100;
const MAX_MATCHES_PER_FILE = 10; // mirrored from backend default, for display hint
const MAX_TOTAL_MATCHES = 500;
const PREVIEW_CONTEXT_LINES = 4;

function truncateMiddle(path: string, max: number): string {
  if (path.length <= max) return path;
  const half = Math.floor((max - 1) / 2);
  return `${path.slice(0, half)}…${path.slice(path.length - (max - half - 1))}`;
}

export function GlobalSearchDialog({ workspaceId, workspaceName, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [preview, setPreview] = useState<Preview>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [onClose]);

  // Debounced search – mirrors GlobalSearchDialog.handleQueryChange
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();

    if (!query.trim() || !workspaceId) {
      setMatches([]);
      setTruncated(false);
      setIsSearching(false);
      return;
    }

    // Optimistic filter existing matches like Claude Code does before rio
    const qLower = query.toLowerCase();
    setMatches((prev) => {
      const filtered = prev.filter((m) => m.text.toLowerCase().includes(qLower));
      return filtered.length === prev.length ? prev : filtered;
    });

    setIsSearching(true);
    setTruncated(false);

    const controller = new AbortController();
    abortRef.current = controller;

    debounceRef.current = window.setTimeout(async () => {
      try {
        const url = `/api/v1/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}&case_insensitive=true&regex=false&limit=${MAX_TOTAL_MATCHES}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { matches: SearchMatch[]; truncated: boolean };
        if (controller.signal.aborted) return;
        setMatches(data.matches);
        setTruncated(Boolean(data.truncated));
        setFocusedIndex(0);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        // Keep previous matches on error; show no new results
        setMatches([]);
        setTruncated(false);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, workspaceId]);

  // Preview fetch – mirrors GlobalSearchDialog useEffect on focused
  const focused = matches[focusedIndex] ?? null;
  useEffect(() => {
    if (!focused || !workspaceId) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    const start = Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1);
    const count = PREVIEW_CONTEXT_LINES * 2 + 1;
    const url = `/api/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(focused.file)}&start_line=${start}&line_count=${count}`;
    fetch(url, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<{ content: string; total_lines: number }>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setPreview({ file: focused.file, line: focused.line, content: data.content, totalLines: data.total_lines });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreview({ file: focused.file, line: focused.line, content: '(preview unavailable)', totalLines: 0 });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [focused, workspaceId]);

  // Keyboard navigation for list
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' && focused) {
        e.preventDefault();
        void navigator.clipboard.writeText(`${focused.file}:${focused.line}`);
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [matches.length, focused, onClose]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${focusedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const matchLabel = matches.length > 0 ? `${matches.length}${truncated ? '+' : ''} matches${isSearching ? '…' : ''}` : ' ';

  return (
    <div className="search-dialog-backdrop" role="dialog" aria-modal="true" aria-label="Global Search" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-dialog">
        <div className="search-dialog-header">
          <strong>Global Search</strong>
          <small>{workspaceName ? `${workspaceName} · ${matchLabel}` : 'Select a workspace'}</small>
          <button type="button" className="search-dialog-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="search-dialog-input-wrap">
          <span className="search-dialog-prefix">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={workspaceId ? 'Type to search… (ripgrep -F -i, max 10 per file, 500 total)' : 'Select a workspace to search'}
            disabled={!workspaceId}
            aria-label="Search query"
          />
          {isSearching && <span className="search-dialog-spinner" aria-label="Searching" />}
        </div>

        <div className="search-dialog-body">
          <div className="search-dialog-list" ref={listRef} role="listbox" aria-label="Search results">
            {!workspaceId ? (
              <div className="search-dialog-empty">Select a workspace to start searching.</div>
            ) : !query.trim() ? (
              <div className="search-dialog-empty">Type to search… Uses fixed-string, case-insensitive search like `rg -F -i`. {`Max ${MAX_MATCHES_PER_FILE} per file, ${MAX_TOTAL_MATCHES} total.`}</div>
            ) : matches.length === 0 ? (
              <div className="search-dialog-empty">{isSearching ? 'Searching…' : 'No matches'}</div>
            ) : (
              matches.map((m, idx) => {
                const isFocused = idx === focusedIndex;
                return (
                  <button
                    key={`${m.file}:${m.line}:${idx}`}
                    data-index={idx}
                    type="button"
                    role="option"
                    aria-selected={isFocused}
                    className="search-result-row"
                    data-focused={isFocused || undefined}
                    onMouseEnter={() => setFocusedIndex(idx)}
                    onClick={() => {
                      void navigator.clipboard.writeText(`${m.file}:${m.line}`);
                      onClose();
                    }}
                    title={`${m.file}:${m.line}`}
                  >
                    <span className="search-result-path">{truncateMiddle(m.file, 42)}:{m.line}</span>
                    <span className="search-result-text">{highlightMatch(m.text.trimStart(), query)}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="search-dialog-preview" aria-label="Preview">
            {!focused ? (
              <div className="search-preview-empty">No selection</div>
            ) : previewLoading ? (
              <div className="search-preview-loading">Loading…</div>
            ) : preview && preview.file === focused.file && preview.line === focused.line ? (
              <>
                <div className="search-preview-header">{truncateMiddle(preview.file, 64)}:{focused.line}</div>
                <pre className="search-preview-content">
                  {preview.content.split('\n').map((line, i) => (
                    <div key={i} className="search-preview-line" data-active={preview && (Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1) + i + 1) === focused.line || undefined}>
                      <span className="search-preview-lineno">{Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1) + i + 1}</span>
                      <span className="search-preview-text">{highlightMatch(line, query)}</span>
                    </div>
                  ))}
                </pre>
              </>
            ) : (
              <div className="search-preview-loading">Loading…</div>
            )}
          </div>
        </div>

        <div className="search-dialog-footer">
          <span>{workspaceId ? '↵ copy path  ↑↓ navigate  Esc close' : ' '}</span>
          <span className="search-dialog-hint">ripgrep-inspired · excludes .git · 500-col truncate · binary skip</span>
        </div>
      </div>
    </div>
  );
}
