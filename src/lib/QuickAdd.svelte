<script lang="ts">
	import type { ID, ISODate } from './types';
	import { addTask, projects } from './store';
	import * as Popover from './components/ui/popover';
	import * as Command from './components/ui/command';
	import Icon from './Icon.svelte';
	import DateField from './DateField.svelte';

	let title = $state('');
	let notes = $state('');
	let plannedDate = $state<ISODate | null>(null);
	let dueDate = $state<ISODate | null>(null);
	let projectId = $state<ID | null>(null);

	// The date pickers own their own open state (DateField). Only the project
	// popover is coordinated here.
	let projectOpen = $state(false);

	let titleEl = $state<HTMLInputElement>();
	let card = $state<HTMLElement>();

	const selectedProject = $derived($projects.find((p) => p.id === projectId) ?? null);

	function pickProject(id: ID | null) {
		projectId = id;
		projectOpen = false;
	}

	function reset() {
		title = '';
		notes = '';
		plannedDate = null;
		dueDate = null;
		projectId = null;
		projectOpen = false;
	}

	async function hideWindow() {
		try {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			await getCurrentWindow().hide();
		} catch {
			/* running in a plain browser — nothing to hide */
		}
	}

	async function submit() {
		const t = title.trim();
		if (!t) return;
		await addTask({ title: t, notes: notes.trim() || undefined, plannedDate, dueDate, projectId });
		reset();
		await hideWindow();
	}

	function cancel() {
		reset();
		hideWindow();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			// bits-ui closes an open popover on Escape and marks the event
			// defaultPrevented; that keydown still bubbles here, so only cancel the
			// window when no popover consumed the Escape.
			if (!e.defaultPrevented) cancel();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		}
	}

	// The window is a large transparent overlay. A click outside the card (in the
	// transparent area) dismisses it like a modal. Popover content is portalled
	// outside the card, so ignore clicks landing inside one — bits-ui closes those.
	function onPointerDown(e: PointerEvent) {
		const t = e.target as Element | null;
		if (!t || !card) return;
		if (t.closest('[data-slot="popover-content"]')) return;
		if (!card.contains(t)) cancel();
	}

	// Focus the title on show; refocus when the hotkey re-shows the window, and
	// hide when the window loses focus (clicked another app) so the invisible
	// overlay never lingers on top.
	$effect(() => {
		titleEl?.focus();
		let unlisten: (() => void) | undefined;
		(async () => {
			try {
				const { getCurrentWindow } = await import('@tauri-apps/api/window');
				unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
					if (focused) titleEl?.focus();
					else hideWindow();
				});
			} catch {
				/* not in Tauri */
			}
		})();
		return () => unlisten?.();
	});
</script>

<svelte:window onkeydown={onKey} onpointerdown={onPointerDown} />

<div
	bind:this={card}
	class="mx-auto mt-4 flex w-[560px] flex-col rounded-[14px] border border-border-strong bg-background"
	data-tauri-drag-region
>
	<!-- Title + description + field pills -->
	<div class="flex flex-col gap-1 px-[18px] pt-[18px] pb-3.5">
		<input
			bind:this={titleEl}
			bind:value={title}
			class="border-none bg-transparent text-xl font-medium leading-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/70"
			placeholder="Task name"
			autocomplete="off"
			spellcheck="false"
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					submit();
				}
			}}
		/>
		<input
			bind:value={notes}
			class="border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
			placeholder="Description"
			autocomplete="off"
			spellcheck="false"
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					submit();
				}
			}}
		/>

		<div class="mt-2.5 flex gap-2">
			<DateField bind:value={plannedDate} icon="today" emptyLabel="Date" />
			<DateField bind:value={dueDate} icon="flag" emptyLabel="Due" />
		</div>
	</div>

	<!-- Footer: project picker + actions -->
	<div class="flex items-center justify-between border-t border-border px-[18px] py-2.5">
		<Popover.Root bind:open={projectOpen}>
			<Popover.Trigger
				class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				{#if selectedProject}
					<span
						class="h-2.5 w-2.5 flex-none rounded-full"
						style="background:{selectedProject.color}"
					></span>
				{:else}
					<Icon name="inbox" size={15} />
				{/if}
				{selectedProject ? selectedProject.name : 'Inbox'}
				<Icon name="chevron-down" size={14} />
			</Popover.Trigger>
			<Popover.Content align="start" class="w-56 p-0">
				<Command.Root>
					<Command.Input placeholder="Search projects…" />
					<Command.List>
						<Command.Empty>No projects found.</Command.Empty>
						<Command.Group>
							<Command.Item
								value="Inbox"
								class={projectId === null ? 'text-primary' : 'text-foreground'}
								onSelect={() => pickProject(null)}
							>
								<Icon name="inbox" size={15} /> Inbox
							</Command.Item>
							{#each $projects as p (p.id)}
								<Command.Item
									value={p.name}
									class={projectId === p.id ? 'text-primary' : 'text-foreground'}
									onSelect={() => pickProject(p.id)}
								>
									<span class="h-2.5 w-2.5 flex-none rounded-full" style="background:{p.color}"
									></span>
									{p.name}
								</Command.Item>
							{/each}
						</Command.Group>
					</Command.List>
				</Command.Root>
			</Popover.Content>
		</Popover.Root>

		<div class="flex items-center gap-2">
			<button
				type="button"
				class="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
				onclick={cancel}
			>
				Cancel
			</button>
			<button
				type="button"
				class="rounded-md bg-primary px-3.5 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
				disabled={!title.trim()}
				onclick={submit}
			>
				Add task
			</button>
		</div>
	</div>
</div>

<style>
	:global(html),
	:global(body) {
		/* Fixed overlay window — never show a scrollbar; the desktop shows through. */
		overflow: hidden;
		background: transparent;
	}
</style>
