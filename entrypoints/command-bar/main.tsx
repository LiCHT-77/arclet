import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Command } from 'cmdk';
import { Bookmark, Command as CommandIcon, ExternalLink, Globe, History, PanelsTopLeft, Search } from 'lucide-react';
import type { CommandBarMessage, CommandBarResults, CommandItem } from '@/utils/command-bar';
import { COMMAND_BAR_WINDOW_WIDTH_SCALE } from '@/utils/window-layout';
import './style.css';

const emptyResults: CommandBarResults = { tabs: [], bookmarks: [], searchSuggestions: [], history: [] };
const commandBarIframeScaleStyle = {
  '--arclet-command-bar-width-scale': COMMAND_BAR_WINDOW_WIDTH_SCALE,
} as CSSProperties;

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

function ResultItem({ item, onSelect, showTabNumber }: { item: CommandItem; onSelect: (item: CommandItem) => void; showTabNumber: boolean }) {
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
      <span className="flex shrink-0 items-center gap-1 text-xs text-slate-500 dark:text-slate-300" aria-label={sourceLabel[item.kind]} title={sourceLabel[item.kind]}>
        {item.kind === 'tab' && showTabNumber && item.tabNumber !== undefined
          ? <span className="flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 dark:border-indigo-400/40 dark:bg-indigo-400/10 dark:text-indigo-200" aria-label={`⌘${item.tabNumber} でタブへ移動`}>
            <CommandIcon className="size-3.5 stroke-2" aria-hidden="true" />
            <span>{item.tabNumber}</span>
          </span>
          : <>
            {item.kind === 'tab' && <span>switch tab</span>}
            <Icon kind={item.kind} className="size-4 text-slate-500 dark:text-slate-300" />
          </>}
      </span>
    </Command.Item>
  );
}

