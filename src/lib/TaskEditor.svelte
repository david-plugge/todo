<script lang="ts">
	import type { Task, Project, ISODate } from './types';
	import { updateTask, deleteTask, toggleComplete } from './store';
	import { todayISO, addDaysISO, relativeLabel } from './date';
	import Icon from './Icon.svelte';

	let { task, projects, onclose }: { task: Task; projects: Project[]; onclose: () => void } =
		$props();

	// Local editable copies; commit to the store on change (debounced for text).
	let title = $state(task.title);
	let notes = $state(task.notes);
	let plannedDate = $state<ISODate | null>(task.plannedDate);
	let dueDate = $state<ISODate | null>(task.dueDate);
	let projectId = $state<string | null>(task.projectId);

	// Reset locals only when a *different* task is opened, so background
	// re-emits from the live query don't clobber in-progress edits.
	let loadedId = $state(task.id);
	$effect(() => {
		if (task.id !== loadedId) {
			loadedId = task.id;
			title = task.title;
			notes = task.notes;
			plannedDate = task.plannedDate;
			dueDate = task.dueDate;
			projectId = task.projectId;
		}
	});

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function saveText() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			updateTask(task.id, { title: title.trim(), notes });
		}, 250);
	}

	function setPlanned(v: ISODate | null) {
		plannedDate = v;
		updateTask(task.id, { plannedDate: v });
	}
	function setDue(v: ISODate | null) {
		dueDate = v;
		updateTask(task.id, { dueDate: v });
	}
	function setProject(v: string) {
		projectId = v === '' ? null : v;
		updateTask(task.id, { projectId });
	}

	function remove() {
		deleteTask(task.id);
		onclose();
	}

	const today = todayISO();

	const fieldLabel =
		'flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground';
	const control =
		'rounded-md border border-border bg-card px-[9px] py-[7px] text-foreground outline-none focus:border-primary';
	const chipBtn =
		'rounded-[20px] border border-border bg-card px-[9px] py-[3px] text-[12px] text-muted-foreground transition-all duration-[.12s]';
</script>

<div
	class="fixed inset-0 z-20 bg-black/[0.18] [animation:fade_0.15s_ease]"
	onclick={onclose}
	role="presentation"
></div>
<div
	class="fixed inset-y-0 right-0 z-[21] flex w-[380px] max-w-[92vw] flex-col gap-[14px] overflow-y-auto border-l border-border bg-background p-4 shadow-pop [animation:slide_0.18s_cubic-bezier(0.2,0.8,0.2,1)] max-[640px]:w-full max-[640px]:max-w-full"
	role="dialog"
	aria-modal="true"
	aria-label="Edit task"
>
	<header class="flex items-center justify-between">
		<button
			class={[
				'inline-flex items-center gap-2 rounded-[20px] border py-[5px] pr-3 pl-2 transition-all duration-[.12s]',
				task.completed
					? 'border-primary bg-primary text-white'
					: 'border-border-strong bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
			]}
			onclick={() => toggleComplete(task)}
		>
			{#if task.completed}<Icon name="check" size={12} />{/if}
			<span>{task.completed ? 'Completed' : 'Mark complete'}</span>
		</button>
		<button
			class="flex rounded-md border-0 bg-transparent p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
			aria-label="Close"
			onclick={onclose}><Icon name="x" size={17} /></button
		>
	</header>

	<input
		class="border-0 bg-transparent px-0 py-[2px] text-[17px] font-semibold outline-none"
		bind:value={title}
		oninput={saveText}
		placeholder="Task title"
	/>

	<textarea
		class="resize-y rounded-md border border-border bg-card px-2.5 py-2 leading-normal outline-none focus:border-primary"
		bind:value={notes}
		oninput={saveText}
		placeholder="Notes…"
		rows="3"></textarea>

	<div class="flex flex-col gap-[7px]">
		<label class={fieldLabel} for="editor-project">Project</label>
		<select
			class={control}
			id="editor-project"
			value={projectId ?? ''}
			onchange={(e) => setProject(e.currentTarget.value)}
		>
			<option value="">Inbox</option>
			{#each projects as p (p.id)}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>
	</div>

	<div class="flex flex-col gap-[7px]">
		<label class={fieldLabel} for="editor-planned"
			><Icon name="calendar" size={13} /> Planned {#if plannedDate}<span
					class="font-medium tracking-normal normal-case text-primary"
					>· {relativeLabel(plannedDate)}</span
				>{/if}</label
		>
		<div class="flex flex-col gap-[7px]">
			<input
				class={control}
				id="editor-planned"
				type="date"
				value={plannedDate ?? ''}
				onchange={(e) => setPlanned(e.currentTarget.value || null)}
			/>
			<div class="flex flex-wrap gap-[5px]">
				<button
					class={[chipBtn, 'hover:border-primary hover:text-foreground']}
					onclick={() => setPlanned(today)}>Today</button
				>
				<button
					class={[chipBtn, 'hover:border-primary hover:text-foreground']}
					onclick={() => setPlanned(addDaysISO(today, 1))}>Tomorrow</button
				>
				<button
					class={[chipBtn, 'hover:border-primary hover:text-foreground']}
					onclick={() => setPlanned(addDaysISO(today, 7))}>Next week</button
				>
				{#if plannedDate}<button
						class={[chipBtn, 'hover:border-destructive hover:text-destructive']}
						onclick={() => setPlanned(null)}>Clear</button
					>{/if}
			</div>
		</div>
	</div>

	<div class="flex flex-col gap-[7px]">
		<label class={fieldLabel} for="editor-due"
			><Icon name="flag" size={13} /> Due {#if dueDate}<span
					class="font-medium tracking-normal normal-case text-primary"
					>· {relativeLabel(dueDate)}</span
				>{/if}</label
		>
		<div class="flex flex-col gap-[7px]">
			<input
				class={control}
				id="editor-due"
				type="date"
				value={dueDate ?? ''}
				onchange={(e) => setDue(e.currentTarget.value || null)}
			/>
			<div class="flex flex-wrap gap-[5px]">
				<button class={[chipBtn, 'hover:border-primary hover:text-foreground']} onclick={() => setDue(today)}
					>Today</button
				>
				<button
					class={[chipBtn, 'hover:border-primary hover:text-foreground']}
					onclick={() => setDue(addDaysISO(today, 1))}>Tomorrow</button
				>
				<button
					class={[chipBtn, 'hover:border-primary hover:text-foreground']}
					onclick={() => setDue(addDaysISO(today, 7))}>Next week</button
				>
				{#if dueDate}<button
						class={[chipBtn, 'hover:border-destructive hover:text-destructive']}
						onclick={() => setDue(null)}>Clear</button
					>{/if}
			</div>
		</div>
	</div>

	<footer class="mt-auto pt-2">
		<button
			class="inline-flex items-center gap-[7px] rounded-md border border-border bg-transparent px-3 py-[7px] text-destructive transition-all duration-[.12s] hover:border-destructive hover:bg-destructive/10"
			onclick={remove}><Icon name="trash" size={15} /> Delete task</button
		>
	</footer>
</div>

<style>
	@keyframes -global-fade {
		from {
			opacity: 0;
		}
	}
	@keyframes -global-slide {
		from {
			transform: translateX(20px);
			opacity: 0;
		}
	}
</style>
