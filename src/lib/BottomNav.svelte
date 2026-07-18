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
		{ view: 'all', label: 'All', icon: 'all' },
	];

	let sheetOpen = $state(false);

	function isView(view: SpecialView): boolean {
		return current.kind === 'view' && current.view === view;
	}

	function pickView(view: SpecialView) {
		onselect({ kind: 'view', view });
	}

	// Selecting a project (or creating one) from the sheet also dismisses it.
	function pickFromSheet(s: Selection) {
		onselect(s);
		sheetOpen = false;
	}
</script>

{#if sheetOpen}
	<div class="backdrop" onclick={() => (sheetOpen = false)} role="presentation"></div>
	<div class="sheet" role="dialog" aria-modal="true" aria-label="Projects">
		<div class="handle" aria-hidden="true"></div>
		<ProjectNav {projects} {current} onselect={pickFromSheet} />
		<SyncBar />
	</div>
{/if}

<nav class="bottombar" aria-label="Main">
	{#each views as v (v.view)}
		<button class="tab" class:active={isView(v.view)} onclick={() => pickView(v.view)}>
			<Icon name={v.icon} size={21} /><span>{v.label}</span>
		</button>
	{/each}
	<button
		class="tab"
		class:active={current.kind === 'project'}
		aria-haspopup="dialog"
		aria-expanded={sheetOpen}
		onclick={() => (sheetOpen = true)}
	>
		<Icon name="projects" size={21} /><span>Projects</span>
	</button>
</nav>

<style>
	.bottombar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 15;
		display: flex;
		background: var(--bg-elev);
		border-top: 1px solid var(--border);
		padding-bottom: env(safe-area-inset-bottom);
	}
	.tab {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		background: transparent;
		border: none;
		color: var(--text-faint);
		padding: 8px 2px 7px;
		font-size: 10.5px;
		font-weight: 500;
		transition: color 0.1s;
	}
	.tab:active {
		background: var(--bg-hover);
	}
	.tab.active {
		color: var(--accent);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.28);
		z-index: 16;
		animation: fade 0.15s ease;
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 17;
		max-height: 75vh;
		overflow-y: auto;
		background: var(--bg);
		border-top: 1px solid var(--border);
		border-radius: 16px 16px 0 0;
		box-shadow: var(--shadow-lg);
		padding: 8px 14px calc(16px + env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		gap: 14px;
		animation: slideup 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.handle {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--border-strong);
		margin: 2px auto 2px;
		flex: none;
	}

	/* The bottom bar is a phones-only replacement for the sidebar. */
	@media (min-width: 641px) {
		.bottombar,
		.backdrop,
		.sheet {
			display: none;
		}
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes slideup {
		from {
			transform: translateY(100%);
		}
	}
</style>
