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

<main>
	<div class="inner">
		<header class="page-head">
			<h1><Icon name={meta.icon} size={20} /> {meta.title}</h1>
			<span class="count">{tasks.length}</span>
		</header>

		<Composer projectId={meta.projectId} plannedDate={meta.planned} />

		{#if tasks.length === 0 && completedTasks.length === 0}
			<p class="empty">Nothing here. Add your first task above.</p>
		{:else if meta.manual}
			<section
				class="list"
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
			<section class="list">
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
			<section class="completed">
				<h2 class="completed-head">Completed</h2>
				<div class="list">
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

<style>
	main {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		height: 100%;
	}
	.inner {
		max-width: 720px;
		margin: 0 auto;
		padding: 28px 24px 80px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	/* Tighter gutters on phones, and clear the fixed bottom tab bar. */
	@media (max-width: 640px) {
		.inner {
			padding: 18px 14px calc(84px + env(safe-area-inset-bottom));
		}
	}
	.page-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	h1 {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 20px;
		font-weight: 650;
		margin: 0;
	}
	.count {
		font-size: 13px;
		color: var(--text-faint);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 20px;
		padding: 1px 9px;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		outline: none;
	}
	.empty {
		color: var(--text-faint);
		padding: 24px 4px;
	}
	/* Completed-today tasks: a separate, unordered list below the open ones. */
	.completed {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 6px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.completed-head {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
		margin: 0 0 4px 10px;
	}
</style>
