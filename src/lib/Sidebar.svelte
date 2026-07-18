<script lang="ts">
	import type { Project, Selection, SpecialView } from './types';
	import Icon from './Icon.svelte';
	import ProjectNav from './ProjectNav.svelte';
	import SyncBar from './SyncBar.svelte';

	let {
		projects,
		current,
		onselect,
	}: { projects: Project[]; current: Selection; onselect: (s: Selection) => void } = $props();

	const views: { view: SpecialView; label: string; icon: string }[] = [
		{ view: 'today', label: 'Today', icon: 'today' },
		{ view: 'upcoming', label: 'Upcoming', icon: 'upcoming' },
		{ view: 'inbox', label: 'Inbox', icon: 'inbox' },
		{ view: 'all', label: 'All Tasks', icon: 'all' },
	];

	function isActive(view: SpecialView): boolean {
		return current.kind === 'view' && current.view === view;
	}
</script>

<nav class="sidebar">
	<div class="brand"><span class="logo">✓</span> Todo</div>

	<div class="group">
		{#each views as v (v.view)}
			<button
				class="item"
				class:active={isActive(v.view)}
				onclick={() => onselect({ kind: 'view', view: v.view })}
			>
				<Icon name={v.icon} size={16} /><span>{v.label}</span>
			</button>
		{/each}
	</div>

	<ProjectNav {projects} {current} {onselect} />

	<SyncBar />
</nav>

<style>
	.sidebar {
		width: 232px;
		flex: none;
		height: 100%;
		background: var(--bg-elev);
		border-right: 1px solid var(--border);
		padding: 14px 10px;
		display: flex;
		flex-direction: column;
		gap: 18px;
		overflow-y: auto;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 700;
		font-size: 15px;
		padding: 4px 8px 2px;
	}
	.logo {
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: #fff;
		border-radius: 6px;
		font-size: 13px;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		color: var(--text-dim);
		padding: 7px 8px;
		border-radius: var(--radius-sm);
		transition:
			background 0.1s,
			color 0.1s;
	}
	.item:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.item.active {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 550;
	}

	/* On phones the sidebar is replaced by the bottom tab bar (BottomNav). */
	@media (max-width: 640px) {
		.sidebar {
			display: none;
		}
	}
</style>
