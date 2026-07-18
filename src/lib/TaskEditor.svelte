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
</script>

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="drawer" role="dialog" aria-modal="true" aria-label="Edit task">
	<header>
		<button class="check" class:done={task.completed} onclick={() => toggleComplete(task)}>
			{#if task.completed}<Icon name="check" size={12} />{/if}
			<span>{task.completed ? 'Completed' : 'Mark complete'}</span>
		</button>
		<button class="icon-btn" aria-label="Close" onclick={onclose}
			><Icon name="x" size={17} /></button
		>
	</header>

	<input class="title-input" bind:value={title} oninput={saveText} placeholder="Task title" />

	<textarea class="notes-input" bind:value={notes} oninput={saveText} placeholder="Notes…" rows="3"
	></textarea>

	<div class="field">
		<label for="editor-project">Project</label>
		<select
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

	<div class="field">
		<label for="editor-planned"
			><Icon name="calendar" size={13} /> Planned {#if plannedDate}<span class="rel"
					>· {relativeLabel(plannedDate)}</span
				>{/if}</label
		>
		<div class="date-row">
			<input
				id="editor-planned"
				type="date"
				value={plannedDate ?? ''}
				onchange={(e) => setPlanned(e.currentTarget.value || null)}
			/>
			<div class="chips">
				<button onclick={() => setPlanned(today)}>Today</button>
				<button onclick={() => setPlanned(addDaysISO(today, 1))}>Tomorrow</button>
				<button onclick={() => setPlanned(addDaysISO(today, 7))}>Next week</button>
				{#if plannedDate}<button class="clear" onclick={() => setPlanned(null)}>Clear</button>{/if}
			</div>
		</div>
	</div>

	<div class="field">
		<label for="editor-due"
			><Icon name="flag" size={13} /> Due {#if dueDate}<span class="rel"
					>· {relativeLabel(dueDate)}</span
				>{/if}</label
		>
		<div class="date-row">
			<input
				id="editor-due"
				type="date"
				value={dueDate ?? ''}
				onchange={(e) => setDue(e.currentTarget.value || null)}
			/>
			<div class="chips">
				<button onclick={() => setDue(today)}>Today</button>
				<button onclick={() => setDue(addDaysISO(today, 1))}>Tomorrow</button>
				<button onclick={() => setDue(addDaysISO(today, 7))}>Next week</button>
				{#if dueDate}<button class="clear" onclick={() => setDue(null)}>Clear</button>{/if}
			</div>
		</div>
	</div>

	<footer>
		<button class="danger" onclick={remove}><Icon name="trash" size={15} /> Delete task</button>
	</footer>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.18);
		animation: fade 0.15s ease;
		z-index: 20;
	}
	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 380px;
		max-width: 92vw;
		background: var(--bg);
		border-left: 1px solid var(--border);
		box-shadow: var(--shadow-lg);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
		z-index: 21;
		animation: slide 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-dim);
		padding: 5px 12px 5px 8px;
		border-radius: 20px;
		transition: all 0.12s;
	}
	.check:hover {
		border-color: var(--accent);
		color: var(--text);
	}
	.check.done {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.icon-btn {
		background: transparent;
		border: none;
		color: var(--text-dim);
		padding: 6px;
		border-radius: var(--radius-sm);
		display: flex;
	}
	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.title-input {
		border: none;
		background: transparent;
		outline: none;
		font-size: 17px;
		font-weight: 600;
		padding: 2px 0;
	}
	.notes-input {
		border: 1px solid var(--border);
		background: var(--bg-elev);
		border-radius: var(--radius-sm);
		padding: 8px 10px;
		outline: none;
		resize: vertical;
		line-height: 1.5;
	}
	.notes-input:focus {
		border-color: var(--accent);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.field > label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.rel {
		text-transform: none;
		font-weight: 500;
		letter-spacing: 0;
		color: var(--accent);
	}
	select,
	input[type='date'] {
		border: 1px solid var(--border);
		background: var(--bg-elev);
		border-radius: var(--radius-sm);
		padding: 7px 9px;
		outline: none;
		color: var(--text);
	}
	select:focus,
	input[type='date']:focus {
		border-color: var(--accent);
	}
	.date-row {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.chips button {
		font-size: 12px;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		padding: 3px 9px;
		border-radius: 20px;
		transition: all 0.12s;
	}
	.chips button:hover {
		border-color: var(--accent);
		color: var(--text);
	}
	.chips button.clear:hover {
		border-color: var(--danger);
		color: var(--danger);
	}
	footer {
		margin-top: auto;
		padding-top: 8px;
	}
	.danger {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--danger);
		padding: 7px 12px;
		border-radius: var(--radius-sm);
		transition: all 0.12s;
	}
	.danger:hover {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		border-color: var(--danger);
	}
	/* Full-width editor on phones (dismiss via the close button). */
	@media (max-width: 640px) {
		.drawer {
			width: 100%;
			max-width: 100%;
		}
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes slide {
		from {
			transform: translateX(20px);
			opacity: 0;
		}
	}
</style>
