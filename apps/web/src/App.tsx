import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  getApiJson,
  postApiJson,
  type AgentRunResponse,
  type AgentSessionResponse,
  type MessageResponse,
  type ModelCatalogResponse,
  type RunEventResponse,
  type WorkspaceResponse,
} from './api';
import {
  AssistantMessageContent,
  UserMessageContent,
} from './MessageContent';
import './App.css';

type ReadyResponse = {
  status: string;
  database: string;
  user: string;
};

type ProjectResponse = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
};

type ErrorResponse = {
  detail?: unknown;
};

type StatusTone = 'neutral' | 'working' | 'success' | 'danger';

type ActiveTurn = {
  runId: string;
  sessionId: string;
  triggerMessageId: string;
  providerId: string;
  modelId: string;
};

type RetryTurn = Omit<ActiveTurn, 'runId'> & {
  runId?: string;
};

type ModelOption = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
};

type ModelSelection = {
  providerId: string;
  modelId: string;
};

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

type IconName =
  | 'arrow-up'
  | 'arrow-down'
  | 'check'
  | 'chevron'
  | 'close'
  | 'copy'
  | 'folder'
  | 'menu'
  | 'message'
  | 'plus'
  | 'refresh'
  | 'stop'
  | 'terminal';

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    'arrow-up': <path d="m6 9 6-6 6 6M12 3v14" />,
    'arrow-down': <path d="m6 9 6 6 6-6" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    copy: <path d="M9 9h10v10H9zM5 15H4V5h10v1" />,
    folder: <path d="M3 7.5h6l2-2h10v13H3z" />,
    menu: <path d="M5 7h14M5 12h14M5 17h14" />,
    message: <path d="M4 5h16v12H8l-4 3z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.7-1.9L20 8M4 16l2.2 1.9A7 7 0 0 0 17.9 16" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
    terminal: <path d="m5 7 4 4-4 4M11 16h8" />,
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 1600);
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <button
      className="message-action"
      type="button"
      onClick={() => void copyMessage()}
      aria-label={copyStatus === 'copied' ? 'Message copied' : 'Copy message'}
      title={copyStatus === 'failed' ? 'Copy failed' : 'Copy message'}
    >
      {copyStatus === 'copied' ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
      <span>{copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </button>
  );
}

function ActivityRow({
  title,
  detail,
  endpoint,
  tone,
}: {
  title: string;
  detail: string;
  endpoint: string;
  tone: StatusTone;
}) {
  return (
    <details className="activity-row">
      <summary>
        <span className={`activity-state activity-state--${tone}`}>
          {tone === 'success' ? <Icon name="check" size={13} /> : <Icon name="terminal" size={13} />}
        </span>
        <span className="activity-title">{title}</span>
        <span className="activity-separator" />
        <span className="activity-detail">{detail}</span>
        <span className="activity-chevron"><Icon name="chevron" size={13} /></span>
      </summary>
      <div className="activity-output">
        <span>GET</span>
        <code>{endpoint}</code>
        <p>{detail}</p>
      </div>
    </details>
  );
}

function statusTone(value: string): StatusTone {
  const normalized = value.toLowerCase();

  if (normalized.includes('failed')) return 'danger';
  if (normalized.includes('checking') || normalized.includes('loading')) return 'working';
  if (
    normalized.includes('ready')
    || normalized.includes('loaded')
    || normalized.includes('updated')
    || normalized.startsWith('no ')
  ) return 'success';

  return 'neutral';
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Request timed out';
  }

  return error instanceof Error ? error.message : 'Unknown error';
}

