<script lang="ts">
	import type { Task, Project } from './types';
	import { relativeLabel, isOverdue } from './date';
	import { toggleComplete } from './store';
	import Icon from './Icon.svelte';

	let {
		task,
		project = null,
		onopen,
	}: { task: Task; project?: Project | null; onopen: (t: Task) => void } = $props();

	const dueLabel = $derived(relativeLabel(task.dueDate));
	const plannedLabel = $derived(relativeLabel(task.plannedDate));
	const overdue = $derived(isOverdue(task.dueDate));
</script>

<div
	class="row"
	role="button"
	tabindex="0"
	onclick={() => onopen(task)}
	onkeydown={(e) => {
		if (e.key === 'Enter') onopen(task);
	}}
>
	<span class="grip" aria-hidden="true"><Icon name="grip" size={15} /></span>

	<button
		class="check"
		class:done={task.completed}
		aria-label={task.completed ? 'Mark incomplete' : 'Mark complete'}
		onclick={(e) => {
			e.stopPropagation();
			toggleComplete(task);
		}}
	>
		{#if task.completed}<Icon name="check" size={12} />{/if}
	</button>

	<div class="body">
		<span class="title" class:done={task.completed}>{task.title || 'Untitled'}</span>
		{#if task.notes}<span class="notes">{task.notes}</span>{/if}
	</div>

	<div class="meta">
		{#if project}
			<span class="chip project" style="--dot:{project.color}">
				<span class="pdot" style="background:{project.color}"></span>{project.name}
			</span>
		{/if}
		{#if task.plannedDate}
			<span class="chip"><Icon name="calendar" size={12} />{plannedLabel}</span>
		{/if}
		{#if task.dueDate}
			<span class="chip due" class:overdue><Icon name="flag" size={12} />{dueLabel}</span>
		{/if}
	</div>
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 10px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		user-select: none;
		transition: background 0.12s;
	}
	.row:hover {
		background: var(--bg-hover);
	}
	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.grip {
		color: var(--text-faint);
		opacity: 0;
		cursor: grab;
		display: flex;
		transition: opacity 0.12s;
		margin-left: -4px;
	}
	.row:hover .grip {
		opacity: 1;
	}
	.check {
		flex: none;
		width: 19px;
		height: 19px;
		border-radius: 50%;
		border: 1.7px solid var(--border-strong);
		background: transparent;
		color: #fff;
		display: grid;
		place-items: center;
		padding: 0;
		transition: all 0.12s;
	}
	.check:hover {
		border-color: var(--accent);
	}
	.check.done {
		background: var(--accent);
		border-color: var(--accent);
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.title.done {
		color: var(--text-faint);
		text-decoration: line-through;
	}
	.notes {
		font-size: 12.5px;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		padding: 2px 7px;
		border-radius: 20px;
		white-space: nowrap;
	}
	.chip.due.overdue {
		color: var(--overdue);
		border-color: color-mix(in srgb, var(--overdue) 35%, transparent);
	}
	.pdot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}
</style>
