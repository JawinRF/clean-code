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

export type ModelCatalogResponse = {
  schema_version: 1;
  providers: Array<{
    id: string;
    label: string;
    models: Array<{
      id: string;
      label: string;
    }>;
  }>;
};

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunResponse = {
  id: string;
  session_id: string;
  trigger_message_id: string | null;
  status: AgentRunStatus;
  model_provider: string;
  model_name: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

export type RunEventResponse = {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  schema_version: number;
  created_at: string;
};

type ApiErrorResponse = {
  detail?: unknown;
};

async function apiErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorResponse;

    if (typeof body.detail === 'string') {
      return body.detail;
    }
  } catch {
    // The status code remains useful when the server does not return JSON.
  }

  return `HTTP error! status: ${response.status}`;
}

export async function getApiJson<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal });

  if (!response.ok) {
    throw new Error(await apiErrorMessage(response));
  }

  return response.json() as Promise<T>;
}

export async function postApiJson<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(await apiErrorMessage(response));
  }

  return response.json() as Promise<T>;
}

export async function patchApiJson<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(await apiErrorMessage(response));
  }

  return response.json() as Promise<T>;
}

export async function deleteApi(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: 'DELETE',
    signal,
  });

  if (!response.ok) {
    throw new Error(await apiErrorMessage(response));
  }
}
