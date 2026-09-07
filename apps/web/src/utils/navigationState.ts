export type NavigationState = {
  projectId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
};

const STORAGE_KEY = 'clean-code.navigation.v1';

export function readNavigationState(): NavigationState | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (value === null || typeof value !== 'object') return null;
    const state = value as Record<string, unknown>;
    const validId = (id: unknown): id is string | null => id === null || (
      typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)
    );
    if (!validId(state.projectId) || !validId(state.workspaceId) || !validId(state.sessionId)) return null;
    return { projectId: state.projectId, workspaceId: state.workspaceId, sessionId: state.sessionId };
  } catch {
    return null;
  }
}

export function saveNavigationState(state: NavigationState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Navigation must remain usable when browser storage is unavailable.
  }
}
