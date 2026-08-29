# Clean Code

Clean Code is a local coding agent with a web interface.

The agent can read a repository, search files, edit files, run shell commands, and show Git changes. It asks for approval before it changes a file or runs a shell command.

This project is in active development. It is not ready for production use.

## Current features

- Create projects and connect local workspaces.
- Create and manage agent sessions.
- Store messages, runs, and run events in PostgreSQL.
- Stream assistant responses to the web interface.
- Select a configured model.
- List files in a workspace.
- Search file names and file content.
- Create and edit files after user approval.
- Run shell commands after user approval.
- Search the current conversation.
- Show Git changes and file diffs.
- Revert selected file changes.
- Commit selected files to the current branch or a new branch.
- Render Markdown and highlighted code blocks.

## Technology

| Area | Technology |
| --- | --- |
| API | Python, FastAPI, SQLAlchemy, Psycopg |
| Database | PostgreSQL |
| Migrations | Alembic |
| Web interface | React, TypeScript, Vite |
| Package tools | uv and pnpm |
| Current model provider | Anthropic |

## Project structure

```text
clean-code/
|-- apps/
|   |-- api/                 FastAPI application and database migrations
|   `-- web/                 React web application
|-- References/              Local reference source, not part of Git
|-- .env.example             Environment variable template
|-- package.json             Root web commands
`-- README.md                Project guide
```

## Requirements

Install these tools before you start:

- Python 3.14 or a newer compatible version
- uv
- PostgreSQL
- Node.js
- pnpm 11

You also need an API key for a provider that the runtime supports. The current runtime supports Anthropic.

## Local setup

### 1. Create the environment file

Run this command from the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
```

Open `.env` and set the PostgreSQL values. Set `ANTHROPIC_API_KEY` if you want to run the agent with Anthropic.

```dotenv
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=clean_code
POSTGRES_USER=clean_code_app
POSTGRES_PASSWORD="your_local_password"
ANTHROPIC_API_KEY="your_api_key"
```

Do not commit `.env`. Git ignores this file.

### 2. Prepare PostgreSQL

Create the database and user that you set in `.env`. The user must have access to the database.

The default example uses:

- Database: `clean_code`
- User: `clean_code_app`
- Port: `5432`

### 3. Install the API dependencies

```powershell
Set-Location apps/api
uv sync
```

### 4. Apply the database migrations

Run this command from `apps/api`:

```powershell
uv run alembic upgrade head
```

### 5. Start the API

Run this command from `apps/api`:

```powershell
uv run fastapi dev app/main.py
```

The API starts at `http://127.0.0.1:8000`.

Useful URLs:

- Health check: `http://127.0.0.1:8000/api/v1/health`
- Readiness check: `http://127.0.0.1:8000/api/v1/ready`
- API documentation: `http://127.0.0.1:8000/docs`

### 6. Install the web dependencies

Open a second PowerShell terminal. Run these commands from the repository root:

```powershell
pnpm --dir apps/web install
```

### 7. Start the web application

```powershell
pnpm dev:web
```

Open `http://127.0.0.1:5173`.

Vite sends `/api` requests to the FastAPI server on port 8000.

## Model configuration

The model catalog is in `apps/api/config/models.json`.

Each model entry has a provider ID, a model ID, and a label. The provider ID must match a provider that the API can create.

The catalog does not store API keys. Store keys only in `.env` or in another secure environment source.

## Safety rules

Clean Code applies these basic safety rules:

- File tools stay inside the selected workspace root.
- File creation and file editing require user approval.
- Shell commands require user approval.
- Git actions use selected file paths.
- Secrets stay outside the model catalog and Git history.

Review every approval request before you allow it. A shell command or file edit can change your repository.

## Useful commands

Run these commands from the repository root unless a command says otherwise.

### Build the web application

```powershell
pnpm build:web
```

### Check the web source

```powershell
pnpm --dir apps/web lint
```

### Show the current migration

Run this command from `apps/api`:

```powershell
uv run alembic current
```

### Show available migrations

Run this command from `apps/api`:

```powershell
uv run alembic history
```

## Current limits

- The runtime supports only the Anthropic provider.
- Pending tool approvals are stored in application memory.
- An API restart can remove a pending approval.
- The project does not have user authentication.
- The Git interface does not push commits to a remote repository.
- Conversation branching, rewind, and checkpoints are not complete.
- Context compaction, subagents, MCP, and plan mode are not complete.
- Production deployment is not configured.

## Development status

The main agent path works from the web interface to the API, model provider, tools, approval flow, PostgreSQL records, and Git change view.

The next work should improve reliability before it adds more tools. Durable approval storage is one important reliability task.

## License

This repository does not currently contain a license file.
