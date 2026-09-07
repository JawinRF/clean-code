import { useEffect, useState } from 'react';
import { getApiJson } from '../api';

type RepositoryPage = {
  repositories: Array<{ name: string; private: boolean }>;
  page: number;
  has_more: boolean;
};

export function GitHubRepositoryPicker({ onSelect, disabled }: {
  onSelect: (repository: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<RepositoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 35000);
    setLoading(true);
    setData(null);
    setError(null);
    void getApiJson<RepositoryPage>(`/api/v1/github/repositories?page=${page}`, controller.signal)
      .then((response) => { if (active) setData(response); })
      .catch((failure: unknown) => {
        if (active) setError(controller.signal.aborted ? 'Repository list timed out.'
          : failure instanceof Error ? failure.message : 'Could not load repositories.');
      })
      .finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [open, page, retry]);

  return <div className="github-repo-picker">
    <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>Browse account repositories</button>
    {open && <div aria-label="Account repositories" aria-busy={loading}>
      {loading && <p role="status">Loading repositories…</p>}
      {error && <p role="alert">{error} <button type="button" disabled={disabled} onClick={() => setRetry(retry + 1)}>Retry</button></p>}
      {data && <>
        <div className="github-repo-list">{data.repositories.map((repository) => <button type="button" key={repository.name} disabled={disabled}
          onClick={() => { onSelect(repository.name); setOpen(false); }}>
          <span>{repository.name}</span><small>{repository.private ? 'Private' : 'Public'}</small>
        </button>)}</div>
        {data.repositories.length === 0 && <p>No repositories on this page. You can enter an owner/repository manually.</p>}
        <div className="github-repo-pages">
          <button type="button" disabled={disabled || page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {data.page}</span>
          <button type="button" disabled={disabled || !data.has_more} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </>}
    </div>}
  </div>;
}
