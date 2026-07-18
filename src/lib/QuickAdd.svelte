<script lang="ts">
	import type { ID, ISODate } from './types';
	import { addTask, projects } from './store';
	import { todayISO, addDaysISO, relativeLabel } from './date';
	import Icon from './Icon.svelte';

	type Picker = 'planned' | 'due' | 'project';

	let title = $state('');
	let notes = $state('');
	let plannedDate = $state<ISODate | null>(null);
	let dueDate = $state<ISODate | null>(null);
	let projectId = $state<ID | null>(null);

	// Only one popover is ever open at a time.
	let open = $state<Picker | null>(null);

	let titleEl = $state<HTMLInputElement>();
	let card = $state<HTMLElement>();
	let plannedWrap = $state<HTMLElement>();
	let dueWrap = $state<HTMLElement>();
	let projWrap = $state<HTMLElement>();

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
		{ label: 'Today', icon: 'today', color: '#22c55e', date: today, hint: fmt(today, { weekday: 'short' }) },
		{ label: 'Tomorrow', icon: 'sun', color: '#f59e0b', date: tomorrow, hint: fmt(tomorrow, { weekday: 'short' }) },
		{ label: 'Next week', icon: 'next', color: '#8b5cf6', date: nextWeek, hint: fmt(nextWeek, { weekday: 'short', day: 'numeric', month: 'short' }) },
		{ label: 'Next weekend', icon: 'weekend', color: '#06b6d4', date: nextWeekend, hint: fmt(nextWeekend, { weekday: 'short', day: 'numeric', month: 'short' }) },
	];

	let viewY = $state(Number(today.slice(0, 4)));
	let viewM = $state(Number(today.slice(5, 7))); // 1-12
	const weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

	const monthCells = $derived.by(() => {
		const first = new Date(viewY, viewM - 1, 1);
		const startDow = (first.getDay() + 6) % 7; // Monday-first offset
		const start = new Date(viewY, viewM - 1, 1 - startDow);
		return Array.from({ length: 42 }, (_, i) => {
			const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
			return { iso: todayISO(d), day: d.getDate(), inMonth: d.getMonth() === viewM - 1 };
		});
	});
	const monthLabel = $derived(fmt(`${viewY}-${String(viewM).padStart(2, '0')}-01`, { month: 'short', year: 'numeric' }));

	function shiftMonth(delta: number) {
		let m = viewM + delta;
		let y = viewY;
		if (m < 1) {
			m = 12;
			y--;
		} else if (m > 12) {
			m = 1;
			y++;
		}
		viewM = m;
		viewY = y;
	}

	function openDate(field: 'planned' | 'due') {
		if (open === field) {
			open = null;
			return;
		}
		const cur = field === 'planned' ? plannedDate : dueDate;
		if (cur) {
			viewY = Number(cur.slice(0, 4));
			viewM = Number(cur.slice(5, 7));
		}
		open = field;
	}
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
			if (open) open = null;
			else cancel();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		}
	}

	// The window is a large transparent overlay. A click outside the card (in the
	// transparent area) dismisses it like a modal; a click inside the card but
	// outside the open popover just closes the popover.
	function onPointerDown(e: PointerEvent) {
		const t = e.target as Node | null;
		if (!t || !card) return;
		if (!card.contains(t)) {
			cancel();
			return;
		}
		const wrap = open === 'planned' ? plannedWrap : open === 'due' ? dueWrap : open === 'project' ? projWrap : undefined;
		if (open && wrap && !wrap.contains(t)) open = null;
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

{#snippet dateCalendar(selected: ISODate | null, pick: (iso: ISODate) => void)}
	<div
		class="w-[290px] overflow-hidden rounded-lg border border-border-strong bg-card shadow-pop"
	>
		<div class="flex flex-col py-1.5">
			{#each quickDates as q (q.label)}
				<button
					type="button"
					class="flex items-center gap-3 px-3 py-1.5 text-left text-[14px] text-foreground hover:bg-accent"
					onclick={() => pick(q.date)}
				>
					<span class="flex" style="color:{q.color}"><Icon name={q.icon} size={17} /></span>
					<span class="flex-1">{q.label}</span>
					<span class="text-[13px] text-muted-foreground/70">{q.hint}</span>
				</button>
			{/each}
		</div>

		<div class="border-t border-border px-3 pt-2.5 pb-3">
			<div class="mb-1.5 flex items-center justify-between">
				<span class="text-[13px] font-semibold">{monthLabel}</span>
				<div class="flex gap-0.5">
					<button
						type="button"
						class="flex rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						aria-label="Previous month"
						onclick={() => shiftMonth(-1)}
					>
						<Icon name="chevron-left" size={16} />
					</button>
					<button
						type="button"
						class="flex rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						aria-label="Next month"
						onclick={() => shiftMonth(1)}
					>
						<Icon name="chevron-right" size={16} />
					</button>
				</div>
			</div>
			<div class="grid grid-cols-7 gap-y-0.5 text-center">
				{#each weekdays as w, i (i)}
					<span class="py-1 text-[11px] font-medium text-muted-foreground/70">{w}</span>
				{/each}
				{#each monthCells as c (c.iso)}
					<button
						type="button"
						class={[
							'mx-auto flex h-8 w-8 items-center justify-center rounded-full text-[13px] transition-colors',
							selected === c.iso
								? 'bg-primary text-white'
								: c.iso === today
									? 'font-semibold text-primary hover:bg-accent'
									: c.inMonth
										? 'text-foreground hover:bg-accent'
										: 'text-muted-foreground/70 hover:bg-accent',
						]}
						onclick={() => pick(c.iso)}
					>
						{c.day}
					</button>
				{/each}
			</div>
		</div>
	</div>
{/snippet}

{#snippet datePill(field: 'planned' | 'due', icon: string, emptyLabel: string, value: ISODate | null)}
	<button
		type="button"
		class={[
			'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors',
			value || open === field
				? 'border-primary/40 bg-primary/10 text-primary'
				: 'border-border-strong bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
		]}
		onclick={() => openDate(field)}
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
			<div bind:this={plannedWrap} class="relative">
				{@render datePill('planned', 'today', 'Date', plannedDate)}
				{#if open === 'planned'}
					<div class="absolute top-full left-0 z-50 mt-2">
						{@render dateCalendar(plannedDate, (iso) => setDate('planned', iso))}
					</div>
				{/if}
			</div>

			<div bind:this={dueWrap} class="relative">
				{@render datePill('due', 'flag', 'Due', dueDate)}
				{#if open === 'due'}
					<div class="absolute top-full left-0 z-50 mt-2">
						{@render dateCalendar(dueDate, (iso) => setDate('due', iso))}
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Footer: project picker + actions -->
	<div class="flex items-center justify-between border-t border-border px-[18px] py-2.5">
		<div bind:this={projWrap} class="relative">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
				onclick={() => (open = open === 'project' ? null : 'project')}
			>
				{#if selectedProject}
					<span class="h-2.5 w-2.5 flex-none rounded-full" style="background:{selectedProject.color}"></span>
				{:else}
					<Icon name="inbox" size={15} />
				{/if}
				{selectedProject ? selectedProject.name : 'Inbox'}
				<Icon name="chevron-down" size={14} />
			</button>

			{#if open === 'project'}
				<div
					class="absolute top-full left-0 z-50 mt-2 max-h-56 w-56 overflow-y-auto rounded-lg border border-border-strong bg-card py-1.5 shadow-pop"
				>
					<button
						type="button"
						class={[
							'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[14px] hover:bg-accent',
							projectId === null ? 'text-primary' : 'text-foreground',
						]}
						onclick={() => pickProject(null)}
					>
						<Icon name="inbox" size={15} /> Inbox
					</button>
					{#each $projects as p (p.id)}
						<button
							type="button"
							class={[
								'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[14px] hover:bg-accent',
								projectId === p.id ? 'text-primary' : 'text-foreground',
							]}
							onclick={() => pickProject(p.id)}
						>
							<span class="h-2.5 w-2.5 flex-none rounded-full" style="background:{p.color}"></span>
							{p.name}
						</button>
					{/each}
				</div>
			{/if}
		</div>

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
