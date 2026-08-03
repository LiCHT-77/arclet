import type { CommandBarMessage, CommandBarResults, CommandItem } from '@/utils/command-bar';

const MAX_RESULTS = 50;

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

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(async (message: CommandBarMessage) => {
    switch (message.type) {
      case 'command-bar:search': return search(message.query);
      case 'command-bar:activate-tab':
        await browser.windows.update(message.windowId, { focused: true });
        await browser.tabs.update(message.tabId, { active: true });
        return;
      case 'command-bar:open-url': await openUrl(message.url); return;
      case 'command-bar:web-search':
        await browser.search.query({ text: message.query, disposition: 'NEW_TAB' });
        return;
    }
  });
});
