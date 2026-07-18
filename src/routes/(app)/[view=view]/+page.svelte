<script lang="ts">
	import { projects } from '$lib/store';
	import MainView from '$lib/MainView.svelte';
	import type { Selection } from '$lib/types';

	let { params } = $props();

	const selection: Selection = $derived({
		kind: 'view',
		view: params.view,
	});
</script>

<MainView {selection} projects={$projects} />
