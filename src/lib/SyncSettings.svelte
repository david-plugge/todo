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
</script>

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Sync settings">
	<header>
		<h2><Icon name="cloud" size={17} /> Sync</h2>
		<button class="icon-btn" aria-label="Close" onclick={onclose}
			><Icon name="x" size={17} /></button
		>
	</header>

	{#if $authState.connected}
		<p class="connected">
			Connected as <strong>{$authState.email}</strong>
		</p>
		<p class="muted">{getServerUrl()}</p>

		<div class="statusline">
			<span
				class="dot"
				class:err={$syncStatus.phase === 'error'}
				class:busy={$syncStatus.phase === 'syncing'}
			></span>
			{#if $syncStatus.phase === 'error'}
				<span class="err-text">{$syncStatus.error}</span>
			{:else if $syncStatus.phase === 'syncing'}
				<span>Syncing…</span>
			{:else}
				<span>Last synced {lastSyncedLabel($syncStatus.lastSyncedAt)}</span>
			{/if}
		</div>

		<div class="actions">
			<button class="btn" onclick={() => syncNow()} disabled={$syncStatus.phase === 'syncing'}>
				<Icon name="refresh" size={14} /> Sync now
			</button>
			<button class="btn ghost" onclick={disconnect}>
				<Icon name="logout" size={14} /> Disconnect
			</button>
		</div>
	{:else}
		<form onsubmit={connect}>
			{#if !sameOrigin}
				<label>
					<span>Server URL</span>
					<input
						bind:value={url}
						type="url"
						placeholder="https://todo.example.com"
						autocomplete="off"
					/>
				</label>
			{/if}
			<label>
				<span>Email</span>
				<input bind:value={email} type="email" autocomplete="username" />
			</label>
			<label>
				<span>Password</span>
				<input bind:value={password} type="password" autocomplete="current-password" />
			</label>
			{#if error}<p class="err-text">{error}</p>{/if}
			<button class="btn primary" type="submit" disabled={busy || !url || !email || !password}>
				{busy ? 'Connecting…' : 'Connect'}
			</button>
			<p class="hint">
				Your tasks work offline without this. Connecting turns on sync across devices.
			</p>
		</form>
	{/if}
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.28);
		z-index: 30;
		animation: fade 0.15s ease;
	}
	.modal {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 380px;
		max-width: 92vw;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lg);
		padding: 18px;
		z-index: 31;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 16px;
		font-weight: 650;
	}
	.icon-btn {
		background: transparent;
		border: none;
		color: var(--text-dim);
		padding: 6px;
		border-radius: var(--radius-sm);
		display: flex;
	}
	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	label > span {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	input {
		border: 1px solid var(--border);
		background: var(--bg-elev);
		border-radius: var(--radius-sm);
		padding: 8px 10px;
		outline: none;
		color: var(--text);
		font-size: 14px;
	}
	input:focus {
		border-color: var(--accent);
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text);
		padding: 9px 12px;
		border-radius: var(--radius-sm);
		font-weight: 550;
		transition: all 0.12s;
	}
	.btn:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.btn:disabled {
		opacity: 0.55;
	}
	.btn.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.btn.primary:hover:not(:disabled) {
		filter: brightness(1.05);
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	.actions .btn {
		flex: 1;
	}
	.btn.ghost {
		background: transparent;
	}
	.connected {
		font-size: 14px;
	}
	.muted {
		font-size: 12.5px;
		color: var(--text-faint);
		margin-top: -8px;
		word-break: break-all;
	}
	.hint {
		font-size: 12px;
		color: var(--text-faint);
		line-height: 1.45;
		margin: 0;
	}
	.statusline {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-dim);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.dot.err {
		background: var(--danger);
	}
	.dot.busy {
		animation: pulse 1s ease-in-out infinite;
	}
	.err-text {
		color: var(--danger);
		font-size: 13px;
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
</style>
