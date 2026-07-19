<script lang="ts">
	import type { ISODate } from './types';
	import { relativeLabel, datePresets } from './date';
	import { toDateValue, fromDateValue } from './calendar-date';
	import * as Popover from './components/ui/popover';
	import { Calendar } from './components/ui/calendar';
	import Icon from './Icon.svelte';

	// A task date field: a pill trigger opening a popover with quick presets +
	// a calendar. Owns its own open state; `value` is always an ISODate | null.
	// `onchange` fires on every pick/clear (callers that persist per-edit use it;
	// callers that batch just read `value`).
	let {
		value = $bindable(),
		icon,
		emptyLabel,
		onchange,
	}: {
		value: ISODate | null;
		icon: string;
		emptyLabel: string;
		onchange?: (v: ISODate | null) => void;
	} = $props();

	let open = $state(false);
	const presets = datePresets();

	function set(iso: ISODate | null) {
		value = iso;
		onchange?.(iso);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={[
					'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors',
					value || open
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
							set(null);
						}}
						onkeydown={() => {}}
					>
						<Icon name="x" size={13} />
					</span>
				{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-auto overflow-hidden p-0">
		<div class="flex flex-col py-1.5">
			{#each presets as p (p.label)}
				<button
					type="button"
					class="flex items-center gap-3 px-3 py-1.5 text-left text-[14px] text-foreground hover:bg-accent"
					onclick={() => set(p.date)}
				>
					<span class="flex" style="color:{p.color}"><Icon name={p.icon} size={17} /></span>
					<span class="flex-1">{p.label}</span>
					<span class="text-[13px] text-muted-foreground/70">{p.hint}</span>
				</button>
			{/each}
		</div>

		<div class="border-t border-border">
			<Calendar
				type="single"
				weekStartsOn={1}
				value={toDateValue(value)}
				onValueChange={(v) => set(fromDateValue(v))}
			/>
		</div>
	</Popover.Content>
</Popover.Root>
