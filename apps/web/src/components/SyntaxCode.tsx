import { useEffect, useMemo, useState } from 'react';
import { createHighlighter, type Highlighter } from 'shiki';
import { normalizeCodeLanguage } from '../utils/codeLanguage';


const SUPPORTED_LANGUAGES = [
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
const highlightedCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 300;


function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark-default'],
      langs: [...SUPPORTED_LANGUAGES],
    });
  }

  return highlighterPromise;
}


function cacheKeyFor(code: string, language: string): string {
  return `${language}::${code.length}::${code.slice(0, 64)}::${code.slice(-64)}`;
}


export function ShikiCode({
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

    void getHighlighter().then((loadedHighlighter) => {
      if (!cancelled) setHighlighter(loadedHighlighter);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const html = useMemo(() => {
    if (highlighter === null) return null;

    const language = normalizeCodeLanguage(lang);
    const isLoaded = (highlighter.getLoadedLanguages() as string[]).includes(language);

    if (!isLoaded) return null;

    const text = code.replace(/\n$/, '');
    if (text.length === 0) return '';

    const key = cacheKeyFor(text, language);
    const cached = highlightedCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const result = highlighter.codeToHtml(text, {
        lang: language,
        theme: 'github-dark-default',
      });
      const match = result.match(/<code[^>]*>([\s\S]*?)<\/code>/);
      const inner = match ? match[1] : result;

      if (highlightedCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = highlightedCache.keys().next().value as string;
        highlightedCache.delete(firstKey);
      }

      highlightedCache.set(key, inner);
      return inner;
    } catch {
      return null;
    }
  }, [code, highlighter, lang]);

  if (html !== null) {
    return <code className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <code className={className}>{code}</code>;
}
