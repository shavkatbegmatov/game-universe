import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5050,
    strictPort: true,
  },
  preview: {
    port: 5050,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
});
