<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { projects } from '$lib/store';
	import { startSync, stopSync } from '$lib/sync';
	import { selectionPath } from '$lib/routes';
	import type { Selection, SpecialView } from '$lib/types';
	import Sidebar from '$lib/Sidebar.svelte';
	import BottomNav from '$lib/BottomNav.svelte';

	let { children } = $props();

	// If a token from a previous session is still valid, resume syncing on load.
	onMount(() => {
		startSync();
		return () => stopSync();
	});

	// The current selection is derived from the URL — the nav highlights follow
	// the route, and navigating just means changing it.
	const current: Selection = $derived.by(() => {
		if (page.params.id) return { kind: 'project', id: page.params.id };
		return { kind: 'view', view: (page.params.view ?? 'today') as SpecialView };
	});

	function onselect(s: Selection) {
		goto(selectionPath(s));
	}
</script>

<div class="flex h-full w-full">
	<Sidebar projects={$projects} {current} {onselect} />
	{@render children()}
	<BottomNav projects={$projects} {current} {onselect} />
</div>
