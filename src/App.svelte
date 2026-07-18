<script lang="ts">
	import { onMount } from 'svelte';
	import { projects } from './lib/store';
	import { startSync, stopSync } from './lib/sync';
	import type { Selection } from './lib/types';
	import Sidebar from './lib/Sidebar.svelte';
	import BottomNav from './lib/BottomNav.svelte';
	import MainView from './lib/MainView.svelte';

	let selection = $state<Selection>({ kind: 'view', view: 'today' });

	// If a token from a previous session is still valid, resume syncing on load.
	onMount(() => {
		startSync();
		return () => stopSync();
	});
</script>

<div class="app">
	<Sidebar projects={$projects} current={selection} onselect={(s) => (selection = s)} />
	<MainView {selection} projects={$projects} />
	<BottomNav projects={$projects} current={selection} onselect={(s) => (selection = s)} />
</div>

<style>
	.app {
		display: flex;
		height: 100%;
		width: 100%;
	}
</style>
