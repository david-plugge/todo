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

<button
	class="mt-auto flex w-full items-center gap-2 rounded-none border-t border-line bg-transparent pt-2.5 pr-2 pb-1 pl-2 text-dim transition-colors duration-100 hover:text-fg"
	onclick={() => (open = true)}
>
	<span
		class={[
			'h-2 w-2 flex-none rounded-full',
			!$authState.connected
				? 'bg-faint'
				: $syncStatus.phase === 'error'
					? 'bg-danger'
					: 'bg-accent',
			$authState.connected && $syncStatus.phase === 'syncing' && 'busy',
		]}
	></span>
	<Icon name="cloud" size={15} />
	<span class="text-[13px]">{label}</span>
</button>

{#if open}
	<SyncSettings onclose={() => (open = false)} />
{/if}

<style>
	.busy {
		animation: pulse 1s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
</style>
