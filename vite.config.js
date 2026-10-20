import { defineConfig } from 'vite';
import { JobStore } from './scripts/jobs.mjs';
import { createJobApi } from './scripts/jobs-api.mjs';

export default defineConfig({
  envDir: false,
  server: { host: '127.0.0.1', watch: { ignored: ['**/private/**', '**/recordings/**', '**/public/audio/**', '**/public/private/**'] } },
  plugins: [{
    name: 'limbo-local-jobs',
    async configureServer(server) {
      const store = await new JobStore(server.config.root).init();
      server.middlewares.use(createJobApi(store));
      server.httpServer?.once('close', () => { store.close().catch(() => {}); });
    },
  }],
});