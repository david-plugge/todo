/**
 * The global setup starts one PocketBase per run on a free port and publishes it
 * here. A fixed port would let a suite from another checkout join this run's
 * backend and mix its records into the shared test accounts.
 */
export function backendAddress() {
  const address = process.env.TODO_TEST_ADDRESS;
  if (!address)
    throw new Error(
      'TODO_TEST_ADDRESS fehlt. Die PocketBase-Tests laufen nur über tests/fixtures/pocketbase-setup.ts.',
    );
  return address;
}
