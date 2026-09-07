import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

from app.schemas.github import GitHubCloneRequest, GitHubPullRequest, GitHubPushRequest
from app.services.git_changes import _git, _repository_root


class GitHubError(RuntimeError):
    pass


def _command(program: str, arguments: list[str], *, cwd: Path | None = None,
             payload: dict | None = None, timeout: int = 30) -> str:
    executable = shutil.which(program)
    if executable is None:
        raise GitHubError(f'{program} is not installed. Install it on the local runtime machine.')
    environment = os.environ.copy()
    environment.update(GH_PROMPT_DISABLED="1", GH_PAGER="cat", GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never")
    try:
        result = subprocess.run(
            [executable, *arguments], cwd=cwd, env=environment,
            input=json.dumps(payload) if payload is not None else "",
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired as error:
        raise GitHubError('The operation timed out. Its outcome may be unknown. Check GitHub and the local folder before retrying.') from error
    except OSError as error:
        raise GitHubError('The local command could not start.') from error
    if result.returncode:
        # CLI output can contain credentials or private remote URLs. Do not send it to the browser.
        raise GitHubError('GitHub operation failed. Check local sign-in, repository access, branch rules, and network access. No automatic retry was made.')
    return result.stdout.strip()


def _api(path: str, payload: dict | None = None) -> object:
    arguments = ['api', '--hostname', 'github.com', path]
    if payload is not None:
        arguments += ['--method', 'POST', '--input', '-']
    try:
        return json.loads(_command('gh', arguments, payload=payload))
    except (ValueError, TypeError) as error:
        raise GitHubError('GitHub returned an invalid response.') from error


def repository_name(value: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}', value):
        raise GitHubError('Use a github.com repository in owner/repository format.')
    return value


def connection_status() -> dict:
    if shutil.which('gh') is None:
        return {'connected': False, 'login': None, 'message': 'Install GitHub CLI on the local runtime machine.'}
    try:
        account = _api('user')
        return {'connected': True, 'login': account['login'], 'message': 'Using the local GitHub CLI account.'}
    except GitHubError as error:
        return {'connected': False, 'login': None, 'message': str(error)}


def repository_status(workspace_root: str) -> dict:
    root = _repository_root(workspace_root)
    remote = _git(root, 'remote', 'get-url', '--push', 'origin', check=False)
    value = remote.stdout.decode('utf-8', errors='replace').strip()
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([^/]+/[^/]+?)(?:\.git)?', value)
    if match is None:
        raise GitHubError('Origin must point to github.com over HTTPS or SSH, without embedded credentials.')
    repository = repository_name(match[1])
    branch = _git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False).stdout.decode().strip()
    if not branch:
        raise GitHubError('Select a local branch before using GitHub actions.')
    head = _git(root, 'rev-parse', '--verify', 'HEAD').stdout.decode().strip()
    details = _api(f'repos/{repository}')
    pulls = _api(f'repos/{repository}/pulls?state=open&per_page=20&head={quote(repository.split("/")[0] + ":" + branch, safe="")}')
    return {
        'repository': repository, 'branch': branch, 'head': head,
        'default_branch': details['default_branch'],
        'url': f'https://github.com/{repository}',
        'pull_requests': [
            {'number': item['number'], 'title': item['title'], 'url': f'https://github.com/{repository}/pull/{item["number"]}', 'draft': item['draft']}
            for item in pulls
        ],
    }


def list_repositories(page: int = 1) -> dict:
    if not 1 <= page <= 1000:
        raise GitHubError('Repository page must be between 1 and 1000.')
    items = _api(f'user/repos?sort=updated&direction=desc&per_page=30&page={page}')
    if not isinstance(items, list):
        raise GitHubError('GitHub returned an invalid repository list.')
    try:
        repositories = [
            {'name': repository_name(item['full_name']), 'private': bool(item['private'])}
            for item in items
        ]
    except (KeyError, TypeError) as error:
        raise GitHubError('GitHub returned an invalid repository entry.') from error
    return {'repositories': repositories, 'page': page, 'has_more': len(items) == 30 and page < 1000}


def _confirmed_repository(workspace_root: str, request: GitHubPushRequest) -> tuple[Path, dict]:
    if not request.confirmed:
        raise GitHubError('Confirm the destination and action before continuing.')
    state = repository_status(workspace_root)
    if (state['repository'], state['branch'], state['head']) != (request.repository, request.branch, request.expected_head):
        raise GitHubError('The repository or branch changed. Refresh and review it again.')
    return _repository_root(workspace_root), state


def push_branch(workspace_root: str, request: GitHubPushRequest) -> dict:
    root, state = _confirmed_repository(workspace_root, request)
    gh_path = shutil.which('gh')
    helper = f'!"{Path(gh_path).as_posix()}" auth git-credential'
    # Push the reviewed commit to one explicit branch, not a moving HEAD or a configured push refspec.
    _command('git', [
        '-c', 'credential.helper=', '-c', f'credential.helper={helper}',
        '-c', 'http.followRedirects=false', '-c', 'push.followTags=false',
        'push', '--porcelain', '--', f'https://github.com/{state["repository"]}.git',
        f'{request.expected_head}:refs/heads/{request.branch}',
    ], cwd=root, timeout=120)
    return {'message': f'Pushed {request.branch} to {state["repository"]}.', 'url': state['url']}


def create_pull_request(workspace_root: str, request: GitHubPullRequest) -> dict:
    _, state = _confirmed_repository(workspace_root, request)
    if request.base == request.branch:
        raise GitHubError('The base branch must differ from the current branch.')
    remote_head = _api(f'repos/{state["repository"]}/git/ref/heads/{quote(request.branch, safe="")}')
    if remote_head['object']['sha'] != request.expected_head:
        raise GitHubError('Push the reviewed commit before creating the pull request.')
    existing = [pr for pr in _api(f'repos/{state["repository"]}/pulls?state=open&per_page=100')
                if pr['head']['ref'] == request.branch and pr['base']['ref'] == request.base
                and pr['head']['repo'] and pr['head']['repo']['full_name'].lower() == state['repository'].lower()]
    if existing:
        return {'message': 'An open pull request already exists.', 'url': f'https://github.com/{state["repository"]}/pull/{existing[0]["number"]}'}
    pull = _api(f'repos/{state["repository"]}/pulls', {
        'head': request.branch, 'base': request.base, 'title': request.title,
        'body': request.body, 'draft': request.draft,
    })
    return {'message': 'Pull request created.', 'url': f'https://github.com/{state["repository"]}/pull/{pull["number"]}'}


def clone_repository(workspace_root: str, request: GitHubCloneRequest) -> dict:
    if not request.confirmed:
        raise GitHubError('Confirm the clone destination before continuing.')
    repository = repository_name(request.repository)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', request.directory):
        raise GitHubError('Use a folder name with letters, digits, hyphens, or underscores.')
    if request.directory.upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}:
        raise GitHubError('That folder name is reserved by Windows.')
    root = Path(workspace_root).resolve(strict=True)
    destination = root / request.directory
    if destination.exists() or destination.is_symlink():
        raise GitHubError('The destination already exists. Choose a new folder. Existing files will not be replaced.')
    if destination.resolve().parent != root:
        raise GitHubError('The clone must stay inside the active workspace.')
    _command('gh', ['repo', 'clone', f'https://github.com/{repository}.git', str(destination), '--', '--no-recurse-submodules'], cwd=root, timeout=120)
    return {'message': 'Repository cloned. Add this folder as a workspace to work in it.', 'path': str(destination)}
