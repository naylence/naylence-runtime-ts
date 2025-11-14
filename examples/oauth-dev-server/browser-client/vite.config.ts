import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const oauthTarget = env.VITE_OAUTH_ORIGIN ?? 'http://127.0.0.1:8099';

  return {
    server: {
      port: 5174,
      proxy: {
        '/oauth': {
          target: oauthTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4174,
      proxy: {
        '/oauth': {
          target: oauthTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
