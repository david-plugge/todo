import type { ParamMatcher } from '@sveltejs/kit';

// Constrains the [view] route param to the four special views, so /project/…
// (and anything else) never matches it.
export const match = ((param: string): param is 'today' | 'upcoming' | 'inbox' | 'all' => {
	return param === 'today' || param === 'upcoming' || param === 'inbox' || param === 'all';
}) satisfies ParamMatcher;
