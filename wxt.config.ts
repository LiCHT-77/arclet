import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    permissions: ['tabs', 'windows', 'system.display', 'bookmarks', 'history', 'search', 'favicon'],
    commands: {
      'toggle-command-bar': {
        suggested_key: {
          default: 'Ctrl+Shift+K',
          mac: 'Command+Shift+K',
        },
        description: 'コマンドバーを開く／閉じる',
      },
    },
    host_permissions: ['*://*/*'],
    web_accessible_resources: [
      {
        resources: ['command-bar.html'],
        matches: ['*://*/*'],
      },
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
    // The command bar is mounted in a short-lived iframe. Vite's automatic
    // modulepreload hint can outlive that iframe and triggers Chrome's
    // "preloaded but not used" warning. Native ESM imports still load the
    // shared React chunk when the command bar is opened.
    build: {
      modulePreload: false,
    },
  }),
});
