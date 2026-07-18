import { redirect } from '@sveltejs/kit';

// "/" has no view of its own — send it to Today.
export function load() {
	redirect(307, '/today');
}
