<script lang="ts">
	import { authState } from './pb';
	import { syncStatus } from './sync';
	import Icon from './Icon.svelte';
	import SyncSettings from './SyncSettings.svelte';

	let open = $state(false);

	const label = $derived(
		!$authState.connected
			? 'Connect to sync'
			: $syncStatus.phase === 'syncing'
				? 'Syncing…'
				: $syncStatus.phase === 'error'
					? 'Sync error'
					: 'Synced',
	);
</script>

<button class="syncbar" onclick={() => (open = true)}>
	<span
		class="dot"
		class:off={!$authState.connected}
		class:err={$authState.connected && $syncStatus.phase === 'error'}
		class:busy={$authState.connected && $syncStatus.phase === 'syncing'}
	></span>
	<Icon name="cloud" size={15} />
	<span class="label">{label}</span>
</button>

{#if open}
	<SyncSettings onclose={() => (open = false)} />
{/if}

<style>
	.syncbar {
		margin-top: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: transparent;
		border: none;
		border-top: 1px solid var(--border);
		color: var(--text-dim);
		padding: 10px 8px 4px;
		border-radius: 0;
		transition: color 0.1s;
	}
	.syncbar:hover {
		color: var(--text);
	}
	.label {
		font-size: 13px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.dot.off {
		background: var(--text-faint);
	}
	.dot.err {
		background: var(--danger);
	}
	.dot.busy {
		animation: pulse 1s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
</style>
