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

<div class="group">
	<div class="group-head">
		<span>Projects</span>
		<button class="add" aria-label="Add project" onclick={() => (adding = true)}>
			<Icon name="plus" size={14} />
		</button>
	</div>

	{#each projects as p (p.id)}
		<button
			class="item"
			class:active={isActive(p.id)}
			onclick={() => onselect({ kind: 'project', id: p.id })}
		>
			<span class="pdot" style="background:{p.color}"></span><span>{p.name}</span>
		</button>
	{/each}

	{#if adding}
		<form
			class="new-project"
			onsubmit={(e) => {
				e.preventDefault();
				createProject();
			}}
		>
			<div class="swatches">
				{#each palette as c (c)}
					<button
						type="button"
						class="swatch"
						class:sel={color === c}
						style="background:{c}"
						aria-label="Color {c}"
						onclick={() => (color = c)}
					></button>
				{/each}
			</div>
			<input
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

<style>
	.group {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.group-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 2px 8px 4px;
		font-size: 11.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-faint);
	}
	.add {
		background: transparent;
		border: none;
		color: var(--text-faint);
		display: flex;
		padding: 2px;
		border-radius: 5px;
	}
	.add:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		color: var(--text-dim);
		padding: 7px 8px;
		border-radius: var(--radius-sm);
		transition:
			background 0.1s,
			color 0.1s;
	}
	.item:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.item.active {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 550;
	}
	.pdot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex: none;
		margin: 0 3.5px;
	}
	.new-project {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 6px 8px;
	}
	.swatches {
		display: flex;
		gap: 5px;
	}
	.swatch {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid transparent;
		padding: 0;
	}
	.swatch.sel {
		border-color: var(--text);
	}
	.new-project input {
		border: 1px solid var(--border-strong);
		background: var(--bg);
		border-radius: var(--radius-sm);
		padding: 6px 8px;
		outline: none;
	}
	.new-project input:focus {
		border-color: var(--accent);
	}
</style>
