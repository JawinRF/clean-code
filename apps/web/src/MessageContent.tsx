import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useState, useMemo } from 'react';
import { createHighlighter, type Highlighter } from 'shiki';

type MessageContentProps = {
  text: string;
};

const SP_SUPPORTED_LANGS = [
  'python',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'cpp',
  'c',
  'java',
  'go',
  'rust',
  'bash',
  'json',
  'yaml',
  'toml',
  'sql',
  'html',
  'css',
  'markdown',
  'dockerfile',
  'powershell',
  'shellscript',
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark-default'],
      langs: [...SP_SUPPORTED_LANGS],
    });
  }
  return highlighterPromise;
}

function normalizeLang(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const map: Record<string, string> = {
    py: 'python',
    python: 'python',
    js: 'javascript',
    javascript: 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    cpp: 'cpp',
    'c++': 'cpp',
    c: 'c',
    java: 'java',
    go: 'go',
    rust: 'rust',
    rs: 'rust',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    shellscript: 'bash',
    powershell: 'powershell',
    ps1: 'powershell',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    html: 'html',
    css: 'css',
    markdown: 'markdown',
    md: 'markdown',
    dockerfile: 'dockerfile',
    docker: 'dockerfile',
  };
  return map[lower] ?? lower;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const highlightedCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 300;

function cacheKeyFor(code: string, lang: string): string {
  return `${lang}::${code.length}::${code.slice(0, 64)}::${code.slice(-64)}`;
}

function ShikiCode({
  code,
  lang,
  className,
}: {
  code: string;
  lang: string;
  className?: string;
}) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((h) => {
      if (!cancelled) setHighlighter(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const html = useMemo(() => {
    if (!highlighter) return null;
    const normalized = normalizeLang(lang);
    const isLoaded = (highlighter.getLoadedLanguages() as string[]).includes(normalized);
    if (!isLoaded) return null;
    const text = code.replace(/\n$/, '');
    if (text.length === 0) return '';
    const key = cacheKeyFor(text, normalized);
    const cached = highlightedCache.get(key);
    if (cached) return cached;
    try {
      const result = highlighter.codeToHtml(text, {
        lang: normalized,
        theme: 'github-dark-default',
      });
      const match = result.match(/<code[^>]*>([\s\S]*?)<\/code>/);
      const inner = match ? match[1] : result;
      if (highlightedCache.size >= MAX_CACHE_ENTRIES) {
        const first = highlightedCache.keys().next().value as string;
        highlightedCache.delete(first);
      }
      highlightedCache.set(key, inner);
      return inner;
    } catch {
      return null;
    }
  }, [highlighter, code, lang]);

  if (html !== null) {
    return <code className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <code className={className}>{code}</code>;
}

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
            const normalized = lang ? normalizeLang(lang) : null;
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
