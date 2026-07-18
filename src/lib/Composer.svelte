<script lang="ts">
	import type { ID, ISODate } from './types';
	import { addTask } from './store';
	import Icon from './Icon.svelte';

	let {
		projectId = null,
		plannedDate = null,
		placeholder = 'Add a task…',
	}: { projectId?: ID | null; plannedDate?: ISODate | null; placeholder?: string } = $props();

	let title = $state('');
	let el: HTMLInputElement;

	async function submit() {
		const t = title.trim();
		if (!t) return;
		title = '';
		await addTask({ title: t, projectId, plannedDate });
		el?.focus();
	}
</script>

<form
	class="composer"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	<span class="plus"><Icon name="plus" size={16} /></span>
	<input bind:this={el} bind:value={title} {placeholder} autocomplete="off" spellcheck="false" />
</form>

<style>
	.composer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		transition:
			border-color 0.12s,
			background 0.12s;
	}
	.composer:focus-within {
		border-color: var(--accent);
		background: var(--bg);
	}
	.plus {
		color: var(--text-faint);
		display: flex;
	}
	.composer:focus-within .plus {
		color: var(--accent);
	}
	input {
		flex: 1;
		border: none;
		background: transparent;
		outline: none;
		padding: 0;
	}
	input::placeholder {
		color: var(--text-faint);
	}
</style>
