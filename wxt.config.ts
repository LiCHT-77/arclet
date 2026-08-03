import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    permissions: ['tabs', 'bookmarks', 'history', 'search', 'favicon'],
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
  }),
});
