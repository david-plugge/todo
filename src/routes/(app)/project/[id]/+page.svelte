<script lang="ts">
	import { page } from '$app/state';
	import { projects } from '$lib/store';
	import MainView from '$lib/MainView.svelte';
	import type { Selection } from '$lib/types';

	// The route guarantees `id` is present.
	const selection: Selection = $derived({ kind: 'project', id: page.params.id! });
</script>

<MainView {selection} projects={$projects} />
