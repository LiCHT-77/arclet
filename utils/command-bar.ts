export type CommandItemKind = 'tab' | 'bookmark' | 'history';

export interface CommandItem {
  id: string;
  kind: CommandItemKind;
  title: string;
  url: string;
  subtitle?: string;
  faviconUrl?: string;
  tabId?: number;
  windowId?: number;
  /** ブラウザウィンドウ内でのタブ位置（1 始まり）。 */
  tabNumber?: number;
  /** tabs.discard でメモリ解放済みかどうか（タブ種別のみ）。 */
  discarded?: boolean;
}

export interface CommandBarResults {
  tabs: CommandItem[];
  bookmarks: CommandItem[];
  searchSuggestions: string[];
  history: CommandItem[];
}

export type CommandBarMessage =
  | { type: 'command-bar:search'; query: string }
  | { type: 'command-bar:activate-tab'; tabId: number; windowId: number }
  | { type: 'command-bar:activate-tab-shortcut'; shortcutNumber: number }
  | { type: 'command-bar:close-tab'; tabId: number }
  | { type: 'command-bar:discard-tab'; tabId: number }
  | { type: 'command-bar:open-url'; url: string }
  | { type: 'command-bar:open-url-in-same-domain-tab'; url: string }
  | { type: 'command-bar:web-search'; query: string }
  | { type: 'command-bar:open-search-url'; url: string }
  | {
    type: 'command-bar:resize-window';
    contentHeight: number;
    frameHeight: number;
    // 初回描画時は、途中のサイズを見せず最終サイズをそのまま適用する。
    immediate?: boolean;
  }
  | { type: 'command-bar:close-popup' };
