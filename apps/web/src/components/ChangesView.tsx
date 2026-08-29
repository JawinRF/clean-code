import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  getApiJson,
  postApiJson,
  type GitChangedFileResponse,
  type GitChangesResponse,
  type GitDiffLineResponse,
  type WorkspaceResponse,
} from '../api';
import { ShikiCode } from './SyntaxCode';
import './ChangesView.css';


type WorkspaceTab = 'changes' | 'browser';
type CommitMode = 'branch' | 'current';

type ChangesIconName =
  | 'branch'
  | 'changes'
  | 'check'
  | 'chevron-down'
  | 'chevron-up'
  | 'close'
  | 'collapse'
  | 'expand'
  | 'file'
  | 'globe'
  | 'layout'
  | 'more'
  | 'plus'
  | 'refresh'
  | 'revert';

type VisibleDiffRow =
  | { kind: 'line'; line: GitDiffLineResponse; key: string }
  | { kind: 'collapse'; count: number; key: string };

const CONTEXT_EDGE_LINES = 3;


function ChangesIcon({ name, size = 16 }: { name: ChangesIconName; size?: number }) {
  const paths: Record<ChangesIconName, ReactNode> = {
    branch: <path d="M6 4v10a4 4 0 0 0 4 4h4M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-10V5m0 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
    changes: <><path d="M8 4h8M8 20h8M6 8v8M18 8v8" /><rect x="3" y="8" width="6" height="8" rx="1" /><path d="M5.5 11h1M5.5 13h1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    'chevron-down': <path d="m7 10 5 5 5-5" />,
    'chevron-up': <path d="m7 14 5-5 5 5" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    collapse: <path d="M8 3 3 8m0-5v5h5m8 13 5-5m0 5v-5h-5" />,
    expand: <path d="m14 4 6 0 0 6m0-6-7 7M10 20H4v-6m0 6 7-7" />,
    file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    layout: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M16 5v14" /></>,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.7-1.9L20 8M4 16l2.2 1.9A7 7 0 0 0 17.9 16" />,
    revert: <path d="M9 8H4V3M4 8l3.1-3.1A8 8 0 1 1 5 16" />,
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}


export function WorkspaceTabs({
  activeTab,
  onSelectTab,
  onNewConversation,
  onOpenSidebar,
}: {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onNewConversation: () => void;
  onOpenSidebar: () => void;
}) {
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  async function toggleFullscreen() {
    if (document.fullscreenElement !== null) {
      await document.exitFullscreen();
      return;
    }

    await document.documentElement.requestFullscreen();
  }

  return (
    <nav className="workspace-tabs" aria-label="Workspace views">
      <div className="workspace-tab-list">
        <button
          type="button"
          className="workspace-tab"
          data-active={activeTab === 'changes' || undefined}
          onClick={() => onSelectTab('changes')}
        >
          <ChangesIcon name="changes" size={18} />
          Changes
        </button>
        <button
          type="button"
          className="workspace-tab"
          data-active={activeTab === 'browser' || undefined}
          onClick={() => onSelectTab('browser')}
        >
          <ChangesIcon name="globe" size={18} />
          Browser
        </button>
        <button
          type="button"
          className="workspace-tab-icon"
          aria-label="New conversation"
          title="New conversation"
          onClick={onNewConversation}
        >
          <ChangesIcon name="plus" size={19} />
        </button>
      </div>
      <div className="workspace-tab-controls">
        <button
          type="button"
          aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
          title={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
          onClick={() => void toggleFullscreen()}
        >
          <ChangesIcon name={isFullscreen ? 'collapse' : 'expand'} size={18} />
        </button>
        <button type="button" aria-label="Open project sidebar" title="Project sidebar" onClick={onOpenSidebar}>
          <ChangesIcon name="layout" size={19} />
        </button>
      </div>
    </nav>
  );
}


function requestError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The request timed out.';
  }

  return error instanceof Error ? error.message : 'The request failed.';
}


