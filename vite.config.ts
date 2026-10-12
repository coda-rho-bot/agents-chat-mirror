import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only: index.html ships a strict CSP (script-src 'self') that blocks
// @vitejs/plugin-react's inline preamble, which kills the module graph at
// import time (App.tsx throws "can't detect preamble") -> blank window.
// Production builds don't use the preamble, so the strict CSP stays for build.
const relaxCspInDev: Plugin = {
  name: "relax-csp-in-dev",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
  },
};

// Keep the port in sync with DEV_PORT in src/electron/util.ts.
export default defineConfig({
	plugins: [relaxCspInDev, react(), tailwindcss()],
	base: './',
	build: {
		outDir: 'dist-react',
		// A desktop app loads its bundle from disk, so one large chunk is fine.
		chunkSizeWarningLimit: 1500,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
