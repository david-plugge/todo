import type { Selection } from './types';

/** Map a Selection to its URL path (the single source of truth is now the URL). */
export function selectionPath(s: Selection): string {
	return s.kind === 'project' ? `/project/${s.id}` : `/${s.view}`;
}
