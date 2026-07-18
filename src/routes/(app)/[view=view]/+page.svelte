<script lang="ts">
	import { page } from '$app/state';
	import { projects } from '$lib/store';
	import MainView from '$lib/MainView.svelte';
	import type { Selection, SpecialView } from '$lib/types';

	const selection: Selection = $derived({
		kind: 'view',
		view: page.params.view as SpecialView,
	});
</script>

<MainView {selection} projects={$projects} />