function fileSymbol(file: GitChangedFileResponse): { text: string; tone: string } {
  if (file.language === 'json') return { text: '{}', tone: 'json' };
  if (file.language === 'css') return { text: '#', tone: 'css' };
  if (file.language === 'typescript' || file.language === 'javascript') {
    return { text: 'TS', tone: 'typescript' };
  }
  if (file.language === 'python') return { text: 'Py', tone: 'python' };
  return { text: '·', tone: 'file' };
}


function lineNumber(line: GitDiffLineResponse): number | null {
  return line.type === 'deletion' ? line.old_line_number : line.new_line_number;
}


function visibleDiffRows(
  file: GitChangedFileResponse,
  expandedContexts: ReadonlySet<string>,
): VisibleDiffRow[] {
  const rows: VisibleDiffRow[] = [];
  let index = 0;

  while (index < file.lines.length) {
    const line = file.lines[index];

    if (line.type !== 'context') {
      rows.push({ kind: 'line', line, key: `${file.path}:line:${index}` });
      index += 1;
      continue;
    }

    const start = index;
    while (index < file.lines.length && file.lines[index].type === 'context') {
      index += 1;
    }
    const end = index;
    const run = file.lines.slice(start, end);
    const collapseKey = `${file.path}:context:${start}:${end}`;
    const isFirstRun = start === 0;
    const isLastRun = end === file.lines.length;
    const keepBefore = isFirstRun ? 0 : CONTEXT_EDGE_LINES;
    const keepAfter = isLastRun ? 0 : CONTEXT_EDGE_LINES;
    const hiddenCount = run.length - keepBefore - keepAfter;

    if (hiddenCount < 2 || expandedContexts.has(collapseKey)) {
      run.forEach((contextLine, offset) => {
        rows.push({
          kind: 'line',
          line: contextLine,
          key: `${file.path}:line:${start + offset}`,
        });
      });
      continue;
    }

    run.slice(0, keepBefore).forEach((contextLine, offset) => {
      rows.push({
        kind: 'line',
        line: contextLine,
        key: `${file.path}:line:${start + offset}`,
      });
    });
    rows.push({ kind: 'collapse', count: hiddenCount, key: collapseKey });
    run.slice(run.length - keepAfter).forEach((contextLine, offset) => {
      rows.push({
        kind: 'line',
        line: contextLine,
        key: `${file.path}:line:${end - keepAfter + offset}`,
      });
    });
  }

  return rows;
}


function DiffContextCollapse({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      className="diff-context-collapse"
      onClick={onExpand}
      aria-label={`Expand ${count} unmodified lines`}
    >
      <span className="diff-context-chevrons">
        <ChangesIcon name="chevron-down" size={14} />
        <ChangesIcon name="chevron-up" size={14} />
      </span>
      <span>{count} unmodified line{count === 1 ? '' : 's'}</span>
    </button>
  );
}


function DiffLine({
  line,
  language,
  onLineAction,
}: {
  line: GitDiffLineResponse;
  language: string;
  onLineAction: () => void;
}) {
  return (
    <div className="diff-line" data-type={line.type}>
      <span className="diff-gutter">
        <span className="diff-line-number">{lineNumber(line)}</span>
        <button
          type="button"
          className="diff-line-action"
          aria-label={`Add action at line ${lineNumber(line) ?? ''}`}
          title="Add line action"
          onClick={onLineAction}
        >
          <ChangesIcon name="plus" size={15} />
        </button>
      </span>
      <span className="diff-code">
        <ShikiCode code={line.content.length === 0 ? ' ' : line.content} lang={language} />
      </span>
    </div>
  );
}


