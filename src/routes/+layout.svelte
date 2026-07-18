<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { isTauri } from '$lib/platform';
	import '../app.css';

	let { children } = $props();

	// Register the offline service worker only for the production web build served
	// by PocketBase — not the Tauri shell (already offline) or the dev server.
	// Kit's auto-registration is disabled (svelte.config.js) so this is the only
	// place it happens.
	onMount(() => {
		if (!(import.meta.env.PROD && !isTauri && 'serviceWorker' in navigator)) return;

		// A controller already present means this is an update visit, not the first
		// install — reload once when the new worker takes over so the fresh shell
		// is used (the old Workbox `autoUpdate`, minus a first-visit reload loop).
		const hadController = !!navigator.serviceWorker.controller;

		let reloading = false;

		const onChange = () => {
			if (!hadController || reloading) return;

			reloading = true;
			location.reload();
		};

		navigator.serviceWorker.addEventListener('controllerchange', onChange);
		navigator.serviceWorker.register(resolve('/service-worker.js'), { type: 'module' });

		return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
	});
</script>

{@render children()}
