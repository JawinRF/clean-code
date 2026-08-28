export type WorkspaceResponse = {
  id: string;
  project_id: string;
  name: string;
  root_path: string;
  created_at: string;
};

export type AgentSessionResponse = {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
};

export type MessageResponse = {
  id: string;
  session_id: string;
  run_id: string | null;
  role: string;
  content: {
    parts: Array<{
      type: 'text';
      text: string;
    }>;
  };
  schema_version: number;
  created_at: string;
};

export async function getApiJson<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json() as Promise<T>;
}
