import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MessageContentProps = {
  text: string;
};

export function AssistantMessageContent({ text }: MessageContentProps) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function UserMessageContent({ text }: MessageContentProps) {
  return <p className="plain-message">{text}</p>;
}