function messageText(message: MessageResponse): string {
  return message.content.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function runEventText(events: RunEventResponse[]): string {
  return events
    .filter((event) => event.event_type === 'assistant.delta')
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => event.payload.text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function mergeSessionMessages(
  persistedMessages: MessageResponse[],
  currentMessages: MessageResponse[],
  sessionId: string,
): MessageResponse[] {
  const byId = new Map(
    persistedMessages.map((message) => [message.id, message]),
  );

  for (const message of currentMessages) {
    if (message.session_id === sessionId && !byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }

  return [...byId.values()].sort((left, right) => (
    new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  ));
}

function modelOptions(
  catalog: ModelCatalogResponse | null,
): ModelOption[] {
  return catalog?.providers.flatMap((provider) => (
    provider.models.map((model) => ({
      providerId: provider.id,
      providerLabel: provider.label,
      modelId: model.id,
      label: model.label,
    }))
  )) ?? [];
}

function sessionTitleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();

  if (oneLine.length <= 64) return oneLine;

  return `${oneLine.slice(0, 61)}...`;
}

function App() {
  const [apiStatus, setApiStatus] = useState('Not checked');
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [projectsStatus, setProjectsStatus] = useState('Projects not loaded');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [createStatus, setCreateStatus] = useState('Ready to create a project');
  const [isCreating, setIsCreating] = useState(false);
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [workspacesStatus, setWorkspacesStatus] = useState('Workspaces not loaded');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceRootPath, setWorkspaceRootPath] = useState('');
  const [workspaceCreateStatus, setWorkspaceCreateStatus] = useState('Enter a local folder path');
  const [isWorkspaceFormOpen, setIsWorkspaceFormOpen] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [agentSessions, setAgentSessions] = useState<AgentSessionResponse[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState('Sessions not loaded');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isNewConversation, setIsNewConversation] = useState(false);
  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [messagesStatus, setMessagesStatus] = useState('Messages not loaded');
  const [draft, setDraft] = useState('');
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse | null>(null);
  const [modelsStatus, setModelsStatus] = useState('Models not loaded');
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [runEvents, setRunEvents] = useState<RunEventResponse[]>([]);
  const [turnStatus, setTurnStatus] = useState('Ready');
  const [turnError, setTurnError] = useState<string | null>(null);
  const [retryTurn, setRetryTurn] = useState<RetryTurn | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const conversationRef = useRef<HTMLElement | null>(null);
  const followConversationRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);

  const checkApi = useCallback(async () => {
    setApiStatus('Checking...');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await fetch('/api/v1/ready', {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as ReadyResponse;
      setApiStatus(
        `Database: ${data.database}, User: ${data.user}, Status: ${data.status}`,
      );
    } catch (error) {
      const message = error instanceof DOMException
        && error.name === 'AbortError'
          ? 'Request timed out'
          : error instanceof Error
            ? error.message
            : 'Unknown error';

      setApiStatus(`Connection failed: ${message}`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  const loadModels = useCallback(async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    setModelsStatus('Loading models...');

    try {
      const catalog = await getApiJson<ModelCatalogResponse>(
        '/api/v1/models',
        controller.signal,
      );
      const modelCount = catalog.providers.reduce(
        (count, provider) => count + provider.models.length,
        0,
      );

      setModelCatalog(catalog);
      setModelsStatus(
        modelCount === 0
          ? 'No models configured'
          : `${modelCount} model${modelCount === 1 ? '' : 's'} configured`,
      );
    } catch (error) {
      setModelsStatus(`Loading failed: ${requestErrorMessage(error)}`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsStatus('Loading projects...');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await fetch('/api/v1/projects', {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as ProjectResponse[];
      setProjects(data);
      setProjectsStatus(
        data.length === 0
          ? 'No projects found'
          : `${data.length} project${data.length === 1 ? '' : 's'} loaded`,
      );
    } catch (error) {
      const message = error instanceof DOMException
        && error.name === 'AbortError'
          ? 'Request timed out'
          : error instanceof Error
            ? error.message
            : 'Unknown error';

      setProjectsStatus(`Loading failed: ${message}`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void checkApi();
  }, [checkApi]);

  useEffect(() => {
    const options = modelOptions(modelCatalog);

    if (options.length === 0) {
      setSelectedModel(null);
      return;
    }

    const selectionIsAvailable = selectedModel !== null
      && options.some((option) => (
        option.providerId === selectedModel.providerId
        && option.modelId === selectedModel.modelId
      ));

    if (selectionIsAvailable) return;

    setSelectedModel({
      providerId: options[0].providerId,
      modelId: options[0].modelId,
    });
  }, [modelCatalog, selectedModel]);

  useEffect(() => {
    if (!isModelMenuOpen) return undefined;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !modelMenuRef.current?.contains(event.target)
      ) {
        setIsModelMenuOpen(false);
        setModelSearch('');
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsModelMenuOpen(false);
        setModelSearch('');
      }
    };

    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isModelMenuOpen]);

  useEffect(() => {
    if (
      projects.length > 0
      && !projects.some((project) => project.id === selectedProjectId)
    ) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
    setAgentSessions([]);
    setSelectedSessionId(null);
    setIsNewConversation(false);
    setMessages([]);

    if (selectedProjectId === null) {
      setWorkspacesStatus('Select a project');
      setSessionsStatus('Select a workspace');
      setMessagesStatus('Select a session');
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    setWorkspacesStatus('Loading workspaces...');
    setSessionsStatus('Select a workspace');
    setMessagesStatus('Select a session');

    void getApiJson<WorkspaceResponse[]>(
      `/api/v1/projects/${selectedProjectId}/workspaces`,
      controller.signal,
    ).then((data) => {
      if (!active) return;
      setWorkspaces(data);
      setSelectedWorkspaceId(data[0]?.id ?? null);
      setWorkspacesStatus(
        data.length === 0
          ? 'No workspaces found'
          : `${data.length} workspace${data.length === 1 ? '' : 's'} loaded`,
      );
    }).catch((error: unknown) => {
      if (!active) return;
      setWorkspacesStatus(`Loading failed: ${requestErrorMessage(error)}`);
    }).finally(() => {
      window.clearTimeout(timeoutId);
    });

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [selectedProjectId]);

  useEffect(() => {
    setAgentSessions([]);
    setSelectedSessionId(null);
    setIsNewConversation(false);
    setMessages([]);

    if (selectedWorkspaceId === null) {
      setSessionsStatus('Select a workspace');
      setMessagesStatus('Select a session');
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    setSessionsStatus('Loading sessions...');
    setMessagesStatus('Select a session');

    void getApiJson<AgentSessionResponse[]>(
      `/api/v1/workspaces/${selectedWorkspaceId}/sessions`,
      controller.signal,
    ).then((data) => {
      if (!active) return;
      setAgentSessions(data);
      setSelectedSessionId(data[0]?.id ?? null);
      setIsNewConversation(data.length === 0);
      setSessionsStatus(
        data.length === 0
          ? 'No sessions found'
          : `${data.length} session${data.length === 1 ? '' : 's'} loaded`,
      );
    }).catch((error: unknown) => {
      if (!active) return;
      setSessionsStatus(`Loading failed: ${requestErrorMessage(error)}`);
    }).finally(() => {
      window.clearTimeout(timeoutId);
    });

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    setMessages([]);
    setRunEvents([]);
    setTurnStatus('Ready');
    setTurnError(null);
    setRetryTurn(null);
    followConversationRef.current = true;
    setShowScrollToBottom(false);

    if (selectedSessionId === null) {
      setMessagesStatus(
        isNewConversation
          ? 'Ready for your first message'
          : 'Select a session',
      );
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    setMessagesStatus('Loading messages...');

    void getApiJson<MessageResponse[]>(
      `/api/v1/sessions/${selectedSessionId}/messages`,
      controller.signal,
    ).then((data) => {
      if (!active) return;
      setMessages((currentMessages) => mergeSessionMessages(
        data,
        currentMessages,
        selectedSessionId,
      ));
      setMessagesStatus(
        data.length === 0
          ? 'No messages found'
          : `${data.length} message${data.length === 1 ? '' : 's'} loaded`,
      );
    }).catch((error: unknown) => {
      if (!active) return;
      setMessagesStatus(`Loading failed: ${requestErrorMessage(error)}`);
    }).finally(() => {
      window.clearTimeout(timeoutId);
    });

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [isNewConversation, selectedSessionId]);

  useEffect(() => {
    const textarea = composerRef.current;

    if (textarea === null) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [draft]);

  useEffect(() => {
    if (selectedSessionId === null && !isNewConversation) return;

    window.requestAnimationFrame(() => {
      composerRef.current?.focus({ preventScroll: true });
    });
  }, [isNewConversation, selectedSessionId]);

  useEffect(() => {
    const conversation = conversationRef.current;

    if (!followConversationRef.current || conversation === null) return;

    window.requestAnimationFrame(() => {
      conversation.scrollTop = conversation.scrollHeight;
      setShowScrollToBottom(false);
    });
  }, [activeTurn, messages, runEvents]);

  useEffect(() => {
    if (activeTurn === null) return undefined;

    let active = true;
    let pollTimeoutId: number | undefined;
    let requestController: AbortController | null = null;

    const schedulePoll = (delay: number) => {
      pollTimeoutId = window.setTimeout(() => {
        void pollRun();
      }, delay);
    };

    const pollRun = async () => {
      requestController = new AbortController();
      const requestTimeoutId = window.setTimeout(
        () => requestController?.abort(),
        5000,
      );

      try {
        const [run, events] = await Promise.all([
          getApiJson<AgentRunResponse>(
            `/api/v1/runs/${activeTurn.runId}`,
            requestController.signal,
          ),
          getApiJson<RunEventResponse[]>(
            `/api/v1/runs/${activeTurn.runId}/events`,
            requestController.signal,
          ),
        ]);

        if (!active) return;

        setRunEvents(events);
        setTurnError(null);

        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          setTurnStatus(
            run.status === 'completed'
              ? 'Response complete'
              : run.status === 'cancelled'
                ? 'Stopped'
                : 'Generation failed',
          );

          const history = await getApiJson<MessageResponse[]>(
            `/api/v1/sessions/${activeTurn.sessionId}/messages`,
            requestController.signal,
          );

          if (!active) return;

          setMessages(history);
          setMessagesStatus(
            history.length === 0
              ? 'No messages found'
              : `${history.length} message${history.length === 1 ? '' : 's'} loaded`,
          );
          setTurnError(
            run.status === 'failed'
              ? run.error_message ?? 'The agent run failed.'
              : null,
          );

          if (run.status === 'completed') {
            setRunEvents([]);
            setRetryTurn(null);
          } else {
            setRetryTurn({
              sessionId: activeTurn.sessionId,
              triggerMessageId: activeTurn.triggerMessageId,
              providerId: activeTurn.providerId,
              modelId: activeTurn.modelId,
            });
          }

          setActiveTurn(null);
          setIsStopping(false);
          return;
        }

        setTurnStatus(
          isStopping
            ? 'Stopping...'
            : run.status === 'queued'
              ? 'Starting...'
              : 'Generating...',
        );
        schedulePoll(300);
      } catch (error) {
        if (!active) return;

        setTurnStatus('Reconnecting...');
        setTurnError(
          `Live update interrupted: ${requestErrorMessage(error)}. Retrying...`,
        );
        schedulePoll(1000);
      } finally {
        window.clearTimeout(requestTimeoutId);
      }
    };

    void pollRun();

    return () => {
      active = false;
      requestController?.abort();

      if (pollTimeoutId !== undefined) {
        window.clearTimeout(pollTimeoutId);
      }
    };
  }, [activeTurn, isStopping]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreating(true);
    setCreateStatus('Creating project...');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName.trim(),
          description: projectDescription.trim() || null,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorResponse = (await response.json()) as ErrorResponse;
        const detail = typeof errorResponse.detail === 'string'
          ? errorResponse.detail
          : `HTTP error! status: ${response.status}`;

        throw new Error(detail);
      }

      const createdProject = (await response.json()) as ProjectResponse;

      setProjects((currentProjects) => [
        createdProject,
        ...currentProjects,
      ]);
      setProjectsStatus('Project list updated');
      setSelectedProjectId(createdProject.id);
      setProjectName('');
      setProjectDescription('');
      setCreateStatus(`Created ${createdProject.name}`);
      setIsProjectFormOpen(false);
      setIsWorkspaceFormOpen(true);
      setWorkspaceCreateStatus('Enter the folder that this agent can use');
    } catch (error) {
      const message = error instanceof DOMException
        && error.name === 'AbortError'
          ? 'Request timed out'
          : error instanceof Error
            ? error.message
            : 'Unknown error';

      setCreateStatus(`Creation failed: ${message}`);
    } finally {
      window.clearTimeout(timeoutId);
      setIsCreating(false);
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (selectedProjectId === null) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    setIsCreatingWorkspace(true);
    setWorkspaceCreateStatus('Adding workspace...');

    try {
      const createdWorkspace = await postApiJson<WorkspaceResponse>(
        `/api/v1/projects/${selectedProjectId}/workspaces`,
        {
          name: workspaceName.trim(),
          root_path: workspaceRootPath.trim(),
        },
        controller.signal,
      );

      setWorkspaces((currentWorkspaces) => [
        createdWorkspace,
        ...currentWorkspaces,
      ]);
      setSelectedWorkspaceId(createdWorkspace.id);
      setWorkspacesStatus('Workspace list updated');
      setWorkspaceName('');
      setWorkspaceRootPath('');
      setWorkspaceCreateStatus(`Added ${createdWorkspace.name}`);
      setIsWorkspaceFormOpen(false);
      setIsNewConversation(true);
    } catch (error) {
      setWorkspaceCreateStatus(
        `Workspace failed: ${requestErrorMessage(error)}`,
      );
    } finally {
      window.clearTimeout(timeoutId);
      setIsCreatingWorkspace(false);
    }
  }

  const startNewConversation = useCallback(() => {
    if (selectedWorkspaceId === null || activeTurn !== null || isSubmitting) {
      return;
    }

    setSelectedSessionId(null);
    setIsNewConversation(true);
    setMessages([]);
    setRunEvents([]);
    setDraft('');
    setTurnStatus('Ready');
    setTurnError(null);
    setRetryTurn(null);
    setMessagesStatus('Ready for your first message');
    setIsSidebarOpen(false);
    followConversationRef.current = true;
    setShowScrollToBottom(false);
  }, [activeTurn, isSubmitting, selectedWorkspaceId]);

  function selectStoredSession(sessionId: string) {
    setIsNewConversation(false);
    setSelectedSessionId(sessionId);
    setIsSidebarOpen(false);
  }

  useEffect(() => {
    const handleNewConversationShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'n') return;
      if (selectedWorkspaceId === null || activeTurn !== null || isSubmitting) return;

      event.preventDefault();
      startNewConversation();
    };

    document.addEventListener('keydown', handleNewConversationShortcut);

    return () => {
      document.removeEventListener('keydown', handleNewConversationShortcut);
    };
  }, [activeTurn, isSubmitting, selectedWorkspaceId, startNewConversation]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    const selectedModelOption = selectedModel === null
      ? undefined
      : modelOptions(modelCatalog).find((modelOption) => (
          modelOption.providerId === selectedModel.providerId
          && modelOption.modelId === selectedModel.modelId
        ));

    if (
      text.length === 0
      || (selectedSessionId === null && !isNewConversation)
      || (selectedSessionId === null && selectedWorkspaceId === null)
      || selectedModelOption === undefined
      || activeTurn !== null
      || isSubmitting
    ) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    setIsSubmitting(true);
    setTurnStatus('Sending message...');
    setTurnError(null);
    setRetryTurn(null);
    setRunEvents([]);
    followConversationRef.current = true;
    setShowScrollToBottom(false);

    let targetSessionId = selectedSessionId;
    let userMessage: MessageResponse | null = null;
    let run: AgentRunResponse | null = null;

    try {
      if (targetSessionId === null) {
        const createdSession = await postApiJson<AgentSessionResponse>(
          `/api/v1/workspaces/${selectedWorkspaceId}/sessions`,
          { title: sessionTitleFrom(text) },
          controller.signal,
        );

        targetSessionId = createdSession.id;
        setAgentSessions((currentSessions) => [
          createdSession,
          ...currentSessions,
        ]);
        setSelectedSessionId(createdSession.id);
        setIsNewConversation(false);
      }

      const persistedUserMessage = await postApiJson<MessageResponse>(
        `/api/v1/sessions/${targetSessionId}/messages`,
        { text },
        controller.signal,
      );
      userMessage = persistedUserMessage;

      if (selectedSessionId === null) {
        setMessages([persistedUserMessage]);
        setSelectedSessionId(targetSessionId);
        setIsNewConversation(false);
      } else {
        setMessages((currentMessages) => [
          ...currentMessages,
          persistedUserMessage,
        ]);
      }

      setMessagesStatus('Message sent');
      setDraft('');
      setTurnStatus('Creating run...');

      run = await postApiJson<AgentRunResponse>(
        `/api/v1/sessions/${targetSessionId}/runs`,
        {
          trigger_message_id: persistedUserMessage.id,
          model_provider: selectedModelOption.providerId,
          model_name: selectedModelOption.modelId,
        },
        controller.signal,
      );

      await postApiJson<AgentRunResponse>(
        `/api/v1/runs/${run.id}/execute`,
        {
          max_output_tokens: 2048,
          max_steps: 8,
        },
        controller.signal,
      );

      setTurnStatus('Starting...');
      setActiveTurn({
        runId: run.id,
        sessionId: targetSessionId,
        triggerMessageId: persistedUserMessage.id,
        providerId: selectedModelOption.providerId,
        modelId: selectedModelOption.modelId,
      });
    } catch (error) {
      setTurnStatus('Send failed');
      setTurnError(requestErrorMessage(error));

      if (targetSessionId !== null && userMessage !== null) {
        setRetryTurn({
          sessionId: targetSessionId,
          triggerMessageId: userMessage.id,
          providerId: selectedModelOption.providerId,
          modelId: selectedModelOption.modelId,
          runId: run?.id,
        });
      }
    } finally {
      window.clearTimeout(timeoutId);
      setIsSubmitting(false);
    }
  }

  async function retryAgentResponse() {
    if (retryTurn === null || activeTurn !== null || isSubmitting) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    setIsSubmitting(true);
    setTurnError(null);
    setTurnStatus('Retrying...');
    setRunEvents([]);
    followConversationRef.current = true;
    setShowScrollToBottom(false);

    let runId = retryTurn.runId;

    try {
      let run = runId === undefined
        ? null
        : await getApiJson<AgentRunResponse>(
            `/api/v1/runs/${runId}`,
            controller.signal,
          );

      if (run?.status === 'completed') {
        const history = await getApiJson<MessageResponse[]>(
          `/api/v1/sessions/${retryTurn.sessionId}/messages`,
          controller.signal,
        );
        setMessages(history);
        setMessagesStatus(`${history.length} messages loaded`);
        setTurnStatus('Response complete');
        setRetryTurn(null);
        return;
      }

      if (run === null || run.status === 'failed' || run.status === 'cancelled') {
        run = await postApiJson<AgentRunResponse>(
          `/api/v1/sessions/${retryTurn.sessionId}/runs`,
          {
            trigger_message_id: retryTurn.triggerMessageId,
            model_provider: retryTurn.providerId,
            model_name: retryTurn.modelId,
          },
          controller.signal,
        );
        runId = run.id;
      }

      if (run.status === 'queued') {
        await postApiJson<AgentRunResponse>(
          `/api/v1/runs/${run.id}/execute`,
          {
            max_output_tokens: 2048,
            max_steps: 8,
          },
          controller.signal,
        );
      }

      setTurnStatus(run.status === 'running' ? 'Generating...' : 'Starting...');
      setActiveTurn({
        runId: run.id,
        sessionId: retryTurn.sessionId,
        triggerMessageId: retryTurn.triggerMessageId,
        providerId: retryTurn.providerId,
        modelId: retryTurn.modelId,
      });
      setRetryTurn(null);
    } catch (error) {
      setTurnStatus('Retry failed');
      setTurnError(requestErrorMessage(error));
      setRetryTurn((currentTurn) => (
        currentTurn === null
          ? null
          : { ...currentTurn, runId }
      ));
    } finally {
      window.clearTimeout(timeoutId);
      setIsSubmitting(false);
    }
  }

  async function stopAgent() {
    if (activeTurn === null || isStopping) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    setIsStopping(true);
    setTurnStatus('Stopping...');
    setTurnError(null);

    try {
      await postApiJson<AgentRunResponse>(
        `/api/v1/runs/${activeTurn.runId}/cancel`,
        {},
        controller.signal,
      );
    } catch (error) {
      setIsStopping(false);
      setTurnError(`Stop failed: ${requestErrorMessage(error)}`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  ) ?? null;
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  ) ?? null;
  const selectedSession = agentSessions.find(
    (agentSession) => agentSession.id === selectedSessionId,
  ) ?? null;
  const configuredModels = modelOptions(modelCatalog);
  const selectedModelOption = selectedModel === null
    ? undefined
    : configuredModels.find((modelOption) => (
        modelOption.providerId === selectedModel.providerId
        && modelOption.modelId === selectedModel.modelId
      ));
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const filteredModels = configuredModels.filter((modelOption) => (
    normalizedModelSearch.length === 0
    || modelOption.label.toLowerCase().includes(normalizedModelSearch)
    || modelOption.modelId.toLowerCase().includes(normalizedModelSearch)
    || modelOption.providerLabel.toLowerCase().includes(normalizedModelSearch)
  ));
  const liveAssistantText = runEventText(runEvents);
  const turnIsActive = isSubmitting || activeTurn !== null;
  const conversationIsReady = selectedWorkspace !== null
    && (selectedSession !== null || isNewConversation);
  const canSend = conversationIsReady
    && selectedModelOption !== undefined
    && draft.trim().length > 0
    && !turnIsActive;
  const activeConversationTitle = isNewConversation
    ? 'New conversation'
    : selectedSession?.title ?? selectedProject?.name ?? 'Clean Code';

  const composerPlaceholder = selectedProject === null
    ? 'Select a project to continue'
    : selectedWorkspace === null
      ? 'Add or select a workspace to continue'
      : selectedSession === null && !isNewConversation
        ? 'Select a conversation to continue'
        : selectedModelOption === undefined
          ? 'Select a model to start'
          : turnIsActive
            ? 'Clean Code is responding...'
            : 'Message Clean Code';

  return (
    <div className="app-shell">
      <button
        className="sidebar-backdrop"
        type="button"
        aria-label="Close navigation"
        data-open={isSidebarOpen || undefined}
        onClick={() => setIsSidebarOpen(false)}
      />
      <aside className="sidebar" data-open={isSidebarOpen || undefined}>
        <div className="sidebar-brand">
          <span className="brand-mark">
            <img className="product-logo" src="/clean-code-logo.png" alt="" />
          </span>
          <span className="brand-copy">
            <span className="brand-wordmark">
              <img src="/clean-code-wordmark.png" alt="Clean Code" />
            </span>
            <small>Agent workspace</small>
          </span>
          <button
            className="sidebar-close"
            type="button"
            aria-label="Close navigation"
            onClick={() => setIsSidebarOpen(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <button
          className="new-chat-button"
          type="button"
          onClick={startNewConversation}
          disabled={selectedWorkspace === null || turnIsActive}
        >
          <Icon name="message" size={15} />
          New chat
          <span>Ctrl+N</span>
        </button>

        <button
          className="new-project-button"
          type="button"
          aria-expanded={isProjectFormOpen}
          onClick={() => setIsProjectFormOpen((isOpen) => !isOpen)}
          disabled={turnIsActive}
        >
          <Icon name="plus" size={15} />
          New project
        </button>

        {isProjectFormOpen && (
          <form className="project-form" onSubmit={createProject}>
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              name="name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              maxLength={120}
              placeholder="My agent project"
              disabled={isCreating || turnIsActive}
              autoFocus
              required
            />

            <label htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              name="description"
              value={projectDescription}
              onChange={(event) => setProjectDescription(event.target.value)}
              placeholder="Optional context"
              rows={3}
              disabled={isCreating || turnIsActive}
            />

            <div className="project-form-actions">
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setIsProjectFormOpen(false)}
                disabled={isCreating || turnIsActive}
              >
                Cancel
              </button>
              <button className="button button--primary" type="submit" disabled={isCreating || turnIsActive}>
                {isCreating ? 'Creating...' : 'Create'}
              </button>
            </div>
            <p className="form-status" role="status">{createStatus}</p>
          </form>
        )}

        {isWorkspaceFormOpen && selectedProject !== null && (
          <form className="project-form workspace-form" onSubmit={createWorkspace}>
            <div className="form-heading">
              <strong>Add workspace</strong>
              <span>{selectedProject.name}</span>
            </div>
            <label htmlFor="workspace-name">Workspace name</label>
            <input
              id="workspace-name"
              name="workspace-name"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              maxLength={120}
              placeholder="Website"
              disabled={isCreatingWorkspace || turnIsActive}
              autoFocus
              required
            />

            <label htmlFor="workspace-root">Local root path</label>
            <input
              id="workspace-root"
              name="workspace-root"
              value={workspaceRootPath}
              onChange={(event) => setWorkspaceRootPath(event.target.value)}
              placeholder="C:\\path\\to\\repository"
              disabled={isCreatingWorkspace || turnIsActive}
              required
            />

            <div className="project-form-actions">
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setIsWorkspaceFormOpen(false)}
                disabled={isCreatingWorkspace || turnIsActive}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={isCreatingWorkspace || turnIsActive}
              >
                {isCreatingWorkspace ? 'Adding...' : 'Add'}
              </button>
            </div>
            <p className="form-status" role="status">{workspaceCreateStatus}</p>
          </form>
        )}

        <div className="sidebar-section-heading">
          <span>Projects</span>
          <span className="sidebar-heading-actions">
            <button
              type="button"
              aria-label="Add workspace"
              title="Add workspace"
              onClick={() => setIsWorkspaceFormOpen(true)}
              disabled={selectedProject === null || turnIsActive}
            >
              <Icon name="plus" size={14} />
            </button>
            <button type="button" aria-label="Reload projects" onClick={loadProjects} disabled={turnIsActive}>
              <Icon name="refresh" size={14} />
            </button>
          </span>
        </div>

        <nav className="project-list" aria-label="Projects">
          {projects.map((project) => {
            const projectIsActive = project.id === selectedProjectId;

            return (
              <div className="project-group" key={project.id}>
                <button
                  className="project-row"
                  data-active={projectIsActive || undefined}
                  type="button"
                  aria-expanded={projectIsActive}
                  onClick={() => setSelectedProjectId(project.id)}
                  disabled={turnIsActive}
                >
                  <span className="project-icon"><Icon name="folder" size={15} /></span>
                  <span className="project-row-copy">
                    <strong>{project.name}</strong>
                    <small>{project.description ?? 'No description'}</small>
                  </span>
                  <span className="tree-chevron"><Icon name="chevron" size={12} /></span>
                </button>

                {projectIsActive && (
                  <div className="workspace-tree" role="group" aria-label={`${project.name} workspaces`}>
                    {workspaces.length === 0 && (
                      <p className="tree-status" role="status">{workspacesStatus}</p>
                    )}
                    {workspaces.map((workspace) => {
                      const workspaceIsActive = workspace.id === selectedWorkspaceId;

                      return (
                        <div className="workspace-group" key={workspace.id}>
                          <button
                            className="workspace-row"
                            data-active={workspaceIsActive || undefined}
                            type="button"
                            aria-expanded={workspaceIsActive}
                            title={workspace.root_path}
                            onClick={() => setSelectedWorkspaceId(workspace.id)}
                            disabled={turnIsActive}
                          >
                            <span className="workspace-icon"><Icon name="folder" size={14} /></span>
                            <span>{workspace.name}</span>
                            <span className="tree-chevron"><Icon name="chevron" size={11} /></span>
                          </button>

                          {workspaceIsActive && (
                            <div className="session-list" role="group" aria-label={`${workspace.name} sessions`}>
                              {isNewConversation && (
                                <button
                                  className="session-row"
                                  data-active
                                  type="button"
                                  onClick={startNewConversation}
                                  disabled={turnIsActive}
                                >
                                  <span className="session-icon"><Icon name="message" size={13} /></span>
                                  <span>New conversation</span>
                                </button>
                              )}
                              {agentSessions.length === 0 && !isNewConversation && (
                                <p className="tree-status" role="status">{sessionsStatus}</p>
                              )}
                              {agentSessions.map((agentSession) => (
                                <button
                                  className="session-row"
                                  data-active={agentSession.id === selectedSessionId || undefined}
                                  type="button"
                                  key={agentSession.id}
                                  onClick={() => selectStoredSession(agentSession.id)}
                                  disabled={turnIsActive}
                                >
                                  <span className="session-icon"><Icon name="message" size={13} /></span>
                                  <span>{agentSession.title}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {projects.length === 0 && (
            <p className="sidebar-empty">No projects yet.</p>
          )}
        </nav>

        <div className="sidebar-footer">
          <span className={`status-dot status-dot--${statusTone(apiStatus)}`} />
          <span className="sidebar-footer-copy">
            <strong>Local system</strong>
            <small>{apiStatus}</small>
          </span>
          <button type="button" aria-label="Check system readiness" onClick={checkApi}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </aside>

      <main className="agent-area">
        <header className="agent-header">
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-label="Open navigation"
            onClick={() => setIsSidebarOpen(true)}
          >
            <Icon name="menu" size={17} />
          </button>
          <div className="agent-title">
            <div>
              <strong>{activeConversationTitle}</strong>
              <small>
                {selectedWorkspace === null
                  ? 'Select a workspace'
                  : `${selectedWorkspace.name} · ${turnStatus}`}
              </small>
            </div>
          </div>
          <div className="header-actions">
            <span className="model-chip">{selectedModelOption?.label ?? 'Model not selected'}</span>
            <details className="system-menu">
              <summary className="icon-button" aria-label="Open system status" title="System status">
                <span className={`status-dot status-dot--${statusTone(apiStatus)}`} />
                <Icon name="terminal" size={15} />
              </summary>
              <div className="system-popover">
                <div className="system-popover-heading">
                  <div>
                    <strong>System status</strong>
                    <small>API and stored data</small>
                  </div>
                  <button className="icon-button" type="button" aria-label="Refresh project data" onClick={loadProjects} disabled={turnIsActive}>
                    <Icon name="refresh" size={14} />
                  </button>
                </div>
                <ActivityRow
                  title="System readiness"
                  detail={apiStatus}
                  endpoint="/api/v1/ready"
                  tone={statusTone(apiStatus)}
                />
                <ActivityRow
                  title="Projects"
                  detail={projectsStatus}
                  endpoint="/api/v1/projects"
                  tone={statusTone(projectsStatus)}
                />
                {selectedWorkspaceId && (
                  <ActivityRow
                    title="Conversations"
                    detail={sessionsStatus}
                    endpoint={`/api/v1/workspaces/${selectedWorkspaceId}/sessions`}
                    tone={statusTone(sessionsStatus)}
                  />
                )}
                <button className="system-check-button" type="button" onClick={() => void checkApi()}>
                  <Icon name="refresh" size={13} />
                  Check connection
                </button>
              </div>
            </details>
          </div>
        </header>

        <section
          ref={conversationRef}
          className="conversation"
          aria-label="Agent conversation"
          onScroll={(event) => {
            const scrollport = event.currentTarget;
            const isNearBottom = scrollport.scrollHeight
              - scrollport.scrollTop
              - scrollport.clientHeight < 80;
            followConversationRef.current = isNearBottom;
            setShowScrollToBottom(!isNearBottom);
          }}
        >
          <div className="conversation-column">
            {!conversationIsReady ? (
              <div className="setup-state">
                <span className="setup-logo">
                  <img className="product-logo" src="/clean-code-logo.png" alt="" />
                </span>
                <p className="eyebrow">Local agent workspace</p>
                <h1>
                  {selectedProject === null
                    ? 'Create a project to begin'
                    : selectedWorkspace === null
                      ? 'Connect a workspace folder'
                      : 'Choose a conversation'}
                </h1>
                <p>
                  {selectedProject === null
                    ? 'A project groups the workspaces and conversations that belong together.'
                    : selectedWorkspace === null
                      ? 'The workspace root gives the agent an explicit folder for its work.'
                      : 'Open a stored conversation or start a new one.'}
                </p>
                {selectedProject === null ? (
                  <button className="button button--primary setup-action" type="button" onClick={() => setIsProjectFormOpen(true)}>
                    <Icon name="plus" size={14} />
                    New project
                  </button>
                ) : selectedWorkspace === null ? (
                  <button className="button button--primary setup-action" type="button" onClick={() => setIsWorkspaceFormOpen(true)}>
                    <Icon name="folder" size={14} />
                    Add workspace
                  </button>
                ) : (
                  <button className="button button--primary setup-action" type="button" onClick={startNewConversation}>
                    <Icon name="message" size={14} />
                    New chat
                  </button>
                )}
              </div>
            ) : messagesStatus.startsWith('Loading') && messages.length === 0 ? (
              <div className="conversation-loading" role="status">
                <span />
                <span />
                <span />
              </div>
            ) : messages.length === 0 && activeTurn === null && liveAssistantText.length === 0 ? (
              <div className="empty-conversation">
                <span className="empty-logo">
                  <img className="product-logo" src="/clean-code-logo.png" alt="" />
                </span>
                <h1>What can I help you build?</h1>
                <p>{selectedWorkspace?.name} · Your conversation is stored in PostgreSQL.</p>
                <div className="prompt-suggestions" aria-label="Prompt suggestions">
                  {[
                    'Explain the structure of this codebase',
                    'Help me plan the next feature',
                    'Review a technical decision with me',
                  ].map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion}
                      onClick={() => {
                        setDraft(suggestion);
                        composerRef.current?.focus();
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message) => {
                  const isUser = message.role === 'user';
                  const text = messageText(message) || 'Empty text message';

                  return (
                    <article className="transcript-message" data-role={message.role} key={message.id}>
                      {!isUser && (
                        <span className="message-author-mark">
                          <img className="product-logo" src="/clean-code-logo.png" alt="" />
                        </span>
                      )}
                      <div className="message-body">
                        {isUser
                          ? <UserMessageContent text={text} />
                          : <AssistantMessageContent text={text} />}
                        <footer className="message-actions">
                          <time dateTime={message.created_at}>
                            {new Date(message.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                          <CopyMessageButton text={text} />
                        </footer>
                      </div>
                    </article>
                  );
                })}
                {(activeTurn !== null || liveAssistantText.length > 0) && (
                  <article
                    className="transcript-message transcript-message--live"
                    data-role="assistant"
                    aria-live="polite"
                  >
                    <span className="message-author-mark">
                      <img className="product-logo" src="/clean-code-logo.png" alt="" />
                    </span>
                    <div className="message-body">
                      <div className="live-state">
                        <span className="thinking-dot" />
                        {turnStatus}
                      </div>
                      {liveAssistantText.length > 0 ? (
                        <>
                          <AssistantMessageContent text={liveAssistantText} />
                          {activeTurn !== null && !isStopping && (
                            <span className="stream-cursor" aria-hidden="true" />
                          )}
                        </>
                      ) : (
                        <div className="thinking-indicator" aria-label="Clean Code is thinking">
                          <span />
                          <span />
                          <span />
                        </div>
                      )}
                    </div>
                  </article>
                )}
              </div>
            )}
          </div>
        </section>

        {showScrollToBottom && (
          <button
            className="scroll-to-bottom"
            type="button"
            aria-label="Scroll to latest message"
            onClick={() => {
              const conversation = conversationRef.current;

              if (conversation === null) return;

              followConversationRef.current = true;
              conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
              setShowScrollToBottom(false);
            }}
          >
            <Icon name="arrow-down" size={16} />
          </button>
        )}

        <footer className="composer-wrap">
          <form className="composer" aria-label="Agent composer" onSubmit={sendMessage}>
            <textarea
              ref={composerRef}
              aria-label="Agent request"
              placeholder={composerPlaceholder}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                window.setTimeout(() => {
                  composingRef.current = false;
                }, 10);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                if (event.nativeEvent.isComposing || composingRef.current) return;

                event.preventDefault();

                if (!event.repeat && canSend) {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              disabled={!conversationIsReady}
              readOnly={turnIsActive}
            />
            <div className="composer-toolbar">
              <div className="composer-options">
                <button type="button" className="composer-icon-button" disabled aria-label="Add context">
                  <Icon name="plus" size={16} />
                </button>
                <div className="model-picker" ref={modelMenuRef}>
                  <button
                    type="button"
                    className="model-trigger"
                    aria-label="Select model"
                    aria-haspopup="listbox"
                    aria-expanded={isModelMenuOpen}
                    onClick={() => setIsModelMenuOpen((isOpen) => !isOpen)}
                    disabled={!conversationIsReady || turnIsActive}
                  >
                    <span>{selectedModelOption?.label ?? 'Select model'}</span>
                    <span className="model-trigger-chevron">
                      <Icon name="chevron" size={12} />
                    </span>
                  </button>

                  {isModelMenuOpen && (
                    <div className="model-menu">
                      <input
                        className="model-search"
                        type="text"
                        value={modelSearch}
                        onChange={(event) => setModelSearch(event.target.value)}
                        placeholder="Search models"
                        aria-label="Search models"
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                      />
                      <div className="model-menu-heading">Models</div>
                      <div className="model-option-list" role="listbox" aria-label="Configured models">
                        {filteredModels.map((modelOption) => {
                          const isSelected = selectedModelOption?.providerId === modelOption.providerId
                            && selectedModelOption.modelId === modelOption.modelId;

                          return (
                            <button
                              type="button"
                              className="model-option"
                              data-selected={isSelected || undefined}
                              role="option"
                              aria-selected={isSelected}
                              key={`${modelOption.providerId}:${modelOption.modelId}`}
                              onClick={() => {
                                setSelectedModel({
                                  providerId: modelOption.providerId,
                                  modelId: modelOption.modelId,
                                });
                                setIsModelMenuOpen(false);
                                setModelSearch('');
                              }}
                            >
                              <span className="model-option-copy">
                                <strong>{modelOption.label}</strong>
                                <small>{modelOption.providerLabel}</small>
                              </span>
                              {isSelected && <Icon name="check" size={14} />}
                            </button>
                          );
                        })}
                        {filteredModels.length === 0 && (
                          <p className="model-menu-empty">
                            {configuredModels.length === 0
                              ? modelsStatus
                              : 'No matching models'}
                          </p>
                        )}
                      </div>
                      <div className="model-menu-footer">
                        <span>{modelsStatus}</span>
                        <button
                          type="button"
                          onClick={() => void loadModels()}
                          aria-label="Reload model catalog"
                        >
                          <Icon name="refresh" size={13} />
                          Reload
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {activeTurn !== null ? (
                <button
                  type="button"
                  className="send-button send-button--stop"
                  aria-label="Stop response"
                  onClick={() => void stopAgent()}
                  disabled={isStopping}
                >
                  <Icon name="stop" size={16} />
                </button>
              ) : isSubmitting ? (
                <button type="button" className="send-button send-button--loading" disabled aria-label={turnStatus}>
                  <span className="button-spinner" />
                </button>
              ) : (
                <button type="submit" className="send-button" disabled={!canSend} aria-label="Send message">
                  <Icon name="arrow-up" size={17} />
                </button>
              )}
            </div>
          </form>
          <div className="composer-feedback" data-error={turnError !== null || undefined} role="status">
            <span>
              {turnError
                ?? (conversationIsReady
                  ? `${turnStatus} · Enter to send, Shift+Enter for a new line`
                  : 'Choose a project and workspace to start a conversation.')}
            </span>
            {retryTurn !== null && activeTurn === null && (
              <button type="button" onClick={() => void retryAgentResponse()} disabled={isSubmitting}>
                <Icon name="refresh" size={12} />
                Try response again
              </button>
            )}
            {turnError !== null && retryTurn === null && (
              <button type="button" onClick={() => setTurnError(null)}>
                Dismiss
              </button>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}

export default App;
