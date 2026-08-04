import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Command } from 'cmdk';
import { Bookmark, ExternalLink, Globe, History, PanelsTopLeft, Search } from 'lucide-react';
import type { CommandBarMessage, CommandBarResults, CommandItem } from '@/utils/command-bar';
import './style.css';

const emptyResults: CommandBarResults = { tabs: [], bookmarks: [], searchSuggestions: [], history: [] };

function toNavigableUrl(value: string): string | null {
  const input = value.trim();
  if (!input) return null;

  try {
    if (/^https?:\/\//i.test(input)) return new URL(input).href;
    if (/^(localhost(?::\d+)?|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i.test(input)) {
      return new URL(`https://${input}`).href;
    }
  } catch {
    return null;
  }

  return null;
}

function Icon({ kind, className }: { kind: CommandItem['kind'] | 'url' | 'search'; className?: string }) {
  const IconComponent = kind === 'tab'
    ? PanelsTopLeft
    : kind === 'bookmark'
      ? Bookmark
      : kind === 'history'
        ? History
        : kind === 'url'
          ? ExternalLink
          : Search;

  return <IconComponent className={`size-5 shrink-0 stroke-2 text-slate-500 dark:text-slate-300${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

function Favicon({ item }: { item: CommandItem }) {
  const [failed, setFailed] = useState(false);

  if (!item.faviconUrl || failed) return <Globe className="size-5 shrink-0 stroke-2 text-slate-500 dark:text-slate-300" aria-hidden="true" />;

  return (
    <img
      className="size-5 shrink-0 object-contain"
      src={item.faviconUrl}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

const sourceLabel: Record<CommandItem['kind'], string> = {
  tab: 'タブ',
  bookmark: 'ブックマーク',
  history: '履歴',
};

function ResultItem({ item, onSelect }: { item: CommandItem; onSelect: (item: CommandItem) => void }) {
  return (
    <Command.Item
      className="flex min-h-14 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 data-[selected=true]:bg-indigo-50 dark:data-[selected=true]:bg-slate-700"
      value={item.id}
      onSelect={() => onSelect(item)}
    >
      <Favicon item={item} />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex items-center gap-2 truncate text-sm"><span className="truncate">{item.title}</span></span>
        <span className="truncate text-xs text-slate-500 dark:text-slate-300">{item.subtitle ?? item.url}</span>
      </span>
      <span className="flex shrink-0 items-center justify-center" aria-label={sourceLabel[item.kind]} title={sourceLabel[item.kind]}>
        <Icon kind={item.kind} className="size-4 text-slate-500 dark:text-slate-300" />
      </span>
    </Command.Item>
  );
}

function App() {
  const isStandaloneWindow = window.parent === window;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CommandBarResults>(emptyResults);
  const [selectedValue, setSelectedValue] = useState('');
  const navigableUrl = useMemo(() => toNavigableUrl(query), [query]);
  const selectedItem = useMemo(() => (
    [...results.tabs, ...results.bookmarks, ...results.history]
      .find((item) => item.id === selectedValue)
  ), [results, selectedValue]);
  const selectableValues = useMemo(() => [
    ...results.tabs.map((item) => item.id),
    ...results.bookmarks.map((item) => item.id),
    ...(navigableUrl ? [`url:${navigableUrl}`] : []),
    ...(query.trim() ? [`search:${query.trim()}`] : []),
    ...results.searchSuggestions.map((suggestion) => `suggestion:${suggestion}`),
    ...results.history.map((item) => item.id),
  ], [navigableUrl, query, results]);

  const close = () => {
    if (window.parent === window) {
      void browser.runtime.sendMessage({ type: 'command-bar:close-popup' });
      return;
    }
    window.parent.postMessage({ type: 'arclet:command-bar-close' }, '*');
  };

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void browser.runtime
        .sendMessage<CommandBarMessage, CommandBarResults>({ type: 'command-bar:search', query })
        .then((nextResults) => { if (!cancelled) setResults(nextResults); })
        .catch(() => { if (!cancelled) setResults(emptyResults); });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query]);

  useLayoutEffect(() => {
    setSelectedValue((current) => (
      selectableValues.includes(current) ? current : (selectableValues[0] ?? '')
    ));
  }, [selectableValues]);

  useEffect(() => {
    const focusInput = () => inputRef.current?.focus({ preventScroll: true });
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'arclet:command-bar-focus') focusInput();
    };

    // Focusing on mount handles the normal path. The parent sends the same
    // request after the iframe has loaded to cover pages with an active input.
    focusInput();
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const run = async (message: CommandBarMessage) => {
    try {
      await browser.runtime.sendMessage(message);
      close();
    } catch {
      // The host page can disappear while an action is being processed.
    }
  };

  const selectItem = (item: CommandItem) => {
    if (item.kind === 'tab' && item.tabId !== undefined && item.windowId !== undefined) {
      void run({ type: 'command-bar:activate-tab', tabId: item.tabId, windowId: item.windowId });
      return;
    }
    void run({ type: 'command-bar:open-url', url: item.url });
  };

  const openInSameDomainTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || !event.metaKey) return;

    // URL を直接入力しているときは、候補の選択状態に関係なく入力 URL を開く。
    const url = navigableUrl ?? selectedItem?.url;
    if (!url) return;

    event.preventDefault();
    event.stopPropagation();
    void run({ type: 'command-bar:open-url-in-same-domain-tab', url });
  };

  return (
    <main
      className={`flex min-h-dvh w-dvw justify-center bg-transparent font-sans ${isStandaloneWindow ? 'block' : 'items-start px-5 pt-24 pb-5'}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <Command
        className={`w-full overflow-hidden border border-slate-200 bg-white text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${isStandaloneWindow ? 'flex h-dvh max-w-none flex-col rounded-none shadow-none' : 'max-w-2xl rounded-xl'}`}
        shouldFilter={false}
        label="Arclet command bar"
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDownCapture={openInSameDomainTab}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4 dark:border-slate-700">
          <Search className="size-5 shrink-0 stroke-2 text-slate-500 dark:text-slate-300" aria-hidden="true" />
          <Command.Input
            className="w-full min-w-0 border-0 bg-transparent text-base outline-none placeholder:text-slate-500 dark:placeholder:text-slate-300"
            ref={inputRef}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="タブ、ブックマーク、履歴を検索"
          />
          <kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">Esc</kbd>
        </div>
        <Command.List className={`max-h-96 overflow-auto p-2 ${isStandaloneWindow ? 'flex-1 max-h-none' : ''}`}>
          <Command.Empty className="p-7 text-center text-slate-500 dark:text-slate-300">候補が見つかりません</Command.Empty>
          {[...results.tabs, ...results.bookmarks].map((item) => <ResultItem key={item.id} item={item} onSelect={selectItem} />)}
          {navigableUrl && (
            <Command.Item className="flex min-h-14 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 data-[selected=true]:bg-indigo-50 dark:data-[selected=true]:bg-slate-700" value={`url:${navigableUrl}`} onSelect={() => void run({ type: 'command-bar:open-url', url: navigableUrl })}>
              <Icon kind="url" /><span className="grid min-w-0 flex-1 gap-1"><span className="truncate text-sm">{navigableUrl} を開く</span><span className="truncate text-xs text-slate-500 dark:text-slate-300">新規タブまたは既存のタブへ移動</span></span>
            </Command.Item>
          )}
          {query.trim() && (
            <Command.Item className="flex min-h-14 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 data-[selected=true]:bg-indigo-50 dark:data-[selected=true]:bg-slate-700" value={`search:${query.trim()}`} onSelect={() => void run({ type: 'command-bar:web-search', query: query.trim() })}>
              <Icon kind="search" /><span className="grid min-w-0 flex-1 gap-1"><span className="truncate text-sm">「{query.trim()}」を検索</span><span className="truncate text-xs text-slate-500 dark:text-slate-300">ブラウザの既定検索エンジンを使用</span></span>
            </Command.Item>
          )}
          {results.searchSuggestions.map((suggestion) => (
            <Command.Item className="flex min-h-14 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 data-[selected=true]:bg-indigo-50 dark:data-[selected=true]:bg-slate-700" key={suggestion} value={`suggestion:${suggestion}`} onSelect={() => void run({ type: 'command-bar:web-search', query: suggestion })}>
              <Icon kind="search" /><span className="grid min-w-0 flex-1 gap-1"><span className="truncate text-sm">{suggestion}</span><span className="truncate text-xs text-slate-500 dark:text-slate-300">検索候補</span></span>
            </Command.Item>
          ))}
          {results.history.map((item) => <ResultItem key={item.id} item={item} onSelect={selectItem} />)}
        </Command.List>
        <footer className="flex gap-4 border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-300"><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">↑↓</kbd> 移動</span><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">↵</kbd> 開く</span><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">⌘</kbd><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">↵</kbd> 同一ドメインのタブで開く</span></footer>
      </Command>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
