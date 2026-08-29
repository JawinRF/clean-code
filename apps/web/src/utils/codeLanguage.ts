export function normalizeCodeLanguage(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const aliases: Record<string, string> = {
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

  return aliases[lower] ?? lower;
}
