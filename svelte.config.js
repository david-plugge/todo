import adapter from '@sveltejs/adapter-static';

const harness = process.env.TODO_BUILD_TARGET === 'harness';
const output = harness ? '.test-build/harness' : 'pb_public';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ pages: output, assets: output, fallback: 'index.html' }),
    files: harness
      ? {
          routes: 'tests/harness/routes',
        }
      : undefined,
  },
};

export default config;
