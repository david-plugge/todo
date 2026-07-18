<script lang="ts">
	import { untrack } from 'svelte';
	import { dndzone, type DndEvent } from 'svelte-dnd-action';
	import type { Task, Project, Selection } from './types';
	import { tasksForSelection, moveInList } from './store';
	import { todayISO } from './date';
	import TaskRow from './TaskRow.svelte';
	import Composer from './Composer.svelte';
	import TaskEditor from './TaskEditor.svelte';
	import Icon from './Icon.svelte';

	let { selection, projects }: { selection: Selection; projects: Project[] } = $props();

	const projectMap = $derived(new Map(projects.map((p) => [p.id, p])));

	// View metadata (title, icon, composer defaults).
	const meta = $derived.by(() => {
		if (selection.kind === 'project') {
			const p = projectMap.get(selection.id);
			return {
				title: p?.name ?? 'Project',
				icon: 'dot',
				manual: true,
				order: 'rank' as const,
				projectId: selection.id,
				planned: null,
			};
		}
		switch (selection.view) {
			case 'today':
				return {
					title: 'Today',
					icon: 'today',
					manual: true,
					order: 'todayRank' as const,
					projectId: null,
					planned: todayISO(),
				};
			case 'inbox':
				return {
					title: 'Inbox',
					icon: 'inbox',
					manual: true,
					order: 'rank' as const,
					projectId: null,
					planned: null,
				};
			case 'upcoming':
				return {
					title: 'Upcoming',
					icon: 'upcoming',
					manual: false,
					order: 'rank' as const,
					projectId: null,
					planned: null,
				};
			case 'all':
				return {
					title: 'All Tasks',
					icon: 'all',
					manual: true,
					order: 'rank' as const,
					projectId: null,
					planned: null,
				};
		}
	});

	// Subscribe to the right reactive query; swap when the selection changes.
	// Open tasks are draggable; completed-today tasks live in a separate,
	// unordered list below (only the Today view ever has completed rows here).
	let tasks = $state<Task[]>([]);
	let completedTasks = $state<Task[]>([]);
	let dragging = $state(false);
	$effect(() => {
		const store = tasksForSelection(selection);
		// Subscribe untracked so `dragging` (read in the callback) doesn't become
		// an effect dependency — otherwise toggling it recreates the store, whose
		// synchronous initial `[]` emit would flash the empty-list state.
		return untrack(() =>
			store.subscribe((v) => {
				completedTasks = v.filter((t) => t.completed);
				if (!dragging) tasks = v.filter((t) => !t.completed);
			}),
		);
	});

	let editing = $state<Task | null>(null);
	// Keep the editor bound to fresh task data after edits.
	$effect(() => {
		if (editing) {
			const fresh = [...tasks, ...completedTasks].find((t) => t.id === editing!.id);
			if (fresh) editing = fresh;
		}
	});

	function onConsider(e: CustomEvent<DndEvent<Task>>) {
		tasks = e.detail.items;
		// A keyboard drag emits a trailing `consider` with trigger `dragStopped`
		// *after* finalize — don't let it re-arm the guard, or live updates freeze.
		dragging = e.detail.info.trigger !== 'dragStopped';
	}
	function onFinalize(e: CustomEvent<DndEvent<Task>>) {
		tasks = e.detail.items;
		const movedId = e.detail.info.id;
		if (movedId) moveInList(tasks, movedId, meta.order);
		dragging = false;
	}
</script>

<main class="h-full min-w-0 flex-1 overflow-y-auto">
	<div
		class="mx-auto flex max-w-[720px] flex-col gap-[14px] px-6 pt-[28px] pb-20 max-[640px]:px-[14px] max-[640px]:pt-[18px] max-[640px]:pb-[calc(84px+env(safe-area-inset-bottom))]"
	>
		<header class="flex items-center gap-2.5">
			<h1 class="m-0 flex items-center gap-[9px] text-[20px] font-[650]">
				<Icon name={meta.icon} size={20} />
				{meta.title}
			</h1>
			<span class="rounded-[20px] border border-border bg-card px-[9px] py-px text-[13px] text-muted-foreground/70"
				>{tasks.length}</span
			>
		</header>

		<Composer projectId={meta.projectId} plannedDate={meta.planned} />

		{#if tasks.length === 0 && completedTasks.length === 0}
			<p class="px-1 py-6 text-muted-foreground/70">Nothing here. Add your first task above.</p>
		{:else if meta.manual}
			<section
				class="flex flex-col gap-0.5 outline-none"
				use:dndzone={{ items: tasks, flipDurationMs: 160, dropTargetStyle: {} }}
				onconsider={onConsider}
				onfinalize={onFinalize}
			>
				{#each tasks as task (task.id)}
					<div class="dnd-item">
						<TaskRow
							{task}
							project={task.projectId ? projectMap.get(task.projectId) : null}
							onopen={(t) => (editing = t)}
						/>
					</div>
				{/each}
			</section>
		{:else}
			<section class="flex flex-col gap-0.5 outline-none">
				{#each tasks as task (task.id)}
					<TaskRow
						{task}
						project={task.projectId ? projectMap.get(task.projectId) : null}
						onopen={(t) => (editing = t)}
					/>
				{/each}
			</section>
		{/if}

		{#if completedTasks.length > 0}
			<section class="mt-1.5 flex flex-col gap-0.5 border-t border-border pt-3">
				<h2
					class="mt-0 mr-0 mb-1 ml-2.5 text-[12px] font-semibold tracking-[0.04em] text-muted-foreground/70 uppercase"
				>
					Completed
				</h2>
				<div class="flex flex-col gap-0.5 outline-none">
					{#each completedTasks as task (task.id)}
						<TaskRow
							{task}
							project={task.projectId ? projectMap.get(task.projectId) : null}
							onopen={(t) => (editing = t)}
						/>
					{/each}
				</div>
			</section>
		{/if}
	</div>

	{#if editing}
		<TaskEditor task={editing} {projects} onclose={() => (editing = null)} />
	{/if}
</main>
