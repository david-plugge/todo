<script lang="ts">
	import type { Project, Selection, SpecialView } from './types';
	import Icon from './Icon.svelte';
	import ProjectNav from './ProjectNav.svelte';
	import SyncBar from './SyncBar.svelte';
	import * as Drawer from '$lib/components/ui/drawer/index.js';

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
		'flex flex-1 flex-col items-center gap-[3px] border-none bg-transparent px-[2px] pt-2 pb-[7px] text-[10.5px] font-medium text-muted-foreground/70 transition-colors duration-100 active:bg-accent';
</script>

<Drawer.Root bind:open={sheetOpen}>
	<Drawer.Content class="gap-[14px] overflow-y-auto">
		<Drawer.Title class="sr-only">Projects</Drawer.Title>
		<Drawer.Description class="sr-only">Switch to a project or view</Drawer.Description>
		<ProjectNav {projects} {current} onselect={pickFromSheet} />
		<SyncBar />
	</Drawer.Content>
</Drawer.Root>

<nav
	class="fixed inset-x-0 bottom-0 z-[15] hidden border-t border-border bg-card pb-[env(safe-area-inset-bottom)] max-[640px]:flex"
	aria-label="Main"
>
	{#each views as v (v.view)}
		<button class={[tab, isView(v.view) && 'text-primary']} onclick={() => pickView(v.view)}>
			<Icon name={v.icon} size={21} /><span>{v.label}</span>
		</button>
	{/each}
	<button
		class={[tab, current.kind === 'project' && 'text-primary']}
		aria-haspopup="dialog"
		aria-expanded={sheetOpen}
		onclick={() => (sheetOpen = true)}
	>
		<Icon name="projects" size={21} /><span>Projects</span>
	</button>
</nav>
