import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  deleteApi,
  getApiJson,
  patchApiJson,
  postApi,
  postApiJson,
  type AgentRunResponse,
  type AgentSessionResponse,
  type MessageResponse,
  type ModelCatalogResponse,
  type RunEventResponse,
  type ToolApprovalResponse,
  type WorkspaceResponse,
} from './api';
import {
  AssistantMessageContent,
  UserMessageContent,
} from './MessageContent';
import { CleanCodeLogo } from './components/CleanCodeLogo';
import { ConversationSearchBar } from './components/ConversationSearchBar';
import { GlobalSearchDialog } from './components/GlobalSearchDialog';
import { ChangesPanel } from './components/ChangesView';
import { highlightMatch } from './utils/highlightMatch';
import { messageSearchText } from './utils/transcriptSearch';
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

type ManagedResource = {
  kind: 'project' | 'session';
  id: string;
  label: string;
};

type ResourceActionMenu = Pick<ManagedResource, 'kind' | 'id'>;

type ManagementDialog = ManagedResource & {
  action: 'rename' | 'delete';
};

type ToolApprovalDecision = 'approved' | 'rejected';

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 440;
const SIDEBAR_DEFAULT_WIDTH = 252;
const MAIN_CONTENT_MIN_WIDTH = 520;
const SIDEBAR_KEYBOARD_STEP = 16;
const MANAGEMENT_TRANSITION_MS = 180;

function interfaceTransitionDuration(): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : MANAGEMENT_TRANSITION_MS;
}

function waitForInterfaceTransition(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, interfaceTransitionDuration());
  });
}

function maximumSidebarWidth(): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - MAIN_CONTENT_MIN_WIDTH),
  );
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    maximumSidebarWidth(),
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

type IconName =
  | 'arrow-up'
  | 'arrow-down'
  | 'check'
  | 'changes'
  | 'chevron'
  | 'close'
  | 'copy'
  | 'folder'
  | 'menu'
  | 'message'
  | 'more'
  | 'pencil'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'stop'
  | 'terminal'
  | 'trash';

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    'arrow-up': <path d="m6 9 6-6 6 6M12 3v14" />,
    'arrow-down': <path d="m6 9 6 6 6-6" />,
    check: <path d="m5 12 4 4L19 6" />,
    changes: <><path d="M8 4h8M8 20h8M6 8v8M18 8v8" /><rect x="3" y="8" width="6" height="8" rx="1" /><path d="M5.5 11h1M5.5 13h1" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    copy: <path d="M9 9h10v10H9zM5 15H4V5h10v1" />,
    folder: <path d="M3 7.5h6l2-2h10v13H3z" />,
    menu: <path d="M5 7h14M5 12h14M5 17h14" />,
    message: <path d="M4 5h16v12H8l-4 3z" />,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
    pencil: <path d="m4 20 4.2-1 10.6-10.6-3.2-3.2L5 15.8 4 20ZM13.8 7l3.2 3.2" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.7-1.9L20 8M4 16l2.2 1.9A7 7 0 0 0 17.9 16" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m15 15 4 4" /></>,
    terminal: <path d="m5 7 4 4-4 4M11 16h8" />,
    trash: <path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M6 7l1 14h10l1-14" />,
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

function approvalActionLabel(toolName: string): string {
  if (toolName === 'write_file') return 'Create a new file';
  if (toolName === 'edit_file') return 'Edit an existing file';

  return `Run ${toolName}`;
}

function approvalTargetPath(approval: ToolApprovalResponse): string | null {
  const path = approval.arguments.path;
  return typeof path === 'string' ? path : null;
}

