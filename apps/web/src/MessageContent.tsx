import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ShikiCode } from './components/SyntaxCode';
import { normalizeCodeLanguage } from './utils/codeLanguage';

type MessageContentProps = {
  text: string;
};

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;

export function AssistantMessageContent({ text }: MessageContentProps) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props: any) {
            const { inline, className, children, ...rest } = props;
            const match = CODE_FENCE_LANGUAGE_REGEX.exec(className || '');
            const lang = match ? match[1] : '';
            const code = String(children);
            if (inline || !lang) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return <ShikiCode code={code} lang={lang} className={className} {...rest} />;
          },
          pre(props: any) {
            const { children, ...rest } = props;
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string | undefined = child?.props?.className;
            const match = className ? CODE_FENCE_LANGUAGE_REGEX.exec(className) : null;
            const lang = match ? match[1] : null;
            const normalized = lang ? normalizeCodeLanguage(lang) : null;
            const label = normalized ? normalized.toUpperCase() : lang ? lang.toUpperCase() : null;
            if (label) {
              return (
                <div className="code-block-wrapper">
                  <div className="code-block-header">{label}</div>
                  <pre {...rest}>{children}</pre>
                </div>
              );
            }
            return <pre {...rest}>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function UserMessageContent({ text }: MessageContentProps) {
  return <p className="plain-message">{text}</p>;
}