function ChangedFile({
  file,
  selected,
  expandedContexts,
  confirmingRevert,
  busyPath,
  onToggleSelected,
  onExpandContext,
  onRequestRevert,
  onLineAction,
}: {
  file: GitChangedFileResponse;
  selected: boolean;
  expandedContexts: ReadonlySet<string>;
  confirmingRevert: boolean;
  busyPath: string | null;
  onToggleSelected: () => void;
  onExpandContext: (key: string) => void;
  onRequestRevert: () => void;
  onLineAction: (line: GitDiffLineResponse) => void;
}) {
  const symbol = fileSymbol(file);
  const rows = useMemo(
    () => visibleDiffRows(file, expandedContexts),
    [expandedContexts, file],
  );

  return (
    <section className="changed-file" aria-labelledby={`file-${file.path}`}>
      <header className="changed-file-header">
        <span className="changed-file-symbol" data-tone={symbol.tone}>{symbol.text}</span>
        <strong id={`file-${file.path}`} title={file.path}>{file.path}</strong>
        {file.additions > 0 && <span className="git-additions">+{file.additions}</span>}
        {file.deletions > 0 && <span className="git-deletions">-{file.deletions}</span>}
        <span className="changed-file-actions">
          <button
            type="button"
            className="changed-file-revert"
            data-confirm={confirmingRevert || undefined}
            aria-label={confirmingRevert ? `Confirm revert ${file.path}` : `Revert ${file.path}`}
            title={confirmingRevert ? 'Click again to confirm revert' : 'Revert file'}
            onClick={onRequestRevert}
            disabled={busyPath !== null}
          >
            {busyPath === file.path
              ? <span className="changes-spinner" />
              : confirmingRevert
                ? <ChangesIcon name="check" size={17} />
                : <ChangesIcon name="revert" size={19} />}
          </button>
          <label className="changed-file-checkbox" title={selected ? 'Exclude file' : 'Include file'}>
            <input
              type="checkbox"
              checked={selected}
              aria-label={`${selected ? 'Exclude' : 'Include'} ${file.path} ${selected ? 'from' : 'in'} commit`}
              onChange={onToggleSelected}
            />
            <span>{selected && <ChangesIcon name="check" size={14} />}</span>
          </label>
        </span>
      </header>
      <div className="diff-viewer">
        {file.is_binary ? (
          <p className="diff-file-message">Binary file changed</p>
        ) : file.lines.length === 0 ? (
          <p className="diff-file-message">Diff is not available for this file.</p>
        ) : rows.map((row) => (
          row.kind === 'collapse' ? (
            <DiffContextCollapse
              key={row.key}
              count={row.count}
              onExpand={() => onExpandContext(row.key)}
            />
          ) : (
            <DiffLine
              key={row.key}
              line={row.line}
              language={file.language}
              onLineAction={() => onLineAction(row.line)}
            />
          )
        ))}
      </div>
    </section>
  );
}


function CommitPanel({
  mode,
  branch,
  selectedCount,
  isSubmitting,
  error,
  onModeChange,
  onClose,
  onSubmit,
}: {
  mode: CommitMode;
  branch: string;
  selectedCount: number;
  isSubmitting: boolean;
  error: string | null;
  onModeChange: (mode: CommitMode) => void;
  onClose: () => void;
  onSubmit: (message: string, branchName: string | null) => void;
}) {
  const [message, setMessage] = useState('');
  const [branchName, setBranchName] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(message.trim(), mode === 'branch' ? branchName.trim() : null);
  }

  return (
    <form className="commit-panel" onSubmit={submit}>
      <header>
        <div>
          <strong>{mode === 'branch' ? 'Create branch and commit' : `Commit to ${branch}`}</strong>
          <small>{selectedCount} selected file{selectedCount === 1 ? '' : 's'}</small>
        </div>
        <button type="button" aria-label="Close commit panel" onClick={onClose}>
          <ChangesIcon name="close" size={16} />
        </button>
      </header>
      <div className="commit-mode-switch" role="group" aria-label="Commit mode">
        <button type="button" data-active={mode === 'branch' || undefined} onClick={() => onModeChange('branch')}>
          New branch
        </button>
        <button type="button" data-active={mode === 'current' || undefined} onClick={() => onModeChange('current')}>
          Current branch
        </button>
      </div>
      {mode === 'branch' && (
        <label>
          <span>Branch name</span>
          <input
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            placeholder="feature/changes"
            disabled={isSubmitting}
            autoFocus
            required
          />
        </label>
      )}
      <label>
        <span>Commit message</span>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Describe these changes"
          maxLength={200}
          disabled={isSubmitting}
          autoFocus={mode === 'current'}
          required
        />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <button
        type="submit"
        className="commit-panel-submit"
        disabled={isSubmitting || selectedCount === 0}
      >
        {isSubmitting ? 'Committing...' : mode === 'branch' ? 'Create Branch & Commit' : 'Commit Changes'}
      </button>
    </form>
  );
}


