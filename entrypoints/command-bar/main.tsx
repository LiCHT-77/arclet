import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Command } from 'cmdk';
import type { CommandBarMessage, CommandBarResults, CommandItem } from '@/utils/command-bar';
import './style.css';

const emptyResults: CommandBarResults = { tabs: [], bookmarks: [], history: [] };

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

function Icon({ kind }: { kind: CommandItem['kind'] | 'url' | 'search' }) {
  const label = kind === 'tab' ? '▣' : kind === 'bookmark' ? '★' : kind === 'history' ? '◷' : kind === 'url' ? '↗' : '⌕';
  return <span className="command-icon" aria-hidden="true">{label}</span>;
}

function Favicon({ item }: { item: CommandItem }) {
  const [failed, setFailed] = useState(false);

  if (!item.faviconUrl || failed) return <Icon kind={item.kind} />;

  return (
    <img
      className="command-favicon"
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
    <Command.Item value={item.id} onSelect={() => onSelect(item)}>
      <Favicon item={item} />
      <span className="command-copy">
        <span className="command-title"><span>{item.title}</span><span className="source-label">{sourceLabel[item.kind]}</span></span>
        <span className="command-subtitle">{item.subtitle ?? item.url}</span>
      </span>
    </Command.Item>
  );
}

function App() {
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
    ...results.history.map((item) => item.id),
  ], [navigableUrl, query, results]);

  const close = () => {
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
    <main className="command-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <Command
        className="command-panel"
        shouldFilter={false}
        label="Arclet command bar"
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDownCapture={openInSameDomainTab}
      >
        <div className="command-input-wrap">
          <span className="search-mark" aria-hidden="true">⌕</span>
          <Command.Input
            ref={inputRef}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="タブ、ブックマーク、履歴を検索"
          />
          <kbd>Esc</kbd>
        </div>
        <Command.List>
          <Command.Empty>候補が見つかりません</Command.Empty>
          {[...results.tabs, ...results.bookmarks].map((item) => <ResultItem key={item.id} item={item} onSelect={selectItem} />)}
          {navigableUrl && (
            <Command.Item value={`url:${navigableUrl}`} onSelect={() => void run({ type: 'command-bar:open-url', url: navigableUrl })}>
              <Icon kind="url" /><span className="command-copy"><span className="command-title">{navigableUrl} を開く</span><span className="command-subtitle">新規タブまたは既存のタブへ移動</span></span>
            </Command.Item>
          )}
          {query.trim() && (
            <Command.Item value={`search:${query.trim()}`} onSelect={() => void run({ type: 'command-bar:web-search', query: query.trim() })}>
              <Icon kind="search" /><span className="command-copy"><span className="command-title">「{query.trim()}」を検索</span><span className="command-subtitle">ブラウザの既定検索エンジンを使用</span></span>
            </Command.Item>
          )}
          {results.history.map((item) => <ResultItem key={item.id} item={item} onSelect={selectItem} />)}
        </Command.List>
        <footer><span><kbd>↑↓</kbd> 移動</span><span><kbd>↵</kbd> 開く</span><span><kbd>⌘</kbd><kbd>↵</kbd> 同一ドメインのタブで開く</span></footer>
      </Command>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
