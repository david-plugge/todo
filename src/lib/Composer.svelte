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
	class="group flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors duration-[.12s] focus-within:border-primary focus-within:bg-background"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	<span class="flex text-muted-foreground/70 group-focus-within:text-primary"><Icon name="plus" size={16} /></span>
	<input
		bind:this={el}
		bind:value={title}
		{placeholder}
		autocomplete="off"
		spellcheck="false"
		class="flex-1 border-none bg-transparent p-0 outline-none placeholder:text-muted-foreground/70"
	/>
</form>
