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
  type RunEventResponse,
  type WorkspaceResponse,
} from './api';
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
};

const MODEL_OPTIONS = [
  {
    key: 'anthropic:claude-haiku-4-5-20251001',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
  },
] as const;

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

type IconName =
  | 'arrow-up'
  | 'check'
  | 'chevron'
  | 'folder'
  | 'message'
  | 'plus'
  | 'refresh'
  | 'stop'
  | 'terminal';

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    'arrow-up': <path d="m6 9 6-6 6 6M12 3v14" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    folder: <path d="M3 7.5h6l2-2h10v13H3z" />,
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
  const [agentSessions, setAgentSessions] = useState<AgentSessionResponse[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState('Sessions not loaded');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [messagesStatus, setMessagesStatus] = useState('Messages not loaded');
  const [draft, setDraft] = useState('');
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [runEvents, setRunEvents] = useState<RunEventResponse[]>([]);
  const [turnStatus, setTurnStatus] = useState('Ready');
  const [turnError, setTurnError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const conversationRef = useRef<HTMLElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const followConversationRef = useRef(true);

  async function checkApi() {
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
  }

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
    void loadProjects();
  }, [loadProjects]);

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
    followConversationRef.current = true;

    if (selectedSessionId === null) {
      setMessagesStatus('Select a session');
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
      setMessages(data);
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
  }, [selectedSessionId]);

  useEffect(() => {
    if (followConversationRef.current) {
      conversationEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, runEvents]);

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

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    const selectedModel = MODEL_OPTIONS.find(
      (modelOption) => modelOption.key === selectedModelKey,
    );

    if (
      text.length === 0
      || selectedSessionId === null
      || selectedModel === undefined
      || activeTurn !== null
      || isSubmitting
    ) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    setIsSubmitting(true);
    setTurnStatus('Sending message...');
    setTurnError(null);
    setRunEvents([]);
    followConversationRef.current = true;

    try {
      const userMessage = await postApiJson<MessageResponse>(
        `/api/v1/sessions/${selectedSessionId}/messages`,
        { text },
        controller.signal,
      );

      setMessages((currentMessages) => [...currentMessages, userMessage]);
      setMessagesStatus('Message sent');
      setDraft('');
      setTurnStatus('Creating run...');

      const run = await postApiJson<AgentRunResponse>(
        `/api/v1/sessions/${selectedSessionId}/runs`,
        {
          trigger_message_id: userMessage.id,
          model_provider: selectedModel.provider,
          model_name: selectedModel.model,
        },
        controller.signal,
      );

      await postApiJson<AgentRunResponse>(
        `/api/v1/runs/${run.id}/execute`,
        {
          max_output_tokens: 1024,
          max_steps: 8,
        },
        controller.signal,
      );

      setTurnStatus('Starting...');
      setActiveTurn({
        runId: run.id,
        sessionId: selectedSessionId,
      });
    } catch (error) {
      setTurnStatus('Send failed');
      setTurnError(requestErrorMessage(error));
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
  const selectedModel = MODEL_OPTIONS.find(
    (modelOption) => modelOption.key === selectedModelKey,
  );
  const liveAssistantText = runEventText(runEvents);
  const turnIsActive = isSubmitting || activeTurn !== null;
  const canSend = selectedSession !== null
    && selectedModel !== undefined
    && draft.trim().length > 0
    && !turnIsActive;

  const composerPlaceholder = selectedProject === null
    ? 'Select a project to continue'
    : selectedWorkspace === null
      ? 'Select a workspace to continue'
      : selectedSession === null
        ? 'Select a session to continue'
        : selectedModel === undefined
          ? 'Select a model to start'
          : turnIsActive
            ? 'Wait for the current response'
            : 'Ask Clean Code anything';

  return (
    <div className="app-shell">
      <aside className="sidebar">
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
        </div>

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

        <div className="sidebar-section-heading">
          <span>Projects</span>
          <button type="button" aria-label="Reload projects" onClick={loadProjects} disabled={turnIsActive}>
            <Icon name="refresh" size={14} />
          </button>
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
                              {agentSessions.length === 0 && (
                                <p className="tree-status" role="status">{sessionsStatus}</p>
                              )}
                              {agentSessions.map((agentSession) => (
                                <button
                                  className="session-row"
                                  data-active={agentSession.id === selectedSessionId || undefined}
                                  type="button"
                                  key={agentSession.id}
                                  onClick={() => setSelectedSessionId(agentSession.id)}
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
          <div className="agent-title">
            <span className="agent-title-icon"><Icon name="folder" size={15} /></span>
            <div>
              <strong>{selectedSession?.title ?? selectedProject?.name ?? 'No project selected'}</strong>
              <small>{selectedWorkspace?.name ?? 'Agent'}</small>
            </div>
          </div>
          <div className="header-actions">
            <span className="model-chip">{selectedModel?.label ?? 'Model not selected'}</span>
            <button className="icon-button" type="button" aria-label="Refresh project data" onClick={loadProjects} disabled={turnIsActive}>
              <Icon name="refresh" size={15} />
            </button>
          </div>
        </header>

        <section
          ref={conversationRef}
          className="conversation"
          aria-label="Agent conversation"
          onScroll={(event) => {
            const scrollport = event.currentTarget;
            followConversationRef.current = scrollport.scrollHeight
              - scrollport.scrollTop
              - scrollport.clientHeight < 80;
          }}
        >
          <div className="conversation-column">
            {selectedSession === null ? (
              <div className="assistant-message">
                <span className="assistant-mark">
                  <img className="product-logo" src="/clean-code-logo.png" alt="" />
                </span>
                <div className="assistant-content">
                  <p className="eyebrow">Workspace overview</p>
                  <h1>
                    {selectedWorkspace
                      ? `Choose a session in ${selectedWorkspace.name}`
                      : selectedProject
                        ? `Choose a workspace in ${selectedProject.name}`
                        : 'Choose a project to begin'}
                  </h1>
                  <p>
                    {selectedProject?.description
                      ?? 'Create or select a project from the sidebar. The existing project and readiness APIs remain active in this shell.'}
                  </p>
                  {selectedProject && (
                    <p className="message-meta">
                      Created {new Date(selectedProject.created_at).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="session-transcript">
                <div className="session-context">
                  <p className="eyebrow">Stored session</p>
                  <h1>{selectedSession.title}</h1>
                  <p>{selectedWorkspace?.root_path}</p>
                </div>

                {messages.length === 0 && activeTurn === null && liveAssistantText.length === 0 ? (
                  <p className="transcript-status" role="status">{messagesStatus}</p>
                ) : (
                  <div className="message-list">
                    {messages.map((message) => {
                      const isUser = message.role === 'user';

                      return (
                        <article className="transcript-message" data-role={message.role} key={message.id}>
                          <span className="message-author-mark">
                            {isUser
                              ? 'Y'
                              : <img className="product-logo" src="/clean-code-logo.png" alt="" />}
                          </span>
                          <div className="message-body">
                            <header>
                              <strong>{isUser ? 'You' : 'Clean Code'}</strong>
                              <time dateTime={message.created_at}>
                                {new Date(message.created_at).toLocaleString()}
                              </time>
                            </header>
                            <p>{messageText(message) || 'Empty text message'}</p>
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
                          <header>
                            <strong>Clean Code</strong>
                            <span className="generation-state">{turnStatus}</span>
                          </header>
                          <p>
                            {liveAssistantText || 'Thinking'}
                            {activeTurn !== null && !isStopping && (
                              <span className="stream-cursor" aria-hidden="true" />
                            )}
                          </p>
                        </div>
                      </article>
                    )}
                  </div>
                )}
                <div ref={conversationEndRef} />
              </div>
            )}

            <div className="activity-group" aria-label="System activity">
              <p className="activity-label">System activity</p>
              <ActivityRow
                title="System readiness"
                detail={apiStatus}
                endpoint="/api/v1/ready"
                tone={statusTone(apiStatus)}
              />
              <ActivityRow
                title="List projects"
                detail={projectsStatus}
                endpoint="/api/v1/projects"
                tone={statusTone(projectsStatus)}
              />
              {selectedProjectId && (
                <ActivityRow
                  title="List workspaces"
                  detail={workspacesStatus}
                  endpoint={`/api/v1/projects/${selectedProjectId}/workspaces`}
                  tone={statusTone(workspacesStatus)}
                />
              )}
              {selectedWorkspaceId && (
                <ActivityRow
                  title="List sessions"
                  detail={sessionsStatus}
                  endpoint={`/api/v1/workspaces/${selectedWorkspaceId}/sessions`}
                  tone={statusTone(sessionsStatus)}
                />
              )}
              {selectedSessionId && (
                <ActivityRow
                  title="Load messages"
                  detail={messagesStatus}
                  endpoint={`/api/v1/sessions/${selectedSessionId}/messages`}
                  tone={statusTone(messagesStatus)}
                />
              )}
            </div>
          </div>
        </section>

        <footer className="composer-wrap">
          <form className="composer" aria-label="Agent composer" onSubmit={sendMessage}>
            <textarea
              aria-label="Agent request"
              placeholder={composerPlaceholder}
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();

                  if (canSend) {
                    event.currentTarget.form?.requestSubmit();
                  }
                }
              }}
              disabled={selectedSession === null}
              readOnly={turnIsActive}
            />
            <div className="composer-toolbar">
              <div className="composer-options">
                <button type="button" className="composer-icon-button" disabled aria-label="Add context">
                  <Icon name="plus" size={16} />
                </button>
                <select
                  className="model-select"
                  aria-label="Model"
                  value={selectedModelKey}
                  onChange={(event) => setSelectedModelKey(event.target.value)}
                  disabled={selectedSession === null || turnIsActive}
                >
                  <option value="">Select model</option>
                  {MODEL_OPTIONS.map((modelOption) => (
                    <option value={modelOption.key} key={modelOption.key}>
                      {modelOption.label}
                    </option>
                  ))}
                </select>
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
              ) : (
                <button type="submit" className="send-button" disabled={!canSend} aria-label="Send message">
                  <Icon name="arrow-up" size={17} />
                </button>
              )}
            </div>
          </form>
          <p className="composer-note" data-error={turnError !== null || undefined} role="status">
            {turnError
              ?? (selectedSession
                ? `${turnStatus} · Enter to send, Shift+Enter for a new line`
                : 'Select a stored session to load its message history.')}
          </p>
        </footer>
      </main>
    </div>
  );
}

export default App;
