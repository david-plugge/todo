import { redirect } from '@sveltejs/kit';

export function load({ url }: { url: URL }) {
  redirect(308, `/${url.search}`);
}
