import { useState, type FormEvent } from 'react';

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

function App() {
  const [apiStatus, setApiStatus] = useState('Not checked');
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [projectsStatus, setProjectsStatus] = useState('Projects not loaded');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [createStatus, setCreateStatus] = useState('Ready to create a project');
  const [isCreating, setIsCreating] = useState(false);

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

  async function loadProjects() {
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
      setProjectName('');
      setProjectDescription('');
      setCreateStatus(`Created ${createdProject.name}`);
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

  return (
    <>
      <h1>{apiStatus}</h1>

      <button type="button" onClick={checkApi}>
        Check system readiness
      </button>

      <section>
        <h2>Projects</h2>

        <form onSubmit={createProject}>
          <label htmlFor="project-name">Name</label>
          <input
            id="project-name"
            name="name"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            maxLength={120}
            disabled={isCreating}
            required
          />

          <label htmlFor="project-description">Description</label>
          <textarea
            id="project-description"
            name="description"
            value={projectDescription}
            onChange={(event) => setProjectDescription(event.target.value)}
            disabled={isCreating}
          />

          <button type="submit" disabled={isCreating}>
            {isCreating ? 'Creating...' : 'Create project'}
          </button>
        </form>

        <p>{createStatus}</p>

        <button type="button" onClick={loadProjects}>
          Load projects
        </button>

        <p>{projectsStatus}</p>

        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <strong>{project.name}</strong>
              <p>{project.description ?? 'No description'}</p>
              <small>{new Date(project.created_at).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default App;
