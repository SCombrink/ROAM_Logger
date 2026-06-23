import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and Rust-friendly file watching.
// We explicitly EXCLUDE src-tauri/ from Vite's watcher so it does not
// trip over Rust build artifacts (which cause EBUSY errors on Windows).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/.diffflow_history/**",
        "**/node_modules/**",
        "**/dist/**"
      ]
    }
  },
  envPrefix: ["VITE_", "TAURI_"]
});
