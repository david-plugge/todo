<script lang="ts">
	import type { Task, Project, ISODate } from './types';
	import { updateTask, deleteTask, toggleComplete } from './store';
	import Icon from './Icon.svelte';
	import DateField from './DateField.svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';

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

	const selectedProjectName = $derived(projects.find((p) => p.id === projectId)?.name ?? 'Inbox');

	const fieldLabel =
		'flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground';
	const control =
		'rounded-md border border-border bg-card px-[9px] py-[7px] text-foreground outline-none focus:border-primary';
</script>

<Sheet.Root open onOpenChange={(v) => !v && onclose()}>
	<Sheet.Content
		side="right"
		showCloseButton={false}
		aria-label="Edit task"
		class="w-[380px]! max-w-[92vw]! gap-[14px] overflow-y-auto bg-background p-4 max-[640px]:w-full! max-[640px]:max-w-full!"
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

		<Textarea
			class="resize-y"
			bind:value={notes}
			oninput={saveText}
			placeholder="Notes…"
			rows={3}
		/>

		<div class="flex flex-col gap-[7px]">
			<Label class={fieldLabel} for="editor-project">Project</Label>
			<Select.Root type="single" value={projectId ?? ''} onValueChange={setProject}>
				<Select.Trigger id="editor-project" class={[control, 'w-full']}>
					{selectedProjectName}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="Inbox">Inbox</Select.Item>
					{#each projects as p (p.id)}
						<Select.Item value={p.id} label={p.name}>{p.name}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<div class="flex flex-col gap-[7px]">
			<span class={fieldLabel}><Icon name="calendar" size={13} /> Planned</span>
			<DateField value={plannedDate} onchange={setPlanned} icon="calendar" emptyLabel="No date" />
		</div>

		<div class="flex flex-col gap-[7px]">
			<span class={fieldLabel}><Icon name="flag" size={13} /> Due</span>
			<DateField value={dueDate} onchange={setDue} icon="flag" emptyLabel="No date" />
		</div>

		<footer class="mt-auto pt-2">
			<Button
				variant="outline"
				class="text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
				onclick={remove}><Icon name="trash" size={15} /> Delete task</Button
			>
		</footer>
	</Sheet.Content>
</Sheet.Root>
