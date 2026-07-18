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

<nav
	class="flex h-full w-[232px] flex-none flex-col gap-[18px] overflow-y-auto border-r border-border bg-card px-2.5 py-[14px] max-[640px]:hidden"
>
	<div class="flex items-center gap-2 px-2 pt-1 pb-0.5 text-[15px] font-bold">
		<span class="grid h-5 w-5 place-items-center rounded-[6px] bg-primary text-[13px] text-white"
			>✓</span
		> Todo
	</div>

	<div class="flex flex-col gap-px">
		{#each views as v (v.view)}
			<button
				class={[
					'flex w-full items-center gap-2.5 rounded-md border-none px-2 py-[7px] text-left transition-colors duration-100',
					isActive(v.view) ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
				]}
				onclick={() => onselect({ kind: 'view', view: v.view })}
			>
				<Icon name={v.icon} size={16} /><span>{v.label}</span>
			</button>
		{/each}
	</div>

	<ProjectNav {projects} {current} {onselect} />

	<SyncBar />
</nav>
