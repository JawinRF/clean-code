import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
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

type IconName =
  | 'arrow-up'
  | 'check'
  | 'chevron'
  | 'folder'
  | 'plus'
  | 'refresh'
  | 'terminal';

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    'arrow-up': <path d="m6 9 6-6 6 6M12 3v14" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    folder: <path d="M3 7.5h6l2-2h10v13H3z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.7-1.9L20 8M4 16l2.2 1.9A7 7 0 0 0 17.9 16" />,
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
    || normalized.includes('no projects')
  ) return 'success';

  return 'neutral';
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

  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  ) ?? null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <img className="product-logo" src="/clean-code-logo.png" alt="" />
          </span>
          <span>
            <strong>Clean Code</strong>
            <small>Agent workspace</small>
          </span>
        </div>

        <button
          className="new-project-button"
          type="button"
          aria-expanded={isProjectFormOpen}
          onClick={() => setIsProjectFormOpen((isOpen) => !isOpen)}
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
              disabled={isCreating}
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
              disabled={isCreating}
            />

            <div className="project-form-actions">
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setIsProjectFormOpen(false)}
                disabled={isCreating}
              >
                Cancel
              </button>
              <button className="button button--primary" type="submit" disabled={isCreating}>
                {isCreating ? 'Creating...' : 'Create'}
              </button>
            </div>
            <p className="form-status" role="status">{createStatus}</p>
          </form>
        )}

        <div className="sidebar-section-heading">
          <span>Projects</span>
          <button type="button" aria-label="Reload projects" onClick={loadProjects}>
            <Icon name="refresh" size={14} />
          </button>
        </div>

        <nav className="project-list" aria-label="Projects">
          {projects.map((project) => (
            <button
              className="project-row"
              data-active={project.id === selectedProjectId || undefined}
              type="button"
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
            >
              <span className="project-icon"><Icon name="folder" size={15} /></span>
              <span className="project-row-copy">
                <strong>{project.name}</strong>
                <small>{project.description ?? 'No description'}</small>
              </span>
            </button>
          ))}
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
              <strong>{selectedProject?.name ?? 'No project selected'}</strong>
              <small>Agent</small>
            </div>
          </div>
          <div className="header-actions">
            <span className="model-chip">Model not selected</span>
            <button className="icon-button" type="button" aria-label="Refresh project data" onClick={loadProjects}>
              <Icon name="refresh" size={15} />
            </button>
          </div>
        </header>

        <section className="conversation" aria-label="Agent conversation">
          <div className="conversation-column">
            <div className="assistant-message">
              <span className="assistant-mark">
                <img className="product-logo" src="/clean-code-logo.png" alt="" />
              </span>
              <div className="assistant-content">
                <p className="eyebrow">Workspace overview</p>
                <h1>
                  {selectedProject
                    ? `Ready to work in ${selectedProject.name}`
                    : 'Choose a project to begin'}
                </h1>
                <p>
                  {selectedProject?.description
                    ?? 'Create or select a project from the sidebar. The existing project and readiness APIs remain active in this new shell.'}
                </p>
                {selectedProject && (
                  <p className="message-meta">
                    Created {new Date(selectedProject.created_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

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
            </div>
          </div>
        </section>

        <footer className="composer-wrap">
          <div className="composer" aria-label="Agent composer">
            <textarea
              aria-label="Agent request"
              placeholder="Agent messages will connect in the next frontend stage"
              rows={2}
              disabled
            />
            <div className="composer-toolbar">
              <div className="composer-options">
                <button type="button" className="composer-icon-button" disabled aria-label="Add context">
                  <Icon name="plus" size={16} />
                </button>
                <span>Workspace required</span>
              </div>
              <button type="button" className="send-button" disabled aria-label="Send message">
                <Icon name="arrow-up" size={17} />
              </button>
            </div>
          </div>
          <p className="composer-note">The composer is visible but inactive until workspace selection is connected.</p>
        </footer>
      </main>
    </div>
  );
}

export default App;