function App() {
  const isStandaloneWindow = window.parent === window;
  const commandRef = useRef<HTMLDivElement>(null);
  const commandContentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CommandBarResults>(emptyResults);
  const [selectedValue, setSelectedValue] = useState('');
  const [iframeCommandHeight, setIframeCommandHeight] = useState<number>();
  const [isWindowVisible, setIsWindowVisible] = useState(false);
  const [initialResultsLoaded, setInitialResultsLoaded] = useState(false);
  const [isMetaKeyPressed, setIsMetaKeyPressed] = useState(false);
  const initialResultsLoadedRef = useRef(false);
  const windowVisibleRef = useRef(false);
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
        .then((nextResults) => {
          if (cancelled) return;
          setResults(nextResults);
          initialResultsLoadedRef.current = true;
          setInitialResultsLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          setResults(emptyResults);
          initialResultsLoadedRef.current = true;
          setInitialResultsLoaded(true);
        });
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
    // popup は初期サイズの計測中に非表示にしているため、mount 時の autoFocus
    // だけでは表示後にフォーカスが残らないことがある。
    if (isStandaloneWindow && isWindowVisible) inputRef.current?.focus({ preventScroll: true });
  }, [isStandaloneWindow, isWindowVisible]);

  useLayoutEffect(() => {
    if (!isStandaloneWindow || !commandRef.current) return;

    let previousHeight = 0;
    let frame: number | undefined;
    const reportHeight = () => {
      frame = undefined;
      // 結果取得前の空状態は表示しないため、その高さで popup を更新しない。
      // 空状態→結果状態の更新競合が、表示直後の跳ねの原因になる。
      if (!initialResultsLoadedRef.current && !windowVisibleRef.current) return;
      // scrollHeight は Command 自身の上下ボーダーを含まない。popup の
      // viewport をちょうど合わせると 2px 分だけ不足してスクロールバーが
      // 出るため、実際に描画される border-box の高さを送る。
      const contentHeight = Math.ceil(commandRef.current?.getBoundingClientRect().height ?? 0);
      if (!contentHeight || contentHeight === previousHeight) return;
      previousHeight = contentHeight;
      // 初期検索の結果が反映された時点でだけ、アニメーションなしで最終高さを
      // 適用する。これにより大きな初期 popup → 空状態 → 結果状態の変形を隠す。
      const revealWindow = initialResultsLoadedRef.current && !windowVisibleRef.current;
      void browser.runtime.sendMessage<CommandBarMessage>({
        type: 'command-bar:resize-window',
        contentHeight,
        frameHeight: Math.max(0, window.outerHeight - window.innerHeight),
        immediate: revealWindow,
      }).then(() => {
        if (!revealWindow) return;
        windowVisibleRef.current = true;
        setIsWindowVisible(true);
      }).catch(() => undefined);
    };

    const observer = new ResizeObserver(reportHeight);
    observer.observe(commandRef.current);
    // ResizeObserver は子要素の追加で親自身の border-box が変わらない場合に
    // 通知しないことがあるため、候補の差し替えも監視して再計測する。
    const mutationObserver = new MutationObserver(() => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(reportHeight);
    });
    mutationObserver.observe(commandRef.current, { childList: true, subtree: true, characterData: true });
    reportHeight();
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [initialResultsLoaded, isStandaloneWindow]);

  useLayoutEffect(() => {
    if (isStandaloneWindow || !commandContentRef.current) return;

    const reportHeight = () => {
      const contentHeight = commandContentRef.current?.getBoundingClientRect().height ?? 0;
      const borderHeight = commandRef.current
        ? commandRef.current.offsetHeight - commandRef.current.clientHeight
        : 0;
      const height = Math.ceil(contentHeight + borderHeight);
      if (height) setIframeCommandHeight((current) => current === height ? current : height);
    };

    const observer = new ResizeObserver(reportHeight);
    observer.observe(commandContentRef.current);
    reportHeight();
    return () => {
      observer.disconnect();
    };
  }, [isStandaloneWindow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setIsMetaKeyPressed(true);

      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLocaleLowerCase() === 'x' &&
        selectedItem?.kind === 'tab' &&
        selectedItem.tabId !== undefined
      ) {
        event.preventDefault();
        void browser.runtime
          .sendMessage<CommandBarMessage>({ type: 'command-bar:close-tab', tabId: selectedItem.tabId })
          .then(() => {
            setResults((current) => ({
              ...current,
              tabs: current.tabs.filter((item) => item.tabId !== selectedItem.tabId),
            }));
          })
          .catch(() => {
            // タブがすでに閉じられているなど、削除に失敗した場合は候補を維持する。
          });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setIsMetaKeyPressed(false);
    };
    const resetMetaKey = () => setIsMetaKeyPressed(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', resetMetaKey);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', resetMetaKey);
    };
  }, [selectedItem]);

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

  useEffect(() => {
    if (!isStandaloneWindow) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;

      event.preventDefault();
      event.stopPropagation();
      void browser.runtime
        .sendMessage<CommandBarMessage>({ type: 'command-bar:activate-tab-shortcut', shortcutNumber: Number(event.key) })
        .then(close)
        .catch(() => undefined);
    };

    // cmdk や入力欄より先に捕捉し、ブラウザウィンドウ自身のタブ操作を抑止する。
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isStandaloneWindow]);

  return (
    <main
      className={`bg-transparent font-sans ${isStandaloneWindow ? 'block w-full' : 'flex min-h-dvh w-dvw items-start justify-center px-5 pt-24 pb-5'}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <Command
        ref={commandRef}
        className={`max-w-none overflow-hidden border border-slate-200 bg-white text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${isStandaloneWindow ? `flex w-full flex-col rounded-none shadow-none transition-opacity duration-300 ease-out${isWindowVisible ? ' opacity-100' : ' invisible opacity-0'}` : 'w-[calc(100dvw*var(--arclet-command-bar-width-scale))] rounded-xl transition-[height] duration-200 ease-out'}`}
        style={isStandaloneWindow ? undefined : { ...commandBarIframeScaleStyle, height: iframeCommandHeight ? `${iframeCommandHeight}px` : undefined }}
        shouldFilter={false}
        label="Arclet command bar"
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDownCapture={openInSameDomainTab}
      >
        <div ref={commandContentRef}>
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
          <Command.List className="max-h-96 overflow-auto p-2">
            <Command.Empty className="p-7 text-center text-slate-500 dark:text-slate-300">候補が見つかりません</Command.Empty>
            {[...results.tabs, ...results.bookmarks].map((item) => <ResultItem key={item.id} item={item} onSelect={selectItem} showTabNumber={isMetaKeyPressed} />)}
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
            {results.history.map((item) => <ResultItem key={item.id} item={item} onSelect={selectItem} showTabNumber={isMetaKeyPressed} />)}
          </Command.List>
          <footer className="flex gap-4 border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-300"><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">↑↓</kbd> 移動</span><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">↵</kbd> 開く</span><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">Ctrl</kbd><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">X</kbd> タブを閉じる</span><span className="flex items-center gap-1"><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">⌘</kbd><kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">↵</kbd> 同一ドメインのタブで開く</span></footer>
        </div>
      </Command>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
