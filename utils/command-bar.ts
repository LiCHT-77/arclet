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
  | { type: 'command-bar:open-url'; url: string }
  | { type: 'command-bar:open-url-in-same-domain-tab'; url: string }
  | { type: 'command-bar:web-search'; query: string }
  | { type: 'command-bar:close-popup' };
