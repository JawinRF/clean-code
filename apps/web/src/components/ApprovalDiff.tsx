import type { ToolApprovalResponse } from '../api';
import './ApprovalDiff.css';

export function ApprovalDiff({ preview }: { preview: NonNullable<ToolApprovalResponse['file_preview']> }) {
  const lines = preview.unified_diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return (
    <div className="approval-diff">
      <div className="approval-diff-summary">
        <strong>Proposed changes</strong>
        <span>+{preview.additions} / −{preview.deletions}</span>
      </div>
      {preview.before_line_endings !== preview.after_line_endings && (
        <p className="approval-diff-endings">
          Line endings: {preview.before_line_endings} → {preview.after_line_endings}
        </p>
      )}
      <pre className="approval-diff-content" tabIndex={0} aria-label={`Proposed file diff for ${preview.path}`}>
        {lines.map((line, index) => {
          const tone = index < 2 || line.startsWith('@@')
            ? 'header' : line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : 'context';
          return <span key={index} className={`approval-diff-line approval-diff-line--${tone}`}>{line || ' '}</span>;
        })}
      </pre>
    </div>
  );
}
