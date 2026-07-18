<script lang="ts">
	import { addTask } from './store';
	import { todayISO } from './date';
	import Icon from './Icon.svelte';

	let title = $state('');
	let planToday = $state(true);
	let el: HTMLInputElement;
	let saved = $state(false);

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
		await addTask({ title: t, plannedDate: planToday ? todayISO() : null });
		title = '';
		saved = true;
		setTimeout(() => (saved = false), 900);
		await hideWindow();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			title = '';
			hideWindow();
		}
	}

	$effect(() => {
		el?.focus();
		// Refocus + reset each time the hotkey re-shows the window.
		let unlisten: (() => void) | undefined;
		(async () => {
			try {
				const { getCurrentWindow } = await import('@tauri-apps/api/window');
				unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
					if (focused) el?.focus();
				});
			} catch {
				/* not in Tauri */
			}
		})();
		return () => unlisten?.();
	});
</script>

<svelte:window onkeydown={onKey} />

<div
	class="flex h-screen flex-col justify-center gap-3 rounded-[14px] border border-line-strong bg-bg p-[14px] shadow-pop"
	data-tauri-drag-region
>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<div class="flex items-center gap-2.5">
			<span class="flex text-accent"><Icon name={saved ? 'check' : 'plus'} size={18} /></span>
			<input
				class="flex-1 border-none bg-transparent text-[18px] font-medium outline-none placeholder:font-normal placeholder:text-faint"
				bind:this={el}
				bind:value={title}
				placeholder="Quick add a task…"
				autocomplete="off"
				spellcheck="false"
			/>
		</div>
		<div class="flex items-center justify-between pl-7">
			<button
				type="button"
				class={[
					'inline-flex items-center gap-[5px] rounded-[20px] border px-2.5 py-[3px] text-[12px]',
					planToday
						? 'border-accent/30 bg-accent-soft text-accent'
						: 'border-line bg-elev text-dim',
				]}
				onclick={() => (planToday = !planToday)}
			>
				<Icon name="today" size={13} /> Today
			</button>
			<span class="text-[11.5px] text-faint">↵ to add · esc to dismiss</span>
		</div>
	</form>
</div>

<style>
	:global(body) {
		background: transparent;
	}
</style>
