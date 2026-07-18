// Seed / rotate the single app login user for the Todo PocketBase backend.
//
//   Env:
//     PB_URL              default http://127.0.0.1:8090
//     SUPERUSER_EMAIL     required — the PocketBase admin (superuser)
//     SUPERUSER_PASSWORD  required
//     APP_USER_EMAIL      required — the single app login user
//     APP_USER_PASSWORD   required
//
// Run:  node server/setup.mjs   (from the repo root, so `pocketbase` resolves)
//
// The `changes` schema is applied automatically by the bundled migration in
// server/pb_migrations (baked into the image) — that is the single source of
// truth. This script only holds the one thing a migration shouldn't: your login
// user (no secrets in git). The `pocketbase` CLI can create superusers but not
// regular `users`-collection accounts, so this stays the way to seed the app user.
import PocketBase from 'pocketbase';

const PB_URL = process.env.PB_URL || 'http://127.0.0.1:8090';
const { SUPERUSER_EMAIL, SUPERUSER_PASSWORD, APP_USER_EMAIL, APP_USER_PASSWORD } = process.env;

if (!SUPERUSER_EMAIL || !SUPERUSER_PASSWORD) {
	console.error('Set SUPERUSER_EMAIL and SUPERUSER_PASSWORD first.');
	process.exit(1);
}
if (!APP_USER_EMAIL || !APP_USER_PASSWORD) {
	console.error('Set APP_USER_EMAIL and APP_USER_PASSWORD to seed the app login user.');
	process.exit(1);
}

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

async function main() {
	console.log(`Connecting to ${PB_URL} …`);
	await pb.collection('_superusers').authWithPassword(SUPERUSER_EMAIL, SUPERUSER_PASSWORD);
	console.log('  ✓ authenticated as superuser');

	let existing = null;
	try {
		existing = await pb.collection('users').getFirstListItem(`email="${APP_USER_EMAIL}"`);
	} catch (e) {
		if (e?.status !== 404) throw e;
	}
	if (existing) {
		await pb.collection('users').update(existing.id, {
			password: APP_USER_PASSWORD,
			passwordConfirm: APP_USER_PASSWORD,
		});
		console.log(`  ✓ updated app user "${APP_USER_EMAIL}"`);
	} else {
		await pb.collection('users').create({
			email: APP_USER_EMAIL,
			password: APP_USER_PASSWORD,
			passwordConfirm: APP_USER_PASSWORD,
			verified: true,
		});
		console.log(`  + created app user "${APP_USER_EMAIL}"`);
	}

	console.log('Done.');
}

main().catch((e) => {
	console.error('\nSetup failed:', e?.response?.data || e?.message || e);
	process.exit(1);
});