export function ChangesView({ workspace }: { workspace: WorkspaceResponse | null }) {
  const [changes, setChanges] = useState<GitChangesResponse | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('Select a workspace to inspect Git changes.');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [confirmingRevert, setConfirmingRevert] = useState<string | null>(null);
  const [isCommitOpen, setIsCommitOpen] = useState(false);
  const [commitMode, setCommitMode] = useState<CommitMode>('branch');
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const loadChanges = useCallback(async () => {
    if (workspace === null) {
      setChanges(null);
      setSelectedPaths(new Set());
      setStatus('Select a workspace to inspect Git changes.');
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    setIsLoading(true);
    setError(null);
    setStatus('Loading changes...');

    try {
      const response = await getApiJson<GitChangesResponse>(
        `/api/v1/workspaces/${workspace.id}/git/changes`,
        controller.signal,
      );
      setChanges(response);
      setSelectedPaths((currentPaths) => new Set(
        [...currentPaths].filter((path) => response.files.some((file) => file.path === path)),
      ));
      setExpandedContexts(new Set());
      setStatus(
        response.files.length === 0
          ? 'Working tree clean'
          : `${response.files.length} changed file${response.files.length === 1 ? '' : 's'}`,
      );
    } catch (loadError) {
      setChanges(null);
      setError(requestError(loadError));
      setStatus('Changes unavailable');
    } finally {
      window.clearTimeout(timeoutId);
      setIsLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void loadChanges();
  }, [loadChanges]);

  async function revertFile(path: string) {
    if (workspace === null || busyPath !== null) return;

    if (confirmingRevert !== path) {
      setConfirmingRevert(path);
      setStatus(`Click revert again to discard changes in ${path}.`);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    setBusyPath(path);
    setConfirmingRevert(null);
    setError(null);

    try {
      const response = await postApiJson<GitChangesResponse>(
        `/api/v1/workspaces/${workspace.id}/git/revert`,
        { path },
        controller.signal,
      );
      setChanges(response);
      setSelectedPaths((currentPaths) => {
        const nextPaths = new Set(currentPaths);
        nextPaths.delete(path);
        return nextPaths;
      });
      setStatus(`Reverted ${path}`);
    } catch (revertError) {
      setError(requestError(revertError));
      setStatus('Revert failed');
    } finally {
      window.clearTimeout(timeoutId);
      setBusyPath(null);
    }
  }

  async function commitFiles(message: string, branchName: string | null) {
    if (workspace === null || selectedPaths.size === 0 || isCommitting) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    setIsCommitting(true);
    setCommitError(null);

    try {
      const response = await postApiJson<GitChangesResponse>(
        `/api/v1/workspaces/${workspace.id}/git/commit`,
        { paths: [...selectedPaths], message, branch_name: branchName },
        controller.signal,
      );
      setChanges(response);
      setSelectedPaths(new Set());
      setIsCommitOpen(false);
      setStatus(`Committed changes on ${response.branch}`);
    } catch (commitFailure) {
      setCommitError(requestError(commitFailure));
    } finally {
      window.clearTimeout(timeoutId);
      setIsCommitting(false);
    }
  }

  const files = changes?.files ?? [];

  return (
    <section className="changes-view" aria-label="Git changes">
      <header className="changes-toolbar">
        <div className="changes-summary">
          <ChangesIcon name="changes" size={19} />
          <strong>Uncommitted</strong>
          {changes !== null && (
            <span className="changes-totals">
              <span className="git-additions">+{changes.additions}</span>
              <span className="git-deletions">-{changes.deletions}</span>
            </span>
          )}
          <ChangesIcon name="chevron-down" size={14} />
          <span className="changes-branch">
            {changes?.branch ?? 'No branch'}
            <ChangesIcon name="chevron-down" size={13} />
          </span>
        </div>
        <div className="changes-toolbar-actions">
          <button
            type="button"
            className="changes-overflow"
            aria-label="Refresh changes"
            title="Refresh changes"
            onClick={() => void loadChanges()}
            disabled={isLoading}
          >
            {isLoading ? <span className="changes-spinner" /> : <ChangesIcon name="more" size={18} />}
          </button>
          <div className="commit-action-wrap">
            <div className="commit-action">
              <button
                type="button"
                className="commit-action-main"
                onClick={() => {
                  setCommitMode('branch');
                  setCommitError(null);
                  setIsCommitOpen(true);
                }}
              >
                Create Branch &amp; Commit
              </button>
              <button
                type="button"
                className="commit-action-menu"
                aria-label="Open commit options"
                onClick={() => {
                  setCommitError(null);
                  setIsCommitOpen((isOpen) => !isOpen);
                }}
              >
                <ChangesIcon name="chevron-down" size={15} />
              </button>
            </div>
            {isCommitOpen && (
              <CommitPanel
                mode={commitMode}
                branch={changes?.branch ?? 'current branch'}
                selectedCount={selectedPaths.size}
                isSubmitting={isCommitting}
                error={commitError}
                onModeChange={setCommitMode}
                onClose={() => setIsCommitOpen(false)}
                onSubmit={(message, branchName) => void commitFiles(message, branchName)}
              />
            )}
          </div>
          <button type="button" className="changes-side-control" aria-label="Changes panel layout" title="Changes panel layout">
            <ChangesIcon name="layout" size={18} />
          </button>
        </div>
      </header>

      <div className="changes-scrollport">
        {workspace === null ? (
          <div className="changes-state">
            <ChangesIcon name="branch" size={22} />
            <strong>Select a workspace</strong>
            <span>Git changes belong to an active workspace root.</span>
          </div>
        ) : error !== null ? (
          <div className="changes-state changes-state--error">
            <ChangesIcon name="file" size={22} />
            <strong>Changes unavailable</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void loadChanges()}>Try again</button>
          </div>
        ) : isLoading && changes === null ? (
          <div className="changes-state">
            <span className="changes-spinner" />
            <strong>Loading changes</strong>
          </div>
        ) : files.length === 0 ? (
          <div className="changes-state">
            <ChangesIcon name="check" size={22} />
            <strong>Working tree clean</strong>
            <span>No uncommitted files in {workspace.name}.</span>
          </div>
        ) : files.map((file) => (
          <ChangedFile
            key={file.path}
            file={file}
            selected={selectedPaths.has(file.path)}
            expandedContexts={expandedContexts}
            confirmingRevert={confirmingRevert === file.path}
            busyPath={busyPath}
            onToggleSelected={() => {
              setConfirmingRevert(null);
              setSelectedPaths((currentPaths) => {
                const nextPaths = new Set(currentPaths);
                if (nextPaths.has(file.path)) nextPaths.delete(file.path);
                else nextPaths.add(file.path);
                return nextPaths;
              });
            }}
            onExpandContext={(key) => setExpandedContexts((currentContexts) => {
              const nextContexts = new Set(currentContexts);
              nextContexts.add(key);
              return nextContexts;
            })}
            onRequestRevert={() => void revertFile(file.path)}
            onLineAction={(line) => setStatus(`Line action ready at ${file.path}:${lineNumber(line) ?? ''}`)}
          />
        ))}
      </div>
      <footer className="changes-status" data-error={error !== null || undefined}>
        <span>{status}</span>
        <span>{selectedPaths.size} selected</span>
      </footer>
    </section>
  );
}
