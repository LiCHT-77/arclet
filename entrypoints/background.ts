import type { CommandBarMessage, CommandBarResults, CommandItem } from '@/utils/command-bar';
import type { LittleArcMessage } from '@/utils/little-arc';
import {
  COMMAND_BAR_WINDOW_HEIGHT_SCALE,
  COMMAND_BAR_WINDOW_WIDTH_SCALE,
  LITTLE_ARC_WINDOW_HEIGHT_SCALE,
  LITTLE_ARC_WINDOW_WIDTH_SCALE,
} from '@/utils/window-layout';

const MAX_RESULTS = 50;
const MAX_SEARCH_SUGGESTIONS = 3;
const MAX_HISTORY_RESULTS_PER_DOMAIN = 3;
const HISTORY_SEARCH_MAX_RESULTS = MAX_RESULTS * MAX_HISTORY_RESULTS_PER_DOMAIN;
const LITTLE_ARC_WINDOW_STORAGE_KEY = 'littleArcWindowId';
const LITTLE_ARC_SOURCE_WINDOW_STORAGE_KEY = 'littleArcSourceWindowId';
const COMMAND_BAR_HEIGHT_TRANSITION_DURATION_MS = 180;
const COMMAND_BAR_HEIGHT_TRANSITION_FRAME_MS = 16;
const INITIAL_COMMAND_BAR_WINDOW_HEIGHT = 240;
const LITTLE_ARC_CONTEXT_MENU_ID = 'open-link-in-little-arc';
const PROMOTE_LITTLE_ARC_CONTEXT_MENU_ID = 'promote-little-arc-to-tab';
const COMMAND_BAR_SEARCH_NAVIGATION_GRACE_MS = 1_500;

let commandBarWindowId: number | undefined;
// 独立ウィンドウのコマンドバーが操作する、呼び出し元のブラウザウィンドウ。
let commandBarSourceWindowId: number | undefined;
let commandBarWindowBounds: { width: number; height: number; left?: number; top?: number } | undefined;
let commandBarWindowMaxHeight: number | undefined;
let pendingCommandBarWindowHeight: { contentHeight: number; frameHeight: number; immediate?: boolean } | undefined;
let openingCommandBarWindow = false;
let restoringCommandBarBounds = false;
let commandBarWindowHeightTransitionTimer: ReturnType<typeof setTimeout> | undefined;
let commandBarWindowHeightTransitionId = 0;
let transitioningCommandBarWindowHeight = false;
let lastCommandBarShortcutAt = 0;
const COMMAND_BAR_SHORTCUT_REPEAT_GUARD_MS = 250;
// DevTools ページは、対応する DevTools が開いている間だけ接続を維持する。
// 同じタブを検査する DevTools が複数存在しても正しく扱えるよう参照数を持つ。
const devToolsOpenCountsByTabId = new Map<number, number>();
let littleArcWindowId: number | undefined;
let littleArcSourceWindowId: number | undefined;
let littleArcWindowBounds: { width: number; height: number; left?: number; top?: number } | undefined;
let restoringLittleArcBounds = false;
// 固定タブ上のリンクまたは window.open で生成されたタブを記録する。
// tabs.onCreated だけではコマンドバーの検索による新規タブも区別できないため、
// webNavigation のリンク起点イベントで対象を限定する。
const pendingPinnedTabOpenings = new Map<number, {
  sourceWindowId: number;
  url?: string;
}>();
const capturingPinnedTabOpenings = new Set<number>();
// browser.search.query は Chromium の実装によっては opener を持つ新規タブと
// して通知される。コマンドバー起点であることを短時間だけ明示的に記録する。
const pendingCommandBarSearches = new Map<number, ReturnType<typeof setTimeout>>();

function suppressNextPinnedTabOpeningForCommandBarSearch(tabId: number) {
  const previousTimer = pendingCommandBarSearches.get(tabId);
  if (previousTimer !== undefined) clearTimeout(previousTimer);

  const timer = setTimeout(() => {
    if (pendingCommandBarSearches.get(tabId) === timer) {
      pendingCommandBarSearches.delete(tabId);
    }
  }, COMMAND_BAR_SEARCH_NAVIGATION_GRACE_MS);
  pendingCommandBarSearches.set(tabId, timer);
}

async function markCommandBarSearchSource(tab?: { id?: number; windowId?: number }) {
  let sourceTabId = tab?.id;
  if (tab?.windowId === commandBarWindowId && commandBarSourceWindowId !== undefined) {
    const [activeTab] = await browser.tabs.query({ active: true, windowId: commandBarSourceWindowId });
    sourceTabId = activeTab?.id;
  }
  if (sourceTabId === undefined) return;

  const sourceTab = await browser.tabs.get(sourceTabId);
  if (sourceTab.pinned) suppressNextPinnedTabOpeningForCommandBarSearch(sourceTabId);
}

