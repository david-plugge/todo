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

	const chip =
		'inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-card px-[7px] py-[2px] text-[12px] text-muted-foreground';
</script>

<div
	class="group flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[9px] transition-colors duration-[.12s] select-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
	role="button"
	tabindex="0"
	onclick={() => onopen(task)}
	onkeydown={(e) => {
		if (e.key === 'Enter') onopen(task);
	}}
>
	<span
		class="-ml-1 flex cursor-grab text-muted-foreground/70 opacity-0 transition-opacity duration-[.12s] group-hover:opacity-100"
		aria-hidden="true"><Icon name="grip" size={15} /></span
	>

	<button
		class={[
			'grid h-[19px] w-[19px] flex-none place-items-center rounded-full border-[1.7px] p-0 text-white transition-all duration-[.12s]',
			task.completed
				? 'border-primary bg-primary'
				: 'border-border-strong bg-transparent hover:border-primary',
		]}
		aria-label={task.completed ? 'Mark incomplete' : 'Mark complete'}
		onclick={(e) => {
			e.stopPropagation();
			toggleComplete(task);
		}}
	>
		{#if task.completed}<Icon name="check" size={12} />{/if}
	</button>

	<div class="flex min-w-0 flex-1 flex-col gap-px">
		<span class={['truncate', task.completed && 'text-muted-foreground/70 line-through']}
			>{task.title || 'Untitled'}</span
		>
		{#if task.notes}<span class="truncate text-[12.5px] text-muted-foreground">{task.notes}</span
			>{/if}
	</div>

	<div class="flex flex-none items-center gap-1.5">
		{#if project}
			<span class={chip}>
				<span class="h-[7px] w-[7px] rounded-full" style="background:{project.color}"
				></span>{project.name}
			</span>
		{/if}
		{#if task.plannedDate}
			<span class={chip}><Icon name="calendar" size={12} />{plannedLabel}</span>
		{/if}
		{#if task.dueDate}
			<span class={[chip, overdue && 'border-destructive/35 text-destructive']}
				><Icon name="flag" size={12} />{dueLabel}</span
			>
		{/if}
	</div>
</div>
