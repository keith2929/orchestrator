import { defineConfig } from 'vite';

// Local dev: Vite serves the frontend on :5173 and proxies every /api/* call
// to the native Node backend on :3001. This means the browser sees same-origin
// requests during development, so no CORS is needed locally.
//
// In production the frontend is a static build (dist/) hosted on Netlify, and
// it talks to the backend directly via VITE_API_URL (see main.js + README).
// That cross-origin path is why the backend still sets CORS headers manually.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // If the backend isn't up, http-proxy's default error path answers with
        // a bare 500 and an empty body, which main.js's api() can only surface
        // as an unexplained "HTTP 500". Reply in the same { error } shape the
        // backend uses so the UI names the real cause instead.
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (!res || typeof res.writeHead !== 'function' || res.headersSent) return;
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `Backend unreachable on localhost:3001 (${err.code || err.message}) — start it with "npm run server".`,
              })
            );
          });
        },
      },
    },
    watch: {
      // The backend writes .env in the project root when you save an API key in
      // the 🔑 panel. Without this, Vite's watcher would full-reload the page on
      // every save (wiping the "✓ saved" status). .env is irrelevant to the dev
      // bundle, so ignore it.
      ignored: ['**/.env', '**/.env.*'],
    },
  },
});
