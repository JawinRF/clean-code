import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getApiJson, postApiJson, type WorkspaceResponse } from '../api';
import './GitHubPanel.css';
import { GitHubRepositoryPicker } from './GitHubRepositoryPicker';

type Connection = { connected: boolean; login: string | null; message: string };
type Repository = {
  repository: string; branch: string; head: string; default_branch: string; url: string;
  pull_requests: Array<{ number: number; title: string; url: string; draft: boolean }>;
};
type Result = { message: string; url?: string; path?: string };
type Action = 'push' | 'pull-requests' | 'clone';

export function GitHubPanel({ workspace, onClose, onAddWorkspace }: {
  workspace: WorkspaceResponse;
  onClose: () => void;
  onAddWorkspace: (path: string) => void;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [repository, setRepository] = useState<Repository | null>(null);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<Action>('push');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(true);
  const [cloneRepo, setCloneRepo] = useState('');
  const [directory, setDirectory] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 100000);
    let active = true;
    setLoading(true);
    setConnection(null);
    setRepository(null);
    setConnectionError(null);
    setRepositoryError(null);
    setConfirmed(false);
    setError(null);
    void (async () => {
      try {
        const account = await getApiJson<Connection>('/api/v1/github/connection', controller.signal);
        if (!active) return;
        setConnection(account);
        if (!account.connected) return;
        try {
          const repo = await getApiJson<Repository>(`/api/v1/workspaces/${workspace.id}/github`, controller.signal);
          if (!active) return;
          setRepository(repo);
          setBase(repo.default_branch);
        } catch (failure) {
          if (active) setRepositoryError(controller.signal.aborted
            ? 'Repository check timed out. Select Refresh to try again.'
            : failure instanceof Error ? failure.message : 'Repository status could not be loaded.');
        }
      } catch (failure) {
        if (active) setConnectionError(controller.signal.aborted
          ? 'Connection check timed out. Select Refresh to try again.'
          : failure instanceof Error ? failure.message : 'GitHub connection could not be checked.');
      } finally {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [workspace.id, revision]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || busy || loading || !connection?.connected) return;
    if (action !== 'clone' && repository === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 180000);
    try {
      const payload = action === 'clone'
        ? { repository: cloneRepo, directory, confirmed }
        : { repository: repository!.repository, branch: repository!.branch, expected_head: repository!.head, confirmed,
            ...(action === 'pull-requests' ? { title, body, base, draft } : {}) };
      const response = await postApiJson<Result>(`/api/v1/workspaces/${workspace.id}/github/${action}`, payload, controller.signal);
      if (!mounted.current) return;
      setResult(response);
      setConfirmed(false);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof DOMException && failure.name === 'AbortError'
        ? 'The request timed out. Check GitHub before retrying; the operation might have finished.'
        : failure instanceof Error ? failure.message : 'The GitHub operation failed.');
      setConfirmed(false);
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="github-panel" aria-label="GitHub workflows" aria-busy={busy || loading}>
      <header><div><strong>GitHub</strong><span>{connection?.login ? `Signed in as ${connection.login}` : 'Local account connection'}</span></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close GitHub panel">×</button></header>
      <div className="github-connection">
        <span>{loading ? connection?.connected ? 'Checking repository…' : 'Checking connection…' : connection?.message ?? 'Connection status unavailable.'}</span>
        <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={busy || loading}>Refresh</button>
      </div>
      {connection?.connected === false && !loading && <div className="github-signin">
        <strong>Connect on this computer</strong>
        <p>Run this in PowerShell, complete GitHub sign-in, then select Refresh.</p>
        <code>gh auth login --hostname github.com --web --git-protocol https</code>
        <p>Credentials stay with GitHub CLI. Check that it uses the system credential store. Clean Code does not receive your token.</p>
      </div>}
      {connection?.connected && <>
        {repositoryError && action !== 'clone' && <p className="github-error" role="alert">Repository unavailable: {repositoryError} You can still clone a repository into this workspace.</p>}
        {repository && <div className="github-repository"><a href={repository.url} target="_blank" rel="noreferrer">{repository.repository}</a><span>{repository.branch} · {repository.head.slice(0, 7)}</span></div>}
        <nav aria-label="GitHub action">{(['push', 'pull-requests', 'clone'] as const).map((value) => <button key={value} type="button" aria-pressed={action === value} disabled={busy} onClick={() => { setAction(value); setConfirmed(false); setResult(null); setError(null); }}>{value === 'push' ? 'Push' : value === 'clone' ? 'Clone' : 'Pull request'}</button>)}</nav>
        <form onSubmit={(event) => void submit(event)}>
          {action === 'clone' ? <>
            <GitHubRepositoryPicker disabled={busy || loading} onSelect={(name) => {
              setCloneRepo(name);
              setConfirmed(false);
            }} />
            <label>Repository<input value={cloneRepo} placeholder="owner/repository" required maxLength={160} disabled={busy} onChange={(event) => { setCloneRepo(event.target.value); setConfirmed(false); }} /></label>
            <label>New folder<input value={directory} placeholder="repository-name" required pattern="[A-Za-z0-9][A-Za-z0-9_-]*" maxLength={80} disabled={busy} onChange={(event) => { setDirectory(event.target.value); setConfirmed(false); }} /></label>
            <p>Destination: <code>{workspace.root_path}/{directory || 'new-folder'}</code>. Existing folders are never replaced. Add the cloned folder as a workspace after completion.</p>
          </> : repository ? <>
            <p>{action === 'push' ? 'Publish the reviewed commit to this branch. No force push. Git hooks still run.' : 'Create a pull request from this branch. Push the current commit first.'}</p>
            {action === 'pull-requests' && <>
              <label>Base branch<input value={base} required disabled={busy} onChange={(event) => { setBase(event.target.value); setConfirmed(false); }} /></label>
              <label>Title<input value={title} required maxLength={200} disabled={busy} onChange={(event) => { setTitle(event.target.value); setConfirmed(false); }} /></label>
              <label>Description<textarea value={body} rows={4} maxLength={50000} disabled={busy} onChange={(event) => { setBody(event.target.value); setConfirmed(false); }} /></label>
              <label className="github-checkbox"><input type="checkbox" checked={draft} disabled={busy} onChange={(event) => { setDraft(event.target.checked); setConfirmed(false); }} />Create as draft</label>
            </>}
          </> : <p>Select a workspace whose origin is a GitHub repository to push or create a pull request.</p>}
          <label className="github-checkbox"><input type="checkbox" checked={confirmed} disabled={busy || loading} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the destination and authorize this {action === 'pull-requests' ? 'pull request' : action}.</label>
          <button className="github-primary" disabled={busy || loading || !confirmed || (action !== 'clone' && !repository)}>{busy ? 'Working…' : action === 'push' ? 'Push branch' : action === 'clone' ? 'Clone repository' : draft ? 'Create draft pull request' : 'Create pull request'}</button>
        </form>
        {repository && repository.pull_requests.length > 0 && <div className="github-pulls"><strong>Open pull requests</strong>{repository.pull_requests.map((pr) => <a href={pr.url} key={pr.number} target="_blank" rel="noreferrer">#{pr.number} {pr.title}{pr.draft ? ' · Draft' : ''}</a>)}</div>}
      </>}
      {error && <p className="github-error" role="alert">{error}</p>}
      {connectionError && <p className="github-error" role="alert">Connection check failed: {connectionError}</p>}
      {result && <div className="github-result" role="status"><p>{result.message}</p>{result.path && <>
        <code>{result.path}</code>
        <button type="button" disabled={busy} onClick={() => onAddWorkspace(result.path!)}>Add as workspace</button>
      </>}{result.url && <a href={result.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>}</div>}
    </section>
  );
}
