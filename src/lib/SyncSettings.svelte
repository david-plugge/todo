<script lang="ts">
	import { authState, getServerUrl, setServerUrl, isSameOriginServer, login, logout } from './pb';
	import { syncStatus, startSync, stopSync, syncNow } from './sync';
	import Icon from './Icon.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Field from '$lib/components/ui/field/index.js';

	let { onclose }: { onclose: () => void } = $props();

	let open = $state(true);

	const sameOrigin = isSameOriginServer();
	let url = $state(getServerUrl());
	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state('');

	async function connect(e: Event) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			setServerUrl(url);
			await login(email.trim(), password);
			password = '';
			startSync();
		} catch (err: any) {
			error = err?.response?.message || err?.message || 'Could not connect';
		} finally {
			busy = false;
		}
	}

	function disconnect() {
		logout();
		stopSync();
	}

	function lastSyncedLabel(ts: number | null): string {
		if (!ts) return 'not yet';
		const s = Math.round((Date.now() - ts) / 1000);
		if (s < 5) return 'just now';
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		return `${Math.round(s / 3600)}h ago`;
	}

	const errText = 'text-[13px] text-destructive';
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (!o) onclose();
	}}
>
	<Dialog.Content class="flex w-[380px] max-w-[92vw] flex-col gap-[14px]">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-[16px] font-[650]">
				<Icon name="cloud" size={17} /> Sync
			</Dialog.Title>
			<Dialog.Description class="sr-only">Manage sync connection settings</Dialog.Description>
		</Dialog.Header>

		{#if $authState.connected}
			<p class="text-[14px]">
				Connected as <strong>{$authState.email}</strong>
			</p>
			<p class="-mt-2 text-[12.5px] text-muted-foreground/70 break-all">{getServerUrl()}</p>

			<div class="flex items-center gap-2 text-[13px] text-muted-foreground">
				<span
					class={[
						'h-2 w-2 flex-none rounded-full',
						$syncStatus.phase === 'error' ? 'bg-destructive' : 'bg-primary',
						$syncStatus.phase === 'syncing' && 'animate-[pulse_1s_ease-in-out_infinite]',
					]}
				></span>
				{#if $syncStatus.phase === 'error'}
					<span class={errText}>{$syncStatus.error}</span>
				{:else if $syncStatus.phase === 'syncing'}
					<span>Syncing…</span>
				{:else}
					<span>Last synced {lastSyncedLabel($syncStatus.lastSyncedAt)}</span>
				{/if}
			</div>

			<div class="flex gap-2">
				<Button class="flex-1" onclick={() => syncNow()} disabled={$syncStatus.phase === 'syncing'}>
					<Icon name="refresh" size={14} /> Sync now
				</Button>
				<Button variant="outline" class="flex-1" onclick={disconnect}>
					<Icon name="logout" size={14} /> Disconnect
				</Button>
			</div>
		{:else}
			<form onsubmit={connect} class="flex flex-col gap-3">
				<Field.Set class="gap-3">
					{#if !sameOrigin}
						<Field.Field class="gap-1.5">
							<Field.Label for="sync-url">Server URL</Field.Label>
							<Input
								id="sync-url"
								bind:value={url}
								type="url"
								placeholder="https://todo.example.com"
								autocomplete="off"
							/>
						</Field.Field>
					{/if}
					<Field.Field class="gap-1.5">
						<Field.Label for="sync-email">Email</Field.Label>
						<Input id="sync-email" bind:value={email} type="email" autocomplete="username" />
					</Field.Field>
					<Field.Field class="gap-1.5">
						<Field.Label for="sync-password">Password</Field.Label>
						<Input
							id="sync-password"
							bind:value={password}
							type="password"
							autocomplete="current-password"
						/>
					</Field.Field>
				</Field.Set>
				{#if error}<p class={errText}>{error}</p>{/if}
				<Button type="submit" disabled={busy || !url || !email || !password}>
					{busy ? 'Connecting…' : 'Connect'}
				</Button>
				<p class="m-0 text-[12px] leading-[1.45] text-muted-foreground/70">
					Your tasks work offline without this. Connecting turns on sync across devices.
				</p>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	@keyframes -global-pulse {
		50% {
			opacity: 0.3;
		}
	}
</style>
