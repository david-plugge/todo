<script lang="ts">
	import { authState, getServerUrl, setServerUrl, isSameOriginServer, login, logout } from './pb';
	import { syncStatus, startSync, stopSync, syncNow } from './sync';
	import Icon from './Icon.svelte';

	let { onclose }: { onclose: () => void } = $props();

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

	const btnBase =
		'inline-flex items-center justify-center gap-[7px] rounded-soft border px-3 py-[9px] font-[550] transition-all duration-[.12s] disabled:opacity-[.55]';
	const errText = 'text-[13px] text-danger';
</script>

<div
	class="fixed inset-0 z-30 bg-black/28 animate-[fade_0.15s_ease]"
	onclick={onclose}
	role="presentation"
></div>
<div
	class="fixed top-1/2 left-1/2 z-[31] flex w-[380px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-[14px] rounded-card border border-line bg-bg p-[18px] shadow-pop"
	role="dialog"
	aria-modal="true"
	aria-label="Sync settings"
>
	<header class="flex items-center justify-between">
		<h2 class="flex items-center gap-2 text-[16px] font-[650]">
			<Icon name="cloud" size={17} /> Sync
		</h2>
		<button
			class="flex rounded-soft border-none bg-transparent p-1.5 text-dim hover:bg-hover hover:text-fg"
			aria-label="Close"
			onclick={onclose}><Icon name="x" size={17} /></button
		>
	</header>

	{#if $authState.connected}
		<p class="text-[14px]">
			Connected as <strong>{$authState.email}</strong>
		</p>
		<p class="-mt-2 text-[12.5px] text-faint break-all">{getServerUrl()}</p>

		<div class="flex items-center gap-2 text-[13px] text-dim">
			<span
				class={[
					'h-2 w-2 flex-none rounded-full',
					$syncStatus.phase === 'error' ? 'bg-danger' : 'bg-accent',
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
			<button
				class={[btnBase, 'flex-1 border-line bg-elev text-fg enabled:hover:border-accent']}
				onclick={() => syncNow()}
				disabled={$syncStatus.phase === 'syncing'}
			>
				<Icon name="refresh" size={14} /> Sync now
			</button>
			<button
				class={[btnBase, 'flex-1 border-line bg-transparent text-fg enabled:hover:border-accent']}
				onclick={disconnect}
			>
				<Icon name="logout" size={14} /> Disconnect
			</button>
		</div>
	{:else}
		<form onsubmit={connect} class="flex flex-col gap-3">
			{#if !sameOrigin}
				<label class="flex flex-col gap-[5px]">
					<span class="text-[12px] font-semibold uppercase tracking-[0.04em] text-dim"
						>Server URL</span
					>
					<input
						class="rounded-soft border border-line bg-elev px-2.5 py-2 text-[14px] text-fg outline-none focus:border-accent"
						bind:value={url}
						type="url"
						placeholder="https://todo.example.com"
						autocomplete="off"
					/>
				</label>
			{/if}
			<label class="flex flex-col gap-[5px]">
				<span class="text-[12px] font-semibold uppercase tracking-[0.04em] text-dim">Email</span>
				<input
					class="rounded-soft border border-line bg-elev px-2.5 py-2 text-[14px] text-fg outline-none focus:border-accent"
					bind:value={email}
					type="email"
					autocomplete="username"
				/>
			</label>
			<label class="flex flex-col gap-[5px]">
				<span class="text-[12px] font-semibold uppercase tracking-[0.04em] text-dim">Password</span>
				<input
					class="rounded-soft border border-line bg-elev px-2.5 py-2 text-[14px] text-fg outline-none focus:border-accent"
					bind:value={password}
					type="password"
					autocomplete="current-password"
				/>
			</label>
			{#if error}<p class={errText}>{error}</p>{/if}
			<button
				class={[btnBase, 'border-accent bg-accent text-white enabled:hover:brightness-105']}
				type="submit"
				disabled={busy || !url || !email || !password}
			>
				{busy ? 'Connecting…' : 'Connect'}
			</button>
			<p class="m-0 text-[12px] leading-[1.45] text-faint">
				Your tasks work offline without this. Connecting turns on sync across devices.
			</p>
		</form>
	{/if}
</div>

<style>
	@keyframes -global-fade {
		from {
			opacity: 0;
		}
	}
	@keyframes -global-pulse {
		50% {
			opacity: 0.3;
		}
	}
</style>
