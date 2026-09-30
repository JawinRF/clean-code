import { useEffect, useState } from 'react';
import { getApiJson, postApiJson, type AgentRunResponse, type MessageResponse } from '../api';
import { AssistantMessageContent } from '../MessageContent';
import './SubagentPanel.css';

function Worker({ run, needsApproval }: { run: AgentRunResponse; needsApproval: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const active = run.status === 'queued' || run.status === 'running';

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    void getApiJson<MessageResponse[]>(`/api/v1/sessions/${run.session_id}/messages`, controller.signal)
      .then((saved) => { if (!controller.signal.aborted) { setMessages(saved); setError(null); } })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load the worker report. Close and reopen to retry.'); });
    return () => controller.abort();
  }, [expanded, run.session_id, run.status]);

  async function stop() {
    setStopping(true);
    setError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    try {
      await postApiJson<AgentRunResponse>(`/api/v1/runs/${run.id}/cancel`, {}, controller.signal);
    } catch {
      setError('Could not stop this worker. Try again.');
      setStopping(false);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  const report = messages.filter((message) => message.role === 'assistant')
    .map((message) => message.content.parts.map((part) => part.text).join('')).join('\n\n');
  const assignment = messages.find((message) => message.role === 'user');

  return (
    <article className="subagent-worker" data-status={run.status}>
      <div className="subagent-worker-heading">
        <button type="button" className="subagent-expand" aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <strong>{run.agent_label ?? 'Worker'}</strong>
          <span className="subagent-state">{needsApproval ? 'Awaiting approval' : run.status}</span>
        </button>
        {active && <button type="button" className="subagent-stop" disabled={stopping}
          onClick={() => void stop()} aria-label={`Stop ${run.agent_label ?? 'worker'}`}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>}
      </div>
      <p className="subagent-model">{run.model_provider} / {run.model_name}</p>
      {error && <p className="subagent-error" role="alert">{error}</p>}
      {expanded && <div className="subagent-report">
        {assignment && <details><summary>Assignment</summary>
          <p>{assignment.content.parts.map((part) => part.text).join('')}</p>
        </details>}
        {run.error_message && <p className="subagent-error">{run.error_message}</p>}
        {report ? <AssistantMessageContent text={report} />
          : <p>{active ? 'The report will appear when this worker finishes.' : 'No final report was saved.'}</p>}
      </div>}
    </article>
  );
}

export function SubagentPanel({ runs, approvalRunIds }: {
  runs: AgentRunResponse[];
  approvalRunIds: Set<string>;
}) {
  if (runs.length === 0) return null;
  const activeCount = runs.filter((run) => run.status === 'running' || run.status === 'queued').length;
  return (
    <section className="subagent-panel" aria-label="Delegated workers">
      <header><strong>Workers · {runs.length}</strong>
        <span role="status">{activeCount > 0 ? `${activeCount} active · parent waiting` : 'Reports ready'}</span>
      </header>
      <div className="subagent-list">
        {runs.map((run) => <Worker key={run.id} run={run} needsApproval={approvalRunIds.has(run.id)} />)}
      </div>
    </section>
  );
}
