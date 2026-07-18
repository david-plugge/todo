<script lang="ts">
	import type { Project, Selection } from './types';
	import { addProject } from './store';
	import Icon from './Icon.svelte';

	// The projects list + inline "add project" form. Shared by the desktop
	// Sidebar and the mobile BottomNav's Projects sheet.
	let {
		projects,
		current,
		onselect,
	}: { projects: Project[]; current: Selection; onselect: (s: Selection) => void } = $props();

	const palette = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#8b5cf6'];

	let adding = $state(false);
	let name = $state('');
	let color = $state(palette[0]);

	function isActive(id: string): boolean {
		return current.kind === 'project' && current.id === id;
	}

	async function createProject() {
		const n = name.trim();
		if (!n) {
			adding = false;
			return;
		}
		const id = await addProject(n, color);
		name = '';
		adding = false;
		onselect({ kind: 'project', id });
	}
</script>

<div class="flex flex-col gap-px">
	<div
		class="flex items-center justify-between px-2 pt-[2px] pb-1 text-[11.5px] font-semibold tracking-[0.05em] text-muted-foreground/70 uppercase"
	>
		<span>Projects</span>
		<button
			class="flex rounded-[5px] border-none bg-transparent p-[2px] text-muted-foreground/70 hover:bg-accent hover:text-foreground"
			aria-label="Add project"
			onclick={() => (adding = true)}
		>
			<Icon name="plus" size={14} />
		</button>
	</div>

	{#each projects as p (p.id)}
		<button
			class={[
				'flex w-full items-center gap-2.5 rounded-md border-none px-2 py-[7px] text-left transition-colors duration-100',
				isActive(p.id) ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
			]}
			onclick={() => onselect({ kind: 'project', id: p.id })}
		>
			<span class="mx-[3.5px] h-[9px] w-[9px] flex-none rounded-full" style="background:{p.color}"
			></span><span>{p.name}</span>
		</button>
	{/each}

	{#if adding}
		<form
			class="flex flex-col gap-[7px] px-2 py-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				createProject();
			}}
		>
			<div class="flex gap-[5px]">
				{#each palette as c (c)}
					<button
						type="button"
						class={[
							'h-4 w-4 rounded-full border-2 border-transparent p-0',
							color === c && 'border-foreground',
						]}
						style="background:{c}"
						aria-label="Color {c}"
						onclick={() => (color = c)}
					></button>
				{/each}
			</div>
			<input
				class="rounded-md border border-border-strong bg-background px-2 py-1.5 outline-none focus:border-primary"
				bind:value={name}
				placeholder="Project name"
				autofocus
				onblur={createProject}
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						adding = false;
						name = '';
					}
				}}
			/>
		</form>
	{/if}
</div>
