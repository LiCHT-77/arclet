import type { CommandBarMessage, CommandBarResults, CommandItem } from '@/utils/command-bar';

const MAX_RESULTS = 50;
const COMMAND_BAR_WINDOW_SIZE = { width: 680, height: 560 };

let commandBarWindowId: number | undefined;
let commandBarWindowBounds: { width: number; height: number; left?: number; top?: number } | undefined;
let restoringCommandBarBounds = false;

function titleFor(url: string, title?: string) {
  if (title) return title;
  try { return new URL(url).hostname; } catch { return url; }
}

function normalizeUrl(url: string) {
  try { return new URL(url).href; } catch { return url; }
}

function faviconUrlFor(url: string) {
  const faviconUrl = new URL(browser.runtime.getURL('/command-bar.html'));
  faviconUrl.pathname = '/_favicon/';
  faviconUrl.searchParams.set('pageUrl', url);
  faviconUrl.searchParams.set('size', '32');
  return faviconUrl.href;
}

function withoutDuplicateUrls(items: CommandItem[], seenUrls: Set<string>) {
  return items.filter((item) => {
    const url = normalizeUrl(item.url);
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
}

async function search(query: string): Promise<CommandBarResults> {
  const [tabs, bookmarks, history] = await Promise.all([
    browser.tabs.query({}),
    browser.bookmarks.search(query),
    browser.history.search({ text: query, maxResults: MAX_RESULTS, startTime: 0 }),
  ]);

  const loweredQuery = query.trim().toLocaleLowerCase();
  const matchingTabs = tabs
    .filter((tab) => tab.id !== undefined && tab.windowId !== undefined && tab.url)
    .filter((tab) => !loweredQuery || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(loweredQuery))
    .slice(0, MAX_RESULTS)
    .map<CommandItem>((tab) => ({ id: `tab:${tab.id}`, kind: 'tab', title: titleFor(tab.url!, tab.title), url: tab.url!, subtitle: tab.url, faviconUrl: faviconUrlFor(tab.url!), tabId: tab.id!, windowId: tab.windowId! }));

  const matchingBookmarks = bookmarks
    .filter((bookmark) => Boolean(bookmark.url))
    .slice(0, MAX_RESULTS)
    .map<CommandItem>((bookmark) => ({ id: `bookmark:${bookmark.id}`, kind: 'bookmark', title: titleFor(bookmark.url!, bookmark.title), url: bookmark.url!, subtitle: bookmark.url, faviconUrl: faviconUrlFor(bookmark.url!) }));

  const matchingHistory = history
    .filter((entry) => Boolean(entry.url))
    .slice(0, MAX_RESULTS)
    .map<CommandItem>((entry) => ({ id: `history:${entry.id}`, kind: 'history', title: titleFor(entry.url!, entry.title), url: entry.url!, subtitle: entry.url, faviconUrl: faviconUrlFor(entry.url!) }));

  const seenUrls = new Set<string>();
  return {
    tabs: withoutDuplicateUrls(matchingTabs, seenUrls),
    bookmarks: withoutDuplicateUrls(matchingBookmarks, seenUrls),
    history: withoutDuplicateUrls(matchingHistory, seenUrls),
  };
}

async function openUrl(url: string) {
  const normalizedUrl = normalizeUrl(url);
  const existing = (await browser.tabs.query({})).find((tab) => tab.url === normalizedUrl);
  if (existing?.id !== undefined && existing.windowId !== undefined) {
    await browser.windows.update(existing.windowId, { focused: true });
    await browser.tabs.update(existing.id, { active: true });
  } else {
    await browser.tabs.create({ url: normalizedUrl, active: true });
  }
}

async function openUrlInSameDomainTab(url: string) {
  const normalizedUrl = normalizeUrl(url);
  let hostname: string;
  try {
    hostname = new URL(normalizedUrl).hostname;
  } catch {
    await openUrl(normalizedUrl);
    return;
  }

  const existing = (await browser.tabs.query({})).find((tab) => {
    if (!tab.url) return false;
    try {
      return new URL(tab.url).hostname === hostname;
    } catch {
      return false;
    }
  });

  if (existing?.id !== undefined && existing.windowId !== undefined) {
    await browser.windows.update(existing.windowId, { focused: true });
    await browser.tabs.update(existing.id, { active: true });

    if (normalizeUrl(existing.url ?? '') === normalizedUrl) return;

    const result = await browser.tabs
      .sendMessage(existing.id, { type: 'command-bar:spa-navigate', url: normalizedUrl })
      .catch(() => ({ navigated: false }));
    if (result?.navigated) return;

    await browser.tabs.update(existing.id, { url: normalizedUrl });
    return;
  }

  await openUrl(normalizedUrl);
}

async function closeCommandBarWindow() {
  if (commandBarWindowId === undefined) return;
  const windowId = commandBarWindowId;
  commandBarWindowId = undefined;
  commandBarWindowBounds = undefined;
  await browser.windows.remove(windowId).catch(() => undefined);
}

async function commandBarWindowPosition() {
  const [focusedWindow, displays] = await Promise.all([
    browser.windows.getLastFocused().catch(() => undefined),
    browser.system.display.getInfo().catch(() => []),
  ]);
  const referenceX = (focusedWindow?.left ?? 0) + (focusedWindow?.width ?? 0) / 2;
  const referenceY = (focusedWindow?.top ?? 0) + (focusedWindow?.height ?? 0) / 2;
  const display = displays.find(({ workArea }) => (
    referenceX >= workArea.left && referenceX < workArea.left + workArea.width &&
    referenceY >= workArea.top && referenceY < workArea.top + workArea.height
  )) ?? displays.find(({ isPrimary }) => isPrimary);

  if (display) {
    const { workArea } = display;
    return {
      left: Math.round(workArea.left + (workArea.width - COMMAND_BAR_WINDOW_SIZE.width) / 2),
      top: Math.round(workArea.top + (workArea.height - COMMAND_BAR_WINDOW_SIZE.height) / 2),
    };
  }

  return {
    left: Math.round((focusedWindow?.left ?? 0) + ((focusedWindow?.width ?? COMMAND_BAR_WINDOW_SIZE.width) - COMMAND_BAR_WINDOW_SIZE.width) / 2),
    top: Math.round((focusedWindow?.top ?? 0) + ((focusedWindow?.height ?? COMMAND_BAR_WINDOW_SIZE.height) - COMMAND_BAR_WINDOW_SIZE.height) / 2),
  };
}

async function openCommandBarWindow() {
  if (commandBarWindowId !== undefined) {
    await browser.windows.update(commandBarWindowId, { focused: true }).catch(() => {
      commandBarWindowId = undefined;
      commandBarWindowBounds = undefined;
    });
    if (commandBarWindowId !== undefined) return;
  }

  const commandWindow = await browser.windows.create({
    url: browser.runtime.getURL('/command-bar.html'),
    type: 'popup',
    focused: true,
    ...COMMAND_BAR_WINDOW_SIZE,
    ...await commandBarWindowPosition(),
  });
  if (!commandWindow?.id) return;

  commandBarWindowId = commandWindow.id;
  commandBarWindowBounds = {
    width: commandWindow.width ?? COMMAND_BAR_WINDOW_SIZE.width,
    height: commandWindow.height ?? COMMAND_BAR_WINDOW_SIZE.height,
    left: commandWindow.left,
    top: commandWindow.top,
  };
}

export default defineBackground(() => {
  browser.windows.onFocusChanged.addListener((windowId) => {
    if (commandBarWindowId !== undefined && windowId !== commandBarWindowId) {
      void closeCommandBarWindow();
    }
  });

  // Chromium の拡張機能ポップアップには、ネイティブウィンドウの移動・
  // リサイズを無効にする API がありません。変更を検知して元の bounds に
  // 戻すことで、コマンドバー専用の固定ウィンドウとして扱います。
  browser.windows.onBoundsChanged.addListener((window) => {
    const windowId = window.id;
    if (
      restoringCommandBarBounds ||
      windowId === undefined ||
      windowId !== commandBarWindowId ||
      !commandBarWindowBounds ||
      (window.width === commandBarWindowBounds.width &&
        window.height === commandBarWindowBounds.height &&
        window.left === commandBarWindowBounds.left &&
        window.top === commandBarWindowBounds.top)
    ) return;

    restoringCommandBarBounds = true;
    void browser.windows.update(windowId, commandBarWindowBounds)
      .catch(() => undefined)
      .finally(() => { restoringCommandBarBounds = false; });
  });

  browser.windows.onRemoved.addListener((windowId) => {
    if (windowId === commandBarWindowId) {
      commandBarWindowId = undefined;
      commandBarWindowBounds = undefined;
    }
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-command-bar') return;
    const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id === undefined) {
      await openCommandBarWindow();
      return;
    }
    try {
      await browser.tabs.sendMessage(activeTab.id, { type: 'command-bar:toggle' });
    } catch {
      // ブラウザ内部ページなど、コンテンツスクリプトを注入できないページでは
      // 独立した小窓でコマンドバーを表示する。
      await openCommandBarWindow();
    }
  });

  browser.runtime.onMessage.addListener(async (message: CommandBarMessage) => {
    switch (message.type) {
      case 'command-bar:search': return search(message.query);
      case 'command-bar:activate-tab':
        await browser.windows.update(message.windowId, { focused: true });
        await browser.tabs.update(message.tabId, { active: true });
        return;
      case 'command-bar:open-url': await openUrl(message.url); return;
      case 'command-bar:open-url-in-same-domain-tab': await openUrlInSameDomainTab(message.url); return;
      case 'command-bar:web-search':
        await browser.search.query({ text: message.query, disposition: 'NEW_TAB' });
        return;
      case 'command-bar:close-popup':
        await closeCommandBarWindow();
        return;
    }
  });
});
