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

<div class="quick" data-tauri-drag-region>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<div class="input-row">
			<span class="icon"><Icon name={saved ? 'check' : 'plus'} size={18} /></span>
			<input
				bind:this={el}
				bind:value={title}
				placeholder="Quick add a task…"
				autocomplete="off"
				spellcheck="false"
			/>
		</div>
		<div class="footer">
			<button
				type="button"
				class="toggle"
				class:on={planToday}
				onclick={() => (planToday = !planToday)}
			>
				<Icon name="today" size={13} /> Today
			</button>
			<span class="hint">↵ to add · esc to dismiss</span>
		</div>
	</form>
</div>

<style>
	:global(body) {
		background: transparent;
	}
	.quick {
		padding: 14px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		box-shadow: var(--shadow-lg);
		height: 100vh;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 12px;
	}
	.input-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.icon {
		color: var(--accent);
		display: flex;
	}
	input {
		flex: 1;
		border: none;
		background: transparent;
		outline: none;
		font-size: 18px;
		font-weight: 500;
	}
	input::placeholder {
		color: var(--text-faint);
		font-weight: 400;
	}
	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-left: 28px;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		padding: 3px 10px;
		border-radius: 20px;
	}
	.toggle.on {
		color: var(--accent);
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.hint {
		font-size: 11.5px;
		color: var(--text-faint);
	}
</style>