function titleFor(url: string, title?: string) {
  if (title) return title;
  try { return new URL(url).hostname; } catch { return url; }
}

function normalizeUrl(url: string) {
  try { return new URL(url).href; } catch { return url; }
}

function isWebUrl(url: string) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function faviconUrlFor(url: string) {
  const faviconUrl = new URL(browser.runtime.getURL('/command-bar.html'));
  faviconUrl.pathname = '/_favicon/';
  faviconUrl.searchParams.set('pageUrl', url);
  faviconUrl.searchParams.set('size', '32');
  return faviconUrl.href;
}

function isArcletInternalPage(url?: string) {
  return Boolean(url && url.startsWith(browser.runtime.getURL('/')));
}

function withoutDuplicateUrls(items: CommandItem[], seenUrls: Set<string>) {
  return items.filter((item) => {
    const url = normalizeUrl(item.url);
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
}

function historyPageKey(url: string) {
  try {
    const pageUrl = new URL(url);
    // ページ内アンカーの移動は同一ページとして扱う。
    pageUrl.hash = '';
    pageUrl.hostname = pageUrl.hostname.replace(/^www\./i, '');
    return pageUrl.href;
  } catch {
    return normalizeUrl(url);
  }
}

function withoutDuplicateHistoryPages(items: CommandItem[]) {
  const seenPageUrls = new Set<string>();
  return items.filter((item) => {
    const pageKey = historyPageKey(item.url);
    if (seenPageUrls.has(pageKey)) return false;
    seenPageUrls.add(pageKey);
    return true;
  });
}

function historyDomain(url: string) {
  try {
    // www の有無で同じサイトの履歴が分散しないようにする。
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

function isHistoryRootUrl(url: string) {
  try {
    const pageUrl = new URL(url);
    return pageUrl.pathname === '/' && !pageUrl.search && !pageUrl.hash;
  } catch {
    return false;
  }
}

function limitHistoryResultsPerDomain(items: CommandItem[]) {
  const result: CommandItem[] = [];
  const countsByDomain = new Map<string, number>();
  const shortestItemByDomain = new Map<string, CommandItem>();
  const selectedItems = new Set<CommandItem>();

  for (const item of items) {
    const domain = historyDomain(item.url);
    if (domain === undefined) continue;

    const currentShortest = shortestItemByDomain.get(domain);
    if (
      currentShortest === undefined
      || (isHistoryRootUrl(item.url) && !isHistoryRootUrl(currentShortest.url))
      || (isHistoryRootUrl(item.url) === isHistoryRootUrl(currentShortest.url) && item.url.length < currentShortest.url.length)
    ) {
      shortestItemByDomain.set(domain, item);
    }
  }

  for (const item of items) {
    const domain = historyDomain(item.url);
    if (domain === undefined) {
      result.push(item);
      continue;
    }

    const shortestItem = shortestItemByDomain.get(domain);
    let count = countsByDomain.get(domain) ?? 0;

    // 同一ドメインの1件目には最短URL（存在すればルートURL）を置く。
    if (count === 0 && shortestItem !== undefined) {
      result.push(shortestItem);
      selectedItems.add(shortestItem);
      countsByDomain.set(domain, 1);
      count = 1;
    }

    if (selectedItems.has(item) || count >= MAX_HISTORY_RESULTS_PER_DOMAIN) continue;

    countsByDomain.set(domain, count + 1);
    selectedItems.add(item);
    result.push(item);
  }

  return result;
}

function isExcludedPageUrl(url: string, excludedUrl?: string) {
  return Boolean(excludedUrl && historyPageKey(url) === historyPageKey(excludedUrl));
}

async function searchSuggestions(query: string): Promise<string[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  try {
    const url = new URL('https://suggestqueries.google.com/complete/search');
    url.searchParams.set('client', 'firefox');
    url.searchParams.set('q', trimmedQuery);

    const response = await fetch(url);
    if (!response.ok) return [];

    const data: unknown = await response.json();
    if (!Array.isArray(data) || !Array.isArray(data[1])) return [];

    const seen = new Set<string>();
    return data[1]
      .filter((suggestion): suggestion is string => typeof suggestion === 'string')
      .map((suggestion) => suggestion.trim())
      .filter((suggestion) => {
        if (!suggestion || seen.has(suggestion)) return false;
        seen.add(suggestion);
        return true;
      })
      .slice(0, MAX_SEARCH_SUGGESTIONS);
  } catch {
    // ネットワークや候補サービスが利用できない場合も、他の候補検索は継続する。
    return [];
  }
}

async function search(query: string, excludedTabId?: number, excludedUrl?: string, shortcutWindowId?: number): Promise<CommandBarResults> {
  const loweredQuery = query.trim().toLocaleLowerCase();
  const [tabs, bookmarks, history, suggestions] = await Promise.all([
    browser.tabs.query({}),
    browser.bookmarks.search(query),
    // 空入力時は履歴を候補として表示しない。
    loweredQuery
      ? browser.history.search({ text: query, maxResults: HISTORY_SEARCH_MAX_RESULTS, startTime: 0 })
      : Promise.resolve([]),
    searchSuggestions(query),
  ]);

  const matchingTabs = tabs
    .filter((tab) => tab.id !== undefined && tab.windowId !== undefined && tab.url)
    // コマンドバーの展開先である親タブと拡張機能の内部ページは、
    // 移動先として選ぶ候補には含めない。
    .filter((tab) => tab.id !== excludedTabId && !isArcletInternalPage(tab.url))
    .filter((tab) => !loweredQuery || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(loweredQuery))
    .slice(0, MAX_RESULTS)
    .map<CommandItem>((tab) => ({
      id: `tab:${tab.id}`,
      kind: 'tab',
      title: titleFor(tab.url!, tab.title),
      url: tab.url!,
      subtitle: tab.url,
      faviconUrl: faviconUrlFor(tab.url!),
      tabId: tab.id!,
      windowId: tab.windowId!,
      // Chromium の ⌘1〜⌘8 は先頭から、⌘9 は最後のタブを指す。
      // 独立ウィンドウでは、呼び出し元以外のウィンドウにショートカットを
      // 表示しても移動先が曖昧になるため番号を出さない。
      tabNumber: tab.windowId !== shortcutWindowId
        ? undefined
        : tab.index < 8
          ? tab.index + 1
          : tab.index === Math.max(...tabs.filter((candidate) => candidate.windowId === shortcutWindowId).map((candidate) => candidate.index))
            ? 9
            : undefined,
    }));

  const matchingBookmarks = bookmarks
    .filter((bookmark) => Boolean(bookmark.url))
    // iframe 内で開いた command-bar.html も履歴候補と同様に表示しない。
    .filter((bookmark) => !isArcletInternalPage(bookmark.url))
    .filter((bookmark) => !isExcludedPageUrl(bookmark.url!, excludedUrl))
    .slice(0, MAX_RESULTS)
    .map<CommandItem>((bookmark) => ({ id: `bookmark:${bookmark.id}`, kind: 'bookmark', title: titleFor(bookmark.url!, bookmark.title), url: bookmark.url!, subtitle: bookmark.url, faviconUrl: faviconUrlFor(bookmark.url!) }));

  const matchingHistory = history
    .filter((entry) => Boolean(entry.url))
    // iframe 版のコマンドバーは自身の URL を履歴へ残すことがある。
    .filter((entry) => !isArcletInternalPage(entry.url))
    .filter((entry) => !isExcludedPageUrl(entry.url!, excludedUrl))
    .slice(0, HISTORY_SEARCH_MAX_RESULTS)
    .map<CommandItem>((entry) => ({ id: `history:${entry.id}`, kind: 'history', title: titleFor(entry.url!, entry.title), url: entry.url!, subtitle: entry.url, faviconUrl: faviconUrlFor(entry.url!) }));

  const seenUrls = new Set<string>();
  return {
    tabs: withoutDuplicateUrls(matchingTabs, seenUrls),
    bookmarks: withoutDuplicateUrls(matchingBookmarks, seenUrls),
    searchSuggestions: suggestions,
    history: limitHistoryResultsPerDomain(
      withoutDuplicateHistoryPages(withoutDuplicateUrls(matchingHistory, seenUrls)),
    ).slice(0, MAX_RESULTS),
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
  stopCommandBarHeightTransition();
  const windowId = commandBarWindowId;
  commandBarWindowId = undefined;
  commandBarSourceWindowId = undefined;
  commandBarWindowBounds = undefined;
  commandBarWindowMaxHeight = undefined;
  pendingCommandBarWindowHeight = undefined;
  await browser.windows.remove(windowId).catch(() => undefined);
}

function stopCommandBarHeightTransition() {
  commandBarWindowHeightTransitionId += 1;
  transitioningCommandBarWindowHeight = false;
  if (commandBarWindowHeightTransitionTimer !== undefined) {
    clearTimeout(commandBarWindowHeightTransitionTimer);
    commandBarWindowHeightTransitionTimer = undefined;
  }
}

function transitionCommandBarHeight(targetHeight: number) {
  if (commandBarWindowId === undefined || !commandBarWindowBounds) return;

  stopCommandBarHeightTransition();
  const transitionId = commandBarWindowHeightTransitionId;
  const startBounds = commandBarWindowBounds;
  const centerY = (startBounds.top ?? 0) + startBounds.height / 2;
  const startTime = performance.now();
  transitioningCommandBarWindowHeight = true;

  const step = async () => {
    if (transitionId !== commandBarWindowHeightTransitionId || commandBarWindowId === undefined) return;

    const progress = Math.min(1, (performance.now() - startTime) / COMMAND_BAR_HEIGHT_TRANSITION_DURATION_MS);
    // 開始直後は素早く、終わり際はゆっくり収束させて高さの変化を自然に見せる。
    const easedProgress = 1 - (1 - progress) ** 3;
    const height = Math.round(startBounds.height + (targetHeight - startBounds.height) * easedProgress);
    const nextBounds = { ...startBounds, height, top: Math.round(centerY - height / 2) };
    commandBarWindowBounds = nextBounds;
    // windows.update を並行して投げると OS 側で古いサイズが後から反映され、
    // 高さが跳ねて見えることがある。1 回の反映完了を待ってから次へ進める。
    await browser.windows.update(commandBarWindowId, nextBounds).catch(() => undefined);
    if (transitionId !== commandBarWindowHeightTransitionId || commandBarWindowId === undefined) return;

    if (progress < 1) {
      commandBarWindowHeightTransitionTimer = setTimeout(() => { void step(); }, COMMAND_BAR_HEIGHT_TRANSITION_FRAME_MS);
      return;
    }

    commandBarWindowHeightTransitionTimer = undefined;
    transitioningCommandBarWindowHeight = false;
  };

  void step();
}

async function setCommandBarHeightImmediately(targetHeight: number) {
  if (commandBarWindowId === undefined || !commandBarWindowBounds) return;

  stopCommandBarHeightTransition();
  const currentBounds = commandBarWindowBounds;
  const centerY = (currentBounds.top ?? 0) + currentBounds.height / 2;
  const nextBounds = {
    ...currentBounds,
    height: targetHeight,
    top: Math.round(centerY - targetHeight / 2),
  };
  commandBarWindowBounds = nextBounds;
  await browser.windows.update(commandBarWindowId, nextBounds).catch(() => undefined);
}

async function initialCommandBarWindowBounds(sourceWindowId?: number) {
  const [focusedWindow, displays] = await Promise.all([
    sourceWindowId === undefined
      ? browser.windows.getLastFocused().catch(() => undefined)
      : browser.windows.get(sourceWindowId).catch(() => undefined),
    browser.system.display.getInfo().catch(() => []),
  ]);
  const hasFocusedWindowBounds = focusedWindow?.width !== undefined && focusedWindow.height !== undefined;
  const referenceX = hasFocusedWindowBounds ? (focusedWindow.left ?? 0) + focusedWindow.width! / 2 : undefined;
  const referenceY = hasFocusedWindowBounds ? (focusedWindow.top ?? 0) + focusedWindow.height! / 2 : undefined;
  const display = (referenceX !== undefined && referenceY !== undefined
    ? displays.find(({ workArea }) => (
      referenceX >= workArea.left && referenceX < workArea.left + workArea.width &&
      referenceY >= workArea.top && referenceY < workArea.top + workArea.height
    ))
    : undefined) ?? displays.find(({ isPrimary }) => isPrimary);

  const workArea = display?.workArea;
  if (!hasFocusedWindowBounds && !workArea) return undefined;

  const sourceWidth = focusedWindow?.width ?? workArea!.width;
  const sourceHeight = focusedWindow?.height ?? workArea!.height;
  const sourceLeft = focusedWindow?.left ?? workArea!.left;
  const sourceTop = focusedWindow?.top ?? workArea!.top;
  const width = Math.min(Math.round(sourceWidth * COMMAND_BAR_WINDOW_WIDTH_SCALE), workArea?.width ?? sourceWidth);
  const maxHeight = Math.min(Math.round(sourceHeight * COMMAND_BAR_WINDOW_HEIGHT_SCALE), workArea?.height ?? sourceHeight);
  const height = Math.min(maxHeight, INITIAL_COMMAND_BAR_WINDOW_HEIGHT);
  const desiredLeft = Math.round(sourceLeft + (sourceWidth - width) / 2);
  const desiredTop = Math.round(sourceTop + (sourceHeight - height) / 2);

  return {
    width,
    // 初期 DOM は検索結果の取得前なので、画面比の最大高で開くと一度大きく
    // 見えてから縮む。暫定値で作成し、実測後に最大高まで伸ばせるようにする。
    height: Math.min(height, INITIAL_COMMAND_BAR_WINDOW_HEIGHT),
    maxHeight,
    left: workArea ? Math.max(workArea.left, Math.min(desiredLeft, workArea.left + workArea.width - width)) : desiredLeft,
    top: workArea ? Math.max(workArea.top, Math.min(desiredTop, workArea.top + workArea.height - height)) : desiredTop,
  };
}

async function openCommandBarWindow(sourceWindowId?: number) {
  if (commandBarWindowId !== undefined) {
    await browser.windows.update(commandBarWindowId, { focused: true }).catch(() => {
      commandBarWindowId = undefined;
      commandBarWindowBounds = undefined;
    });
    if (commandBarWindowId !== undefined) return;
  }

  const initialBounds = await initialCommandBarWindowBounds(sourceWindowId);
  const { maxHeight: initialMaxHeight, ...windowInitialBounds } = initialBounds ?? {};
  openingCommandBarWindow = true;
  const commandWindow = await browser.windows.create({
    url: browser.runtime.getURL('/command-bar.html'),
    type: 'popup',
    focused: true,
    ...windowInitialBounds,
  }).catch(() => undefined);
  openingCommandBarWindow = false;
  if (!commandWindow?.id) {
    pendingCommandBarWindowHeight = undefined;
    return;
  }

  const width = commandWindow.width ?? initialBounds?.width;
  const height = commandWindow.height ?? initialBounds?.height;
  commandBarWindowId = commandWindow.id;
  commandBarSourceWindowId = sourceWindowId;
  commandBarWindowMaxHeight = initialMaxHeight;
  commandBarWindowBounds = width === undefined || height === undefined
    ? undefined
    : { width, height, left: commandWindow.left, top: commandWindow.top };

  // command-bar.html は windows.create() の完了前に読み込みを終え、最初の
  // サイズ通知を送ることがある。その通知を取りこぼさずに反映する。
  if (pendingCommandBarWindowHeight) {
    const { contentHeight, frameHeight, immediate } = pendingCommandBarWindowHeight;
    pendingCommandBarWindowHeight = undefined;
    await resizeCommandBarWindow(contentHeight, frameHeight, immediate);
  }
}

async function resizeCommandBarWindow(contentHeight: number, frameHeight: number, immediate = false) {
  if (commandBarWindowId === undefined || !commandBarWindowBounds || !commandBarWindowMaxHeight) {
    // ポップアップの DOM が起動済みでも、background 側ではまだ生成結果を
    // 受け取っていない場合がある。生成完了時に一度だけ適用する。
    if (openingCommandBarWindow) pendingCommandBarWindowHeight = { contentHeight, frameHeight, immediate };
    return;
  }

  const current = commandBarWindowBounds;
  const desiredHeight = Math.min(
    commandBarWindowMaxHeight,
    Math.max(1, Math.ceil(contentHeight + Math.max(0, frameHeight))),
  );
  if (desiredHeight === current.height) return;

  if (immediate) {
    await setCommandBarHeightImmediately(desiredHeight);
    return;
  }
  transitionCommandBarHeight(desiredHeight);
}

async function storedLittleArcWindowId() {
  if (littleArcWindowId !== undefined) return littleArcWindowId;

  const stored = await browser.storage.session.get([
    LITTLE_ARC_WINDOW_STORAGE_KEY,
    LITTLE_ARC_SOURCE_WINDOW_STORAGE_KEY,
  ]);
  const windowId = stored[LITTLE_ARC_WINDOW_STORAGE_KEY];
  if (typeof windowId === 'number') littleArcWindowId = windowId;
  const sourceWindowId = stored[LITTLE_ARC_SOURCE_WINDOW_STORAGE_KEY];
  if (typeof sourceWindowId === 'number') littleArcSourceWindowId = sourceWindowId;
  return littleArcWindowId;
}

async function rememberLittleArcWindow(windowId: number | undefined, sourceWindowId?: number) {
  littleArcWindowId = windowId;
  littleArcSourceWindowId = sourceWindowId;
  if (windowId === undefined) {
    await browser.storage.session.remove([
      LITTLE_ARC_WINDOW_STORAGE_KEY,
      LITTLE_ARC_SOURCE_WINDOW_STORAGE_KEY,
    ]);
  } else {
    await browser.storage.session.set({
      [LITTLE_ARC_WINDOW_STORAGE_KEY]: windowId,
      ...(sourceWindowId === undefined ? {} : { [LITTLE_ARC_SOURCE_WINDOW_STORAGE_KEY]: sourceWindowId }),
    });
  }
}

async function initialLittleArcWindowBounds(sourceWindowId?: number) {
  const [sourceWindow, displays] = await Promise.all([
    sourceWindowId === undefined ? Promise.resolve(undefined) : browser.windows.get(sourceWindowId).catch(() => undefined),
    browser.system.display.getInfo().catch(() => []),
  ]);
  const hasSourceWindowBounds = sourceWindow?.width !== undefined && sourceWindow.height !== undefined;
  const sourceCenterX = hasSourceWindowBounds ? (sourceWindow.left ?? 0) + sourceWindow.width! / 2 : undefined;
  const sourceCenterY = hasSourceWindowBounds ? (sourceWindow.top ?? 0) + sourceWindow.height! / 2 : undefined;
  const display = (sourceCenterX !== undefined && sourceCenterY !== undefined
    ? displays.find(({ workArea }) => (
      sourceCenterX >= workArea.left && sourceCenterX < workArea.left + workArea.width &&
      sourceCenterY >= workArea.top && sourceCenterY < workArea.top + workArea.height
    ))
    : undefined) ?? displays.find(({ isPrimary }) => isPrimary);
  const workArea = display?.workArea;
  if (!hasSourceWindowBounds && !workArea) return undefined;

  const sourceWidth = sourceWindow?.width ?? workArea!.width;
  const sourceHeight = sourceWindow?.height ?? workArea!.height;
  const sourceLeft = sourceWindow?.left ?? workArea!.left;
  const sourceTop = sourceWindow?.top ?? workArea!.top;
  const width = Math.min(Math.round(sourceWidth * LITTLE_ARC_WINDOW_WIDTH_SCALE), workArea?.width ?? sourceWidth);
  const height = Math.min(Math.round(sourceHeight * LITTLE_ARC_WINDOW_HEIGHT_SCALE), workArea?.height ?? sourceHeight);
  const desiredLeft = Math.round(sourceLeft + (sourceWidth - width) / 2);
  const desiredTop = Math.round(sourceTop + (sourceHeight - height) / 2);

  return {
    width,
    height,
    left: workArea ? Math.max(workArea.left, Math.min(desiredLeft, workArea.left + workArea.width - width)) : desiredLeft,
    top: workArea ? Math.max(workArea.top, Math.min(desiredTop, workArea.top + workArea.height - height)) : desiredTop,
  };
}

async function navigateLittleArc(windowId: number, url: string) {
  await browser.windows.update(windowId, { focused: true });
  const [activeTab] = await browser.tabs.query({ windowId, active: true });
  if (activeTab?.id === undefined) throw new Error('Little Arc のアクティブタブが見つかりません。');
  await browser.tabs.update(activeTab.id, { url, active: true });
}

async function openLittleArc(url: string, sourceWindowId?: number) {
  const normalizedUrl = normalizeUrl(url);
  const existingWindowId = await storedLittleArcWindowId();

  if (existingWindowId !== undefined) {
    try {
      await navigateLittleArc(existingWindowId, normalizedUrl);
      return;
    } catch {
      await rememberLittleArcWindow(undefined);
    }
  }

  const initialBounds = await initialLittleArcWindowBounds(sourceWindowId);
  const littleArcWindow = await browser.windows.create({
    url: normalizedUrl,
    type: 'popup',
    focused: true,
    ...initialBounds,
  });
  if (littleArcWindow?.id !== undefined) {
    const width = littleArcWindow.width ?? initialBounds?.width;
    const height = littleArcWindow.height ?? initialBounds?.height;
    littleArcWindowBounds = width === undefined || height === undefined
      ? undefined
      : { width, height, left: littleArcWindow.left, top: littleArcWindow.top };
    await rememberLittleArcWindow(littleArcWindow.id, sourceWindowId);
  }
}

async function normalWindowForLittleArcPromotion() {
  if (littleArcSourceWindowId !== undefined) {
    const sourceWindow = await browser.windows.get(littleArcSourceWindowId).catch(() => undefined);
    if (sourceWindow?.type === 'normal') return sourceWindow;
  }

  const [normalWindow] = await browser.windows.getAll({ windowTypes: ['normal'] });
  return normalWindow;
}

async function promoteLittleArcToTab(tab?: { id?: number; windowId?: number }) {
  const littleArcWindow = await storedLittleArcWindowId();
  if (littleArcWindow === undefined || tab?.id === undefined || tab.windowId !== littleArcWindow) return;

  const targetWindow = await normalWindowForLittleArcPromotion();
  if (targetWindow?.id === undefined) return;

  // タブを移動すると Little Arc の空ウィンドウは自動的に閉じるため、先に
  // 記録を消して onRemoved / onFocusChanged から二重に閉じないようにする。
  await rememberLittleArcWindow(undefined);
  littleArcWindowBounds = undefined;
  await browser.tabs.move(tab.id, { windowId: targetWindow.id, index: -1 });
  await browser.windows.update(targetWindow.id, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
}

async function closeLittleArcWindow() {
  const windowId = await storedLittleArcWindowId();
  if (windowId === undefined) return;

  await rememberLittleArcWindow(undefined);
  littleArcWindowBounds = undefined;
  await browser.windows.remove(windowId).catch(() => undefined);
}

async function closeLittleArcWhenFocusLost(focusedWindowId: number) {
  const windowId = await storedLittleArcWindowId();
  if (windowId !== undefined && focusedWindowId !== windowId) await closeLittleArcWindow();
}

async function openPinnedTabOpeningInLittleArc(tabId: number) {
  const pending = pendingPinnedTabOpenings.get(tabId);
  if (!pending || !pending.url || !isWebUrl(pending.url) || capturingPinnedTabOpenings.has(tabId)) return;

  // 待機中に別の URL へ遷移した場合は、最新の URL を使う。
  const latest = pendingPinnedTabOpenings.get(tabId);
  if (!latest?.url || !isWebUrl(latest.url) || capturingPinnedTabOpenings.has(tabId)) return;

  capturingPinnedTabOpenings.add(tabId);
  pendingPinnedTabOpenings.delete(tabId);
  try {
    // 先に通常タブを閉じることで、そのタブへのフォーカス移動によって既存の
    // Little Arc が閉じた後でも、新しい Little Arc を確実に表示できる。
    await browser.tabs.remove(tabId);
    await openLittleArc(latest.url, latest.sourceWindowId);
  } catch {
    // ユーザーが URL 確定前にタブを閉じた場合などは何もしない。
  } finally {
    capturingPinnedTabOpenings.delete(tabId);
  }
}

export default defineBackground(() => {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'arclet-devtools') return;

    let inspectedTabId: number | undefined;
    port.onMessage.addListener((message: unknown) => {
      if (
        inspectedTabId !== undefined ||
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'devtools:connected' ||
        !('tabId' in message) ||
        typeof message.tabId !== 'number'
      ) return;

      inspectedTabId = message.tabId;
      devToolsOpenCountsByTabId.set(
        inspectedTabId,
        (devToolsOpenCountsByTabId.get(inspectedTabId) ?? 0) + 1,
      );
      // DevTools を開く前から iframe 版が表示されていた場合も、以降は
      // window 版だけが残るよう明示的に閉じる。
      void browser.tabs.sendMessage(inspectedTabId, { type: 'command-bar:close' }).catch(() => undefined);
    });

    port.onDisconnect.addListener(() => {
      if (inspectedTabId === undefined) return;
      const nextCount = (devToolsOpenCountsByTabId.get(inspectedTabId) ?? 1) - 1;
      if (nextCount > 0) devToolsOpenCountsByTabId.set(inspectedTabId, nextCount);
      else devToolsOpenCountsByTabId.delete(inspectedTabId);
    });
  });

  browser.contextMenus.removeAll()
    .then(async () => {
      browser.contextMenus.create({
        id: LITTLE_ARC_CONTEXT_MENU_ID,
        title: 'Little Arc で開く',
        contexts: ['link'],
      });
      browser.contextMenus.create({
        id: PROMOTE_LITTLE_ARC_CONTEXT_MENU_ID,
        title: '通常のタブに昇格',
        contexts: ['all'],
      });
    })
    .catch(() => undefined);

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === LITTLE_ARC_CONTEXT_MENU_ID && info.linkUrl && isWebUrl(info.linkUrl)) {
      void openLittleArc(info.linkUrl, tab?.windowId);
      return;
    }
    if (info.menuItemId === PROMOTE_LITTLE_ARC_CONTEXT_MENU_ID) {
      void promoteLittleArcToTab(tab);
    }
  });

  browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const searchTimer = pendingCommandBarSearches.get(details.sourceTabId);
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      pendingCommandBarSearches.delete(details.sourceTabId);
      return;
    }

    void Promise.all([
      browser.tabs.get(details.sourceTabId),
      browser.tabs.get(details.tabId),
    ]).then(([opener, target]) => {
      if (!opener.pinned || opener.windowId === undefined) return;

      pendingPinnedTabOpenings.set(details.tabId, {
        sourceWindowId: opener.windowId,
        url: target.pendingUrl ?? target.url ?? details.url,
      });
      void openPinnedTabOpeningInLittleArc(details.tabId);
    }).catch(() => undefined);
  });

  browser.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    const pending = pendingPinnedTabOpenings.get(tabId);
    if (!pending) return;

    pending.url = tab.pendingUrl ?? tab.url ?? pending.url;
    void openPinnedTabOpeningInLittleArc(tabId);
  });

  browser.windows.onFocusChanged.addListener((windowId) => {
    if (commandBarWindowId !== undefined && windowId !== commandBarWindowId) {
      void closeCommandBarWindow();
    }
    void closeLittleArcWhenFocusLost(windowId);
  });

  // Chromium の拡張機能ポップアップには、ネイティブウィンドウの移動・
  // リサイズを無効にする API がありません。変更を検知して元の bounds に
  // 戻すことで、コマンドバーと Little Arc を固定ウィンドウとして扱います。
  browser.windows.onBoundsChanged.addListener((window) => {
    const windowId = window.id;
    if (windowId === undefined) return;

    if (
      !restoringCommandBarBounds &&
      !transitioningCommandBarWindowHeight &&
      windowId === commandBarWindowId &&
      commandBarWindowBounds &&
      (window.width !== commandBarWindowBounds.width ||
        window.height !== commandBarWindowBounds.height ||
        window.left !== commandBarWindowBounds.left ||
        window.top !== commandBarWindowBounds.top)
    ) {
      restoringCommandBarBounds = true;
      void browser.windows.update(windowId, commandBarWindowBounds)
        .catch(() => undefined)
        .finally(() => { restoringCommandBarBounds = false; });
      return;
    }

    if (
      restoringLittleArcBounds ||
      windowId !== littleArcWindowId ||
      !littleArcWindowBounds ||
      (window.width === littleArcWindowBounds.width &&
        window.height === littleArcWindowBounds.height &&
        window.left === littleArcWindowBounds.left &&
        window.top === littleArcWindowBounds.top)
    ) return;

    restoringLittleArcBounds = true;
    void browser.windows.update(windowId, littleArcWindowBounds)
      .catch(() => undefined)
      .finally(() => { restoringLittleArcBounds = false; });
  });

  browser.windows.onRemoved.addListener((windowId) => {
    if (windowId === commandBarWindowId) {
      stopCommandBarHeightTransition();
      commandBarWindowId = undefined;
      commandBarSourceWindowId = undefined;
      commandBarWindowBounds = undefined;
      commandBarWindowMaxHeight = undefined;
      pendingCommandBarWindowHeight = undefined;
    }
    if (windowId === littleArcWindowId) void rememberLittleArcWindow(undefined);
    if (windowId === littleArcWindowId) littleArcWindowBounds = undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    pendingPinnedTabOpenings.delete(tabId);
    capturingPinnedTabOpenings.delete(tabId);
    devToolsOpenCountsByTabId.delete(tabId);
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command === 'promote-little-arc-to-tab') {
      const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      await promoteLittleArcToTab(activeTab);
      return;
    }

    if (command !== 'toggle-command-bar') return;

    // commands API はキーリピートも個別のコマンドとして通知する。押下中の
    // 連続通知をそのまま toggle すると、表示と非表示が交互に切り替わる。
    const now = Date.now();
    if (now - lastCommandBarShortcutAt < COMMAND_BAR_SHORTCUT_REPEAT_GUARD_MS) {
      lastCommandBarShortcutAt = now;
      return;
    }
    lastCommandBarShortcutAt = now;

    const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id === undefined) {
      await openCommandBarWindow(activeTab?.windowId);
      return;
    }
    if (devToolsOpenCountsByTabId.has(activeTab.id)) {
      await browser.tabs.sendMessage(activeTab.id, { type: 'command-bar:close' }).catch(() => undefined);
      await openCommandBarWindow(activeTab.windowId);
      return;
    }
    try {
      await browser.tabs.sendMessage(activeTab.id, { type: 'command-bar:toggle' });
    } catch {
      // ブラウザ内部ページなど、コンテンツスクリプトを注入できないページでは
      // 独立した小窓でコマンドバーを表示する。
      await openCommandBarWindow(activeTab.windowId);
    }
  });

  browser.runtime.onMessage.addListener(async (message: CommandBarMessage | LittleArcMessage, sender) => {
    switch (message.type) {
      case 'little-arc:open':
        await openLittleArc(message.url, sender.tab?.windowId);
        return;
      case 'command-bar:search': return search(
        message.query,
        sender.tab?.id,
        sender.tab?.url,
        sender.tab?.windowId === commandBarWindowId
          ? commandBarSourceWindowId
          : sender.tab?.windowId,
      );
      case 'command-bar:activate-tab':
        await browser.windows.update(message.windowId, { focused: true });
        await browser.tabs.update(message.tabId, { active: true });
        return;
      case 'command-bar:activate-tab-shortcut': {
        if (commandBarSourceWindowId === undefined) return;
        const tabs = (await browser.tabs.query({ windowId: commandBarSourceWindowId }))
          .filter((tab) => tab.id !== undefined)
          .sort((left, right) => left.index - right.index);
        const target = message.shortcutNumber === 9
          ? tabs.at(-1)
          : tabs[message.shortcutNumber - 1];
        if (!target?.id) return;
        await browser.windows.update(commandBarSourceWindowId, { focused: true });
        await browser.tabs.update(target.id, { active: true });
        return;
      }
      case 'command-bar:close-tab':
        await browser.tabs.remove(message.tabId);
        return;
      case 'command-bar:open-url': await openUrl(message.url); return;
      case 'command-bar:open-url-in-same-domain-tab': await openUrlInSameDomainTab(message.url); return;
      case 'command-bar:web-search':
        await markCommandBarSearchSource(sender.tab).catch(() => undefined);
        await browser.search.query({ text: message.query, disposition: 'NEW_TAB' });
        return;
      case 'command-bar:resize-window':
        await resizeCommandBarWindow(message.contentHeight, message.frameHeight, message.immediate);
        return;
      case 'command-bar:close-popup':
        await closeCommandBarWindow();
        return;
    }
  });
});
