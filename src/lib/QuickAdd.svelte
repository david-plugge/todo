<script lang="ts">
	import type { ID, ISODate } from './types';
	import { addTask, projects } from './store';
	import { todayISO, addDaysISO, relativeLabel } from './date';
	import { toDateValue, fromDateValue } from './calendar-date';
	import * as Popover from './components/ui/popover';
	import * as Command from './components/ui/command';
	import { Calendar } from './components/ui/calendar';
	import Icon from './Icon.svelte';

	type Picker = 'planned' | 'due' | 'project';

	let title = $state('');
	let notes = $state('');
	let plannedDate = $state<ISODate | null>(null);
	let dueDate = $state<ISODate | null>(null);
	let projectId = $state<ID | null>(null);

	// Only one popover is ever open at a time. Each Popover's `open` is a function
	// binding over this shared enum, so opening one closes the others; the setter
	// only nulls the enum when the closing popover is the one still recorded, which
	// keeps the state correct regardless of open/close event ordering.
	let open = $state<Picker | null>(null);
	const setOpen = (field: Picker) => (v: boolean) => {
		if (v) open = field;
		else if (open === field) open = null;
	};

	let titleEl = $state<HTMLInputElement>();
	let card = $state<HTMLElement>();

	const today = todayISO();
	const selectedProject = $derived($projects.find((p) => p.id === projectId) ?? null);

	const dow = (iso: ISODate) => {
		const [y, m, d] = iso.split('-').map(Number);
		return new Date(y, m - 1, d).getDay();
	};
	/** The next date strictly after today that falls on weekday `target` (0=Sun…6=Sat). */
	const nextDow = (target: number): ISODate => {
		let add = (target - dow(today) + 7) % 7;
		if (add === 0) add = 7;
		return addDaysISO(today, add);
	};
	const fmt = (iso: ISODate, opts: Intl.DateTimeFormatOptions): string => {
		const [y, m, d] = iso.split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
	};
	const tomorrow = addDaysISO(today, 1);
	const nextWeek = nextDow(1); // Monday
	const nextWeekend = nextDow(6); // Saturday

	const quickDates = [
		{
			label: 'Today',
			icon: 'today',
			color: '#22c55e',
			date: today,
			hint: fmt(today, { weekday: 'short' }),
		},
		{
			label: 'Tomorrow',
			icon: 'sun',
			color: '#f59e0b',
			date: tomorrow,
			hint: fmt(tomorrow, { weekday: 'short' }),
		},
		{
			label: 'Next week',
			icon: 'next',
			color: '#8b5cf6',
			date: nextWeek,
			hint: fmt(nextWeek, { weekday: 'short', day: 'numeric', month: 'short' }),
		},
		{
			label: 'Next weekend',
			icon: 'weekend',
			color: '#06b6d4',
			date: nextWeekend,
			hint: fmt(nextWeekend, { weekday: 'short', day: 'numeric', month: 'short' }),
		},
	];

	function setDate(field: 'planned' | 'due', iso: ISODate | null) {
		if (field === 'planned') plannedDate = iso;
		else dueDate = iso;
		open = null;
	}

	function pickProject(id: ID | null) {
		projectId = id;
		open = null;
	}

	function reset() {
		title = '';
		notes = '';
		plannedDate = null;
		dueDate = null;
		projectId = null;
		open = null;
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

{#snippet datePopover(field: 'planned' | 'due', value: ISODate | null)}
	<div class="flex flex-col py-1.5">
		{#each quickDates as q (q.label)}
			<button
				type="button"
				class="flex items-center gap-3 px-3 py-1.5 text-left text-[14px] text-foreground hover:bg-accent"
				onclick={() => setDate(field, q.date)}
			>
				<span class="flex" style="color:{q.color}"><Icon name={q.icon} size={17} /></span>
				<span class="flex-1">{q.label}</span>
				<span class="text-[13px] text-muted-foreground/70">{q.hint}</span>
			</button>
		{/each}
	</div>

	<div class="border-t border-border">
		<Calendar
			type="single"
			weekStartsOn={1}
			value={toDateValue(value)}
			onValueChange={(v) => setDate(field, fromDateValue(v))}
		/>
	</div>
{/snippet}

{#snippet datePill(
	props: Record<string, unknown>,
	field: 'planned' | 'due',
	icon: string,
	emptyLabel: string,
	value: ISODate | null,
)}
	<button
		{...props}
		type="button"
		class={[
			'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors',
			value || open === field
				? 'border-primary/40 bg-primary/10 text-primary'
				: 'border-border-strong bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
		]}
	>
		<Icon name={icon} size={15} />
		{value ? relativeLabel(value) : emptyLabel}
		{#if value}
			<span
				class="-mr-1 ml-0.5 flex rounded-full p-0.5 hover:bg-primary/20"
				role="button"
				tabindex="-1"
				aria-label="Clear {emptyLabel}"
				onclick={(e) => {
					e.stopPropagation();
					setDate(field, null);
				}}
				onkeydown={() => {}}
			>
				<Icon name="x" size={13} />
			</span>
		{/if}
	</button>
{/snippet}

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
			class="border-none bg-transparent text-[24px] font-medium leading-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/70"
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
			class="border-none bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70"
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
			<Popover.Root bind:open={() => open === 'planned', setOpen('planned')}>
				<Popover.Trigger>
					{#snippet child({ props })}
						{@render datePill(props, 'planned', 'today', 'Date', plannedDate)}
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="start" class="w-auto overflow-hidden p-0">
					{@render datePopover('planned', plannedDate)}
				</Popover.Content>
			</Popover.Root>

			<Popover.Root bind:open={() => open === 'due', setOpen('due')}>
				<Popover.Trigger>
					{#snippet child({ props })}
						{@render datePill(props, 'due', 'flag', 'Due', dueDate)}
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="start" class="w-auto overflow-hidden p-0">
					{@render datePopover('due', dueDate)}
				</Popover.Content>
			</Popover.Root>
		</div>
	</div>

	<!-- Footer: project picker + actions -->
	<div class="flex items-center justify-between border-t border-border px-[18px] py-2.5">
		<Popover.Root bind:open={() => open === 'project', setOpen('project')}>
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
