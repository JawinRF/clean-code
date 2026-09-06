import type { AgentRunResponse, ToolApprovalResponse } from '../api';


export type InterruptedRun = {
  run: AgentRunResponse;
  approvals: ToolApprovalResponse[];
};

export function InterruptedRunPanel({ recovery }: { recovery: InterruptedRun }) {
  const interruptedApprovals = recovery.approvals.filter(
    (approval) => approval.status === 'interrupted',
  );

  return (
    <section className="interrupted-run-panel" aria-label="Interrupted run" role="status">
      <strong>Run interrupted</strong>
      <p>The local runtime stopped. Saved operations were not replayed. Review the recorded results before sending a follow-up.</p>
      {interruptedApprovals.map((approval) => (
        <details key={approval.id}>
          <summary>{approval.tool_name}: approval interrupted, action not started</summary>
          <p>{approval.reason}</p>
          <pre aria-label="Saved tool arguments">{JSON.stringify(approval.arguments, null, 2)}</pre>
        </details>
      ))}
    </section>
  );
}
