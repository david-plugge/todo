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

	const tab =
		'flex flex-1 flex-col items-center gap-[3px] border-none bg-transparent px-[2px] pt-2 pb-[7px] text-[10.5px] font-medium text-faint transition-colors duration-100 active:bg-hover';
</script>

{#if sheetOpen}
	<div
		class="fixed inset-0 z-[16] hidden animate-[fade_0.15s_ease] bg-black/28 max-[640px]:block"
		onclick={() => (sheetOpen = false)}
		role="presentation"
	></div>
	<div
		class="fixed inset-x-0 bottom-0 z-[17] hidden max-h-[75vh] flex-col gap-[14px] overflow-y-auto rounded-t-[16px] border-t border-line bg-bg px-[14px] pt-2 pb-[calc(16px+env(safe-area-inset-bottom))] shadow-pop animate-[slideup_0.2s_cubic-bezier(0.2,0.8,0.2,1)] max-[640px]:flex"
		role="dialog"
		aria-modal="true"
		aria-label="Projects"
	>
		<div
			class="mx-auto my-[2px] h-1 w-9 flex-none rounded-[2px] bg-line-strong"
			aria-hidden="true"
		></div>
		<ProjectNav {projects} {current} onselect={pickFromSheet} />
		<SyncBar />
	</div>
{/if}

<nav
	class="fixed inset-x-0 bottom-0 z-[15] hidden border-t border-line bg-elev pb-[env(safe-area-inset-bottom)] max-[640px]:flex"
	aria-label="Main"
>
	{#each views as v (v.view)}
		<button class={[tab, isView(v.view) && 'text-accent']} onclick={() => pickView(v.view)}>
			<Icon name={v.icon} size={21} /><span>{v.label}</span>
		</button>
	{/each}
	<button
		class={[tab, current.kind === 'project' && 'text-accent']}
		aria-haspopup="dialog"
		aria-expanded={sheetOpen}
		onclick={() => (sheetOpen = true)}
	>
		<Icon name="projects" size={21} /><span>Projects</span>
	</button>
</nav>

<style>
	/* Keyframes can't be expressed as utilities; kept global so the Tailwind
	 * animate-[...] utilities can reference them (Svelte scopes keyframes
	 * otherwise). */
	@keyframes -global-fade {
		from {
			opacity: 0;
		}
	}
	@keyframes -global-slideup {
		from {
			transform: translateY(100%);
		}
	}
</style>