function ApprovalPanel({
  approval,
  answeringDecision,
  isStopping,
  error,
  onDecision,
  onStop,
}: {
  approval: ToolApprovalResponse;
  answeringDecision: ToolApprovalDecision | null;
  isStopping: boolean;
  error: string | null;
  onDecision: (decision: ToolApprovalDecision) => void;
  onStop: () => void;
}) {
  const targetPath = approvalTargetPath(approval);
  const isAnswering = answeringDecision !== null;

  return (
    <section className="approval-panel" aria-labelledby="approval-title">
      <div className="approval-strip">
        <span className="approval-strip-label">
          <span className="approval-dot" />
          Waiting for approval
        </span>
        <button
          type="button"
          className="approval-stop"
          aria-label="Stop response"
          title="Stop response"
          onClick={onStop}
          disabled={isStopping || isAnswering}
        >
          <Icon name="stop" size={13} />
        </button>
      </div>
      <div className="approval-body">
        <div className="approval-heading">
          <span className="approval-tool-icon">
            <Icon name="terminal" size={14} />
          </span>
          <div>
            <strong id="approval-title">
              {approvalActionLabel(approval.tool_name)}
            </strong>
            <small>{approval.reason}</small>
          </div>
        </div>
        {targetPath !== null && (
          <code className="approval-target">{targetPath}</code>
        )}
        <pre
          className="approval-arguments"
          tabIndex={0}
          aria-label="Exact tool arguments"
        >
          {JSON.stringify(approval.arguments, null, 2)}
        </pre>
        {error !== null && (
          <p className="approval-error" role="alert">{error}</p>
        )}
      </div>
      <div className="approval-actions">
        <button
          type="button"
          className="button approval-reject"
          onClick={() => onDecision('rejected')}
          disabled={isAnswering || isStopping}
        >
          {answeringDecision === 'rejected'
            ? <span className="button-spinner" />
            : <Icon name="close" size={13} />}
          Reject
        </button>
        <button
          type="button"
          className="button button--primary approval-allow"
          onClick={() => onDecision('approved')}
          disabled={isAnswering || isStopping}
        >
          {answeringDecision === 'approved'
            ? <span className="button-spinner" />
            : <Icon name="check" size={13} />}
          Allow once
        </button>
      </div>
    </section>
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
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [workspacesStatus, setWorkspacesStatus] = useState('Workspaces not loaded');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(null);
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
  const [pendingToolApprovals, setPendingToolApprovals] = useState<ToolApprovalResponse[]>([]);
  const [answeringApproval, setAnsweringApproval] = useState<{
    id: string;
    decision: ToolApprovalDecision;
  } | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [turnStatus, setTurnStatus] = useState('Ready');
  const [turnError, setTurnError] = useState<string | null>(null);
  const [retryTurn, setRetryTurn] = useState<RetryTurn | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [resourceActionMenu, setResourceActionMenu] = useState<ResourceActionMenu | null>(null);
  const [managementDialog, setManagementDialog] = useState<ManagementDialog | null>(null);
  const [managementValue, setManagementValue] = useState('');
  const [managementStatus, setManagementStatus] = useState('');
  const [isManagingResource, setIsManagingResource] = useState(false);
  const [isManagementDialogClosing, setIsManagementDialogClosing] = useState(false);
  const [removingResource, setRemovingResource] = useState<ResourceActionMenu | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [isConversationSearchOpen, setIsConversationSearchOpen] = useState(false);
  const [isChangesPanelOpen, setIsChangesPanelOpen] = useState(true);
  const [conversationSearchQuery, setConversationSearchQuery] = useState('');
  const [conversationSearchActiveId, setConversationSearchActiveId] = useState<string | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const followConversationRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const resourceActionMenuRef = useRef<HTMLDivElement | null>(null);
  const managementDialogCloseTimerRef = useRef<number | null>(null);
  const sidebarResizeRef = useRef({
    pointerId: null as number | null,
    startX: 0,
    startWidth: SIDEBAR_DEFAULT_WIDTH,
    latestX: 0,
  });
  const sidebarResizeFrameRef = useRef<number | null>(null);

  const closeManagementDialog = useCallback(() => {
    if (
      managementDialog === null
      || isManagingResource
      || isManagementDialogClosing
    ) return;

    setIsManagementDialogClosing(true);
    managementDialogCloseTimerRef.current = window.setTimeout(() => {
      setManagementDialog(null);
      setManagementStatus('');
      setIsManagementDialogClosing(false);
      setRemovingResource(null);
      managementDialogCloseTimerRef.current = null;
    }, interfaceTransitionDuration());
  }, [isManagementDialogClosing, isManagingResource, managementDialog]);

  useEffect(() => () => {
    if (managementDialogCloseTimerRef.current !== null) {
      window.clearTimeout(managementDialogCloseTimerRef.current);
    }
  }, []);

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
    if (resourceActionMenu === null) return undefined;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !resourceActionMenuRef.current?.contains(event.target)
      ) {
        setResourceActionMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setResourceActionMenu(null);
      }
    };

    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [resourceActionMenu]);

  useEffect(() => {
    if (managementDialog === null) return undefined;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeManagementDialog();
      }
    };

    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeManagementDialog, managementDialog]);

  useEffect(() => {
    const keepSidebarInRange = () => {
      if (window.innerWidth <= 760) return;

      setSidebarWidth((currentWidth) => clampSidebarWidth(currentWidth));
    };

    window.addEventListener('resize', keepSidebarInRange);

    return () => {
      window.removeEventListener('resize', keepSidebarInRange);

      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
    setExpandedWorkspaceId(null);
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
    setPendingToolApprovals([]);
    setAnsweringApproval(null);
    setApprovalError(null);
  }, [activeTurn]);

  useEffect(() => {
    const conversation = conversationRef.current;

    if (!followConversationRef.current || conversation === null) return;

    window.requestAnimationFrame(() => {
      conversation.scrollTop = conversation.scrollHeight;
      setShowScrollToBottom(false);
    });
  }, [activeTurn, messages, runEvents]);

  useEffect(() => {
    if (conversationSearchActiveId === null) return;
    const el = document.getElementById(`msg-${conversationSearchActiveId}`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [conversationSearchActiveId]);

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
        const [run, events, approvals] = await Promise.all([
          getApiJson<AgentRunResponse>(
            `/api/v1/runs/${activeTurn.runId}`,
            requestController.signal,
          ),
          getApiJson<RunEventResponse[]>(
            `/api/v1/runs/${activeTurn.runId}/events`,
            requestController.signal,
          ),
          getApiJson<ToolApprovalResponse[]>(
            `/api/v1/runs/${activeTurn.runId}/approvals`,
            requestController.signal,
          ),
        ]);

        if (!active) return;

        setRunEvents(events);
        setPendingToolApprovals(approvals);
        setAnsweringApproval((currentApproval) => (
          currentApproval !== null
          && approvals.some((approval) => approval.id === currentApproval.id)
            ? currentApproval
            : null
        ));

        if (approvals.length === 0) {
          setApprovalError(null);
        }

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
          setPendingToolApprovals([]);
          setAnsweringApproval(null);
          setApprovalError(null);
          setIsStopping(false);
          return;
        }

        setTurnStatus(
          isStopping
            ? 'Stopping...'
            : approvals.length > 0
              ? 'Waiting for approval...'
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

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setExpandedProjectId(projectId);
    setResourceActionMenu(null);
  }

  function toggleProject(projectId: string) {
    if (expandedProjectId === projectId) {
      setExpandedProjectId(null);
      return;
    }

    setSelectedProjectId(projectId);
    setExpandedProjectId(projectId);
  }

  function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    setExpandedWorkspaceId(workspaceId);
    setResourceActionMenu(null);
  }

  function toggleWorkspace(workspaceId: string) {
    if (expandedWorkspaceId === workspaceId) {
      setExpandedWorkspaceId(null);
      return;
    }

    setSelectedWorkspaceId(workspaceId);
    setExpandedWorkspaceId(workspaceId);
  }

  function toggleResourceActionMenu(kind: ManagedResource['kind'], id: string) {
    setResourceActionMenu((currentMenu) => (
      currentMenu?.kind === kind && currentMenu.id === id
        ? null
        : { kind, id }
    ));
  }

  function openManagementDialog(
    resource: ManagedResource,
    action: ManagementDialog['action'],
  ) {
    if (managementDialogCloseTimerRef.current !== null) {
      window.clearTimeout(managementDialogCloseTimerRef.current);
      managementDialogCloseTimerRef.current = null;
    }

    setResourceActionMenu(null);
    setManagementDialog({ ...resource, action });
    setManagementValue(resource.label);
    setManagementStatus('');
    setIsManagementDialogClosing(false);
    setRemovingResource(null);
  }

  async function manageResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      managementDialog === null
      || isManagingResource
      || isManagementDialogClosing
      || activeTurn !== null
      || isSubmitting
    ) return;

    const nextLabel = managementValue.trim();

    if (managementDialog.action === 'rename' && nextLabel.length === 0) {
      setManagementStatus('Enter a name.');
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);
    setIsManagingResource(true);
    setManagementStatus(
      managementDialog.action === 'rename' ? 'Renaming...' : 'Deleting...',
    );

    let updatedProject: ProjectResponse | null = null;
    let updatedSession: AgentSessionResponse | null = null;
    let remainingProjects: ProjectResponse[] | null = null;
    let remainingSessions: AgentSessionResponse[] | null = null;

    try {
      if (managementDialog.action === 'rename') {
        if (managementDialog.kind === 'project') {
          updatedProject = await patchApiJson<ProjectResponse>(
            `/api/v1/projects/${managementDialog.id}`,
            { name: nextLabel },
            controller.signal,
          );
        } else {
          updatedSession = await patchApiJson<AgentSessionResponse>(
            `/api/v1/sessions/${managementDialog.id}`,
            { title: nextLabel },
            controller.signal,
          );
        }
      } else if (managementDialog.kind === 'project') {
        await deleteApi(
          `/api/v1/projects/${managementDialog.id}`,
          controller.signal,
        );

        remainingProjects = projects.filter(
          (project) => project.id !== managementDialog.id,
        );
      } else {
        await deleteApi(
          `/api/v1/sessions/${managementDialog.id}`,
          controller.signal,
        );

        remainingSessions = agentSessions.filter(
          (agentSession) => agentSession.id !== managementDialog.id,
        );
      }

      if (managementDialog.action === 'delete') {
        setRemovingResource({
          kind: managementDialog.kind,
          id: managementDialog.id,
        });
      }

      setIsManagementDialogClosing(true);
      await waitForInterfaceTransition();

      if (updatedProject !== null) {
        const projectUpdate = updatedProject;

        setProjects((currentProjects) => currentProjects.map((project) => (
          project.id === projectUpdate.id ? projectUpdate : project
        )));
        setProjectsStatus(`Renamed project to ${projectUpdate.name}`);
      } else if (updatedSession !== null) {
        const sessionUpdate = updatedSession;

        setAgentSessions((currentSessions) => currentSessions.map((agentSession) => (
          agentSession.id === sessionUpdate.id ? sessionUpdate : agentSession
        )));
        setSessionsStatus(`Renamed conversation to ${sessionUpdate.title}`);
      } else if (remainingProjects !== null) {
        setProjects(remainingProjects);
        setProjectsStatus(
          remainingProjects.length === 0
            ? 'No projects found'
            : `${remainingProjects.length} project${remainingProjects.length === 1 ? '' : 's'} loaded`,
        );

        if (selectedProjectId === managementDialog.id) {
          const nextProjectId = remainingProjects[0]?.id ?? null;

          setSelectedProjectId(nextProjectId);
          setExpandedProjectId(nextProjectId);
        } else if (expandedProjectId === managementDialog.id) {
          setExpandedProjectId(null);
        }
      } else if (remainingSessions !== null) {
        setAgentSessions(remainingSessions);
        setSessionsStatus(
          remainingSessions.length === 0
            ? 'No sessions found'
            : `${remainingSessions.length} session${remainingSessions.length === 1 ? '' : 's'} loaded`,
        );

        if (selectedSessionId === managementDialog.id) {
          const nextSessionId = remainingSessions[0]?.id ?? null;

          setSelectedSessionId(nextSessionId);
          setIsNewConversation(nextSessionId === null);
        }
      }

      setManagementDialog(null);
      setManagementStatus('');
      setIsManagementDialogClosing(false);
      setRemovingResource(null);
    } catch (error) {
      setIsManagementDialogClosing(false);
      setRemovingResource(null);
      setManagementStatus(
        `${managementDialog.action === 'rename' ? 'Rename' : 'Delete'} failed: ${requestErrorMessage(error)}`,
      );
    } finally {
      window.clearTimeout(timeoutId);
      setIsManagingResource(false);
    }
  }

  function updateSidebarWidthFromPointer() {
    sidebarResizeFrameRef.current = null;
    const resize = sidebarResizeRef.current;

    setSidebarWidth(clampSidebarWidth(
      resize.startWidth + resize.latestX - resize.startX,
    ));
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 760) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
      latestX: event.clientX,
    };
    setIsResizingSidebar(true);
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarResizeRef.current.pointerId !== event.pointerId) return;

    sidebarResizeRef.current.latestX = event.clientX;

    if (sidebarResizeFrameRef.current === null) {
      sidebarResizeFrameRef.current = window.requestAnimationFrame(
        updateSidebarWidthFromPointer,
      );
    }
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarResizeRef.current.pointerId !== event.pointerId) return;

    sidebarResizeRef.current.latestX = event.clientX;

    if (sidebarResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarResizeFrameRef.current);
    }

    updateSidebarWidthFromPointer();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    sidebarResizeRef.current.pointerId = null;
    setIsResizingSidebar(false);
  }

  function resizeSidebarWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;

    setSidebarWidth((currentWidth) => clampSidebarWidth(
      currentWidth + direction * SIDEBAR_KEYBOARD_STEP,
    ));
  }

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
      setExpandedProjectId(createdProject.id);
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
      setExpandedProjectId(selectedProjectId);
      setExpandedWorkspaceId(createdWorkspace.id);
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

  useEffect(() => {
    const handleSearchShortcuts = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // Global search: Ctrl+Shift+F / Cmd+Shift+F (like claude-code GlobalSearchDialog)
      if (isMod && event.shiftKey && key === 'f') {
        event.preventDefault();
        if (selectedWorkspaceId !== null) setIsGlobalSearchOpen(true);
        return;
      }
      // Alternative: Ctrl+K for global search (common web)
      if (isMod && key === 'k') {
        event.preventDefault();
        if (selectedWorkspaceId !== null) setIsGlobalSearchOpen(true);
        return;
      }
      // Conversation search: Ctrl+F or '/' (like claude-code transcript search)
      if (isMod && key === 'f' && !event.shiftKey) {
        if (messages.length === 0) return;
        event.preventDefault();
        setIsConversationSearchOpen((v) => !v);
        return;
      }
      // '/' as vim/less incremental search when not typing in input/textarea
      if (
        key === '/' &&
        !isMod &&
        !event.shiftKey &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        messages.length > 0
      ) {
        event.preventDefault();
        setIsConversationSearchOpen(true);
      }
    };
    document.addEventListener('keydown', handleSearchShortcuts);
    return () => document.removeEventListener('keydown', handleSearchShortcuts);
  }, [messages.length, selectedWorkspaceId]);

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

  async function decideToolApproval(decision: ToolApprovalDecision) {
    const approval = pendingToolApprovals[0];

    if (
      activeTurn === null
      || approval === undefined
      || answeringApproval !== null
      || isStopping
    ) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    setAnsweringApproval({ id: approval.id, decision });
    setApprovalError(null);
    setTurnStatus(
      decision === 'approved'
        ? 'Applying approved action...'
        : 'Rejecting action...',
    );

    try {
      await postApi(
        `/api/v1/runs/${activeTurn.runId}/approvals/${approval.id}`,
        { decision },
        controller.signal,
      );
    } catch (error) {
      setAnsweringApproval(null);
      setApprovalError(
        `Approval response failed: ${requestErrorMessage(error)}`,
      );
      setTurnStatus('Waiting for approval...');
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
  const pendingApproval = pendingToolApprovals[0] ?? null;
  const answeringDecision = pendingApproval !== null
    && answeringApproval?.id === pendingApproval.id
    ? answeringApproval.decision
    : null;
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
    <div
      className="app-shell"
      data-resizing={isResizingSidebar || undefined}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
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
            <CleanCodeLogo
              size={24}
              status={
                activeTurn ? (liveAssistantText ? 'streaming' : 'thinking') : 'idle'
              }
            />
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
            const projectIsExpanded = project.id === expandedProjectId;
            const projectMenuIsOpen = resourceActionMenu?.kind === 'project'
              && resourceActionMenu.id === project.id;

            return (
              <div className="project-group" key={project.id}>
                <div
                  className="tree-row-shell project-row-shell"
                  data-active={projectIsActive || undefined}
                  data-expanded={projectIsExpanded || undefined}
                >
                  <button
                    className="project-row"
                    type="button"
                    aria-current={projectIsActive ? 'page' : undefined}
                    onClick={() => selectProject(project.id)}
                    disabled={turnIsActive || isManagingResource}
                  >
                    <span className="project-icon"><Icon name="folder" size={15} /></span>
                    <span className="project-row-copy">
                      <strong>{project.name}</strong>
                      <small>{project.description ?? 'No description'}</small>
                    </span>
                  </button>
                  <button
                    className="tree-toggle"
                    type="button"
                    aria-label={`${projectIsExpanded ? 'Collapse' : 'Expand'} ${project.name}`}
                    aria-expanded={projectIsExpanded}
                    onClick={() => toggleProject(project.id)}
                    disabled={turnIsActive || isManagingResource}
                  >
                    <Icon name="chevron" size={12} />
                  </button>
                  <div
                    className="resource-action-anchor"
                    ref={projectMenuIsOpen ? resourceActionMenuRef : undefined}
                  >
                    <button
                      className="row-action-button"
                      type="button"
                      aria-label={`Actions for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={projectMenuIsOpen}
                      data-open={projectMenuIsOpen || undefined}
                      onClick={() => toggleResourceActionMenu('project', project.id)}
                      disabled={turnIsActive || isManagingResource}
                    >
                      <Icon name="more" size={15} />
                    </button>
                    {projectMenuIsOpen && (
                      <div className="resource-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => openManagementDialog(
                            { kind: 'project', id: project.id, label: project.name },
                            'rename',
                          )}
                        >
                          <Icon name="pencil" size={13} />
                          Rename project
                        </button>
                        <button
                          className="resource-menu-danger"
                          type="button"
                          role="menuitem"
                          onClick={() => openManagementDialog(
                            { kind: 'project', id: project.id, label: project.name },
                            'delete',
                          )}
                        >
                          <Icon name="trash" size={13} />
                          Delete project
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {projectIsExpanded && projectIsActive && (
                  <div className="workspace-tree" role="group" aria-label={`${project.name} workspaces`}>
                    {workspaces.length === 0 && (
                      <p className="tree-status" role="status">{workspacesStatus}</p>
                    )}
                    {workspaces.map((workspace) => {
                      const workspaceIsActive = workspace.id === selectedWorkspaceId;
                      const workspaceIsExpanded = workspace.id === expandedWorkspaceId;

                      return (
                        <div className="workspace-group" key={workspace.id}>
                          <div
                            className="tree-row-shell workspace-row-shell"
                            data-active={workspaceIsActive || undefined}
                            data-expanded={workspaceIsExpanded || undefined}
                          >
                            <button
                              className="workspace-row"
                              type="button"
                              aria-current={workspaceIsActive ? 'page' : undefined}
                              title={workspace.root_path}
                              onClick={() => selectWorkspace(workspace.id)}
                              disabled={turnIsActive || isManagingResource}
                            >
                              <span className="workspace-icon"><Icon name="folder" size={14} /></span>
                              <span>{workspace.name}</span>
                            </button>
                            <button
                              className="tree-toggle"
                              type="button"
                              aria-label={`${workspaceIsExpanded ? 'Collapse' : 'Expand'} ${workspace.name}`}
                              aria-expanded={workspaceIsExpanded}
                              onClick={() => toggleWorkspace(workspace.id)}
                              disabled={turnIsActive || isManagingResource}
                            >
                              <Icon name="chevron" size={11} />
                            </button>
                          </div>

                          {workspaceIsExpanded && workspaceIsActive && (
                            <div className="session-list" role="group" aria-label={`${workspace.name} sessions`}>
                              {isNewConversation && (
                                <button
                                  className="session-row"
                                  data-active
                                  type="button"
                                  onClick={startNewConversation}
                                  disabled={turnIsActive || isManagingResource}
                                >
                                  <span className="session-icon"><Icon name="message" size={13} /></span>
                                  <span>New conversation</span>
                                </button>
                              )}
                              {agentSessions.length === 0 && !isNewConversation && (
                                <p className="tree-status" role="status">{sessionsStatus}</p>
                              )}
                              {agentSessions.map((agentSession) => {
                                const sessionIsActive = agentSession.id === selectedSessionId;
                                const sessionMenuIsOpen = resourceActionMenu?.kind === 'session'
                                  && resourceActionMenu.id === agentSession.id;

                                return (
                                  <div
                                    className="tree-row-shell session-row-shell"
                                    data-active={sessionIsActive || undefined}
                                    data-removing={
                                      removingResource?.kind === 'session'
                                      && removingResource.id === agentSession.id
                                        ? true
                                        : undefined
                                    }
                                    key={agentSession.id}
                                  >
                                    <button
                                      className="session-row"
                                      type="button"
                                      aria-current={sessionIsActive ? 'page' : undefined}
                                      onClick={() => selectStoredSession(agentSession.id)}
                                      disabled={turnIsActive || isManagingResource}
                                    >
                                      <span className="session-icon"><Icon name="message" size={13} /></span>
                                      <span>{agentSession.title}</span>
                                    </button>
                                    <div
                                      className="resource-action-anchor"
                                      ref={sessionMenuIsOpen ? resourceActionMenuRef : undefined}
                                    >
                                      <button
                                        className="row-action-button"
                                        type="button"
                                        aria-label={`Actions for ${agentSession.title}`}
                                        aria-haspopup="menu"
                                        aria-expanded={sessionMenuIsOpen}
                                        data-open={sessionMenuIsOpen || undefined}
                                        onClick={() => toggleResourceActionMenu('session', agentSession.id)}
                                        disabled={turnIsActive || isManagingResource}
                                      >
                                        <Icon name="more" size={14} />
                                      </button>
                                      {sessionMenuIsOpen && (
                                        <div className="resource-menu resource-menu--session" role="menu">
                                          <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => openManagementDialog(
                                              {
                                                kind: 'session',
                                                id: agentSession.id,
                                                label: agentSession.title,
                                              },
                                              'rename',
                                            )}
                                          >
                                            <Icon name="pencil" size={13} />
                                            Rename chat
                                          </button>
                                          <button
                                            className="resource-menu-danger"
                                            type="button"
                                            role="menuitem"
                                            onClick={() => openManagementDialog(
                                              {
                                                kind: 'session',
                                                id: agentSession.id,
                                                label: agentSession.title,
                                              },
                                              'delete',
                                            )}
                                          >
                                            <Icon name="trash" size={13} />
                                            Delete chat
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
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

      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize project sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={maximumSidebarWidth()}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={beginSidebarResize}
        onPointerMove={resizeSidebar}
        onPointerUp={finishSidebarResize}
        onPointerCancel={finishSidebarResize}
        onKeyDown={resizeSidebarWithKeyboard}
      />

      <main className="agent-area">
        <div className="agent-workbench">
          <section className="conversation-pane">
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
            <button
              type="button"
              className="icon-button changes-panel-toggle"
              data-active={isChangesPanelOpen || undefined}
              aria-label={isChangesPanelOpen ? 'Close Git changes' : 'Open Git changes'}
              title={isChangesPanelOpen ? 'Close Git changes' : 'Open Git changes'}
              onClick={() => setIsChangesPanelOpen((isOpen) => !isOpen)}
              disabled={selectedWorkspace === null}
            >
              <Icon name="changes" size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Global search"
              title="Global search (Ctrl+Shift+F / Ctrl+K)"
              onClick={() => setIsGlobalSearchOpen(true)}
              disabled={selectedWorkspaceId === null}
            >
              <Icon name="search" size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Search conversation"
              title="Search conversation (Ctrl+F / /)"
              onClick={() => setIsConversationSearchOpen((v) => !v)}
              disabled={messages.length === 0}
            >
              <Icon name="search" size={15} />
            </button>
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

        <ConversationSearchBar
          messages={messages}
          isOpen={isConversationSearchOpen}
          query={conversationSearchQuery}
          onQueryChange={setConversationSearchQuery}
          onClose={() => {
            setIsConversationSearchOpen(false);
            setConversationSearchQuery('');
            setConversationSearchActiveId(null);
          }}
          onNavigate={(id) => setConversationSearchActiveId(id)}
        />

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
                  <CleanCodeLogo size={48} status="idle" />
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
                  <CleanCodeLogo size={48} status="idle" />
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
                  const searchQuery = conversationSearchQuery.trim();
                  const isSearchMatch = searchQuery.length > 0
                    && messageSearchText(message).includes(searchQuery.toLowerCase());
                  const isActiveSearchMatch = conversationSearchActiveId === message.id;

                  return (
                    <article
                      id={`msg-${message.id}`}
                      className="transcript-message"
                      data-role={message.role}
                      data-search-match={isSearchMatch || undefined}
                      data-active-match={isActiveSearchMatch || undefined}
                      key={message.id}
                    >
                      {!isUser && (
                        <span className="message-author-mark">
                          <img className="product-logo" src="/clean-code-logo.png" alt="" />
                        </span>
                      )}
                      <div className="message-body">
                        {isUser
                          ? (
                            searchQuery.length > 0
                              ? <div className="plain-message">{highlightMatch(text, searchQuery)}</div>
                              : <UserMessageContent text={text} />
                          )
                          : (
                            searchQuery.length > 0
                              ? <div className="markdown-content search-markdown-highlight">{highlightMatch(text, searchQuery)}</div>
                              : <AssistantMessageContent text={text} />
                          )}
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
                      <CleanCodeLogo
                        size={28}
                        status={liveAssistantText ? 'streaming' : 'thinking'}
                      />
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
          {pendingApproval !== null ? (
            <ApprovalPanel
              approval={pendingApproval}
              answeringDecision={answeringDecision}
              isStopping={isStopping}
              error={approvalError}
              onDecision={(decision) => void decideToolApproval(decision)}
              onStop={() => void stopAgent()}
            />
          ) : (
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
          )}
          <div className="composer-feedback" data-error={turnError !== null || undefined} role="status">
            <span>
              {turnError
                ?? (pendingApproval !== null
                  ? answeringDecision !== null
                    ? turnStatus
                    : 'Review the requested file operation before the agent can continue.'
                  : conversationIsReady
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
          </section>
          {isChangesPanelOpen && (
            <ChangesPanel
              workspace={selectedWorkspace}
              onClose={() => setIsChangesPanelOpen(false)}
            />
          )}
        </div>
      </main>

      {isGlobalSearchOpen && (
        <GlobalSearchDialog
          workspaceId={selectedWorkspaceId}
          workspaceName={selectedWorkspace?.name ?? null}
          onClose={() => setIsGlobalSearchOpen(false)}
        />
      )}

      {managementDialog !== null && (
        <div
          className="management-dialog-backdrop"
          data-closing={isManagementDialogClosing || undefined}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              closeManagementDialog();
            }
          }}
        >
          <form
            className="management-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="management-dialog-title"
            aria-busy={isManagingResource}
            onSubmit={manageResource}
          >
            <div className="management-dialog-heading">
              <span className="management-dialog-icon">
                <Icon
                  name={managementDialog.action === 'rename' ? 'pencil' : 'trash'}
                  size={16}
                />
              </span>
              <div>
                <strong id="management-dialog-title">
                  {managementDialog.action === 'rename' ? 'Rename' : 'Delete'}{' '}
                  {managementDialog.kind === 'project' ? 'project' : 'chat'}
                </strong>
                <small>{managementDialog.label}</small>
              </div>
            </div>

            {managementDialog.action === 'rename' ? (
              <label className="management-field">
                <span>{managementDialog.kind === 'project' ? 'Project name' : 'Chat title'}</span>
                <input
                  value={managementValue}
                  onChange={(event) => setManagementValue(event.target.value)}
                  maxLength={managementDialog.kind === 'project' ? 120 : 160}
                  disabled={isManagingResource || isManagementDialogClosing}
                  autoFocus
                  required
                />
              </label>
            ) : (
              <p className="management-warning">
                {managementDialog.kind === 'project'
                  ? 'This permanently deletes the project and all workspaces, chats, messages, runs, and events inside it.'
                  : 'This permanently deletes this chat and all of its messages, runs, and events.'}
              </p>
            )}

            {managementStatus.length > 0 && (
              <p className="management-status" role="status">{managementStatus}</p>
            )}

            <div className="management-dialog-actions">
              <button
                className="button button--ghost"
                type="button"
                onClick={closeManagementDialog}
                disabled={isManagingResource || isManagementDialogClosing}
              >
                Cancel
              </button>
              <button
                className={`button ${managementDialog.action === 'delete' ? 'button--danger' : 'button--primary'}`}
                type="submit"
                disabled={isManagingResource || isManagementDialogClosing}
              >
                {isManagingResource
                  ? managementDialog.action === 'rename' ? 'Renaming...' : 'Deleting...'
                  : managementDialog.action === 'rename' ? 'Rename' : 'Delete'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
