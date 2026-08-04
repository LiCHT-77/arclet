export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    const hostId = 'arclet-command-bar-host';
    const hostStyleId = 'arclet-command-bar-host-style';
    let backdropSheet: CSSStyleSheet | undefined;

    const applyImportantStyles = (element: HTMLElement, styles: Record<string, string>) => {
      for (const [property, value] of Object.entries(styles)) {
        element.style.setProperty(property, value, 'important');
      }
    };

    const close = () => {
      document.getElementById(hostId)?.remove();
      document.getElementById(hostStyleId)?.remove();
      if (backdropSheet) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== backdropSheet);
        backdropSheet = undefined;
      }
    };

    const open = () => {
      if (document.getElementById(hostId)) return;

      const host = document.createElement('dialog');
      const hostStyle = document.createElement('style');
      hostStyle.id = hostStyleId;
      hostStyle.textContent = `#${hostId}::backdrop { background: transparent !important; }`;
      host.id = hostId;
      host.setAttribute('aria-label', 'Arclet コマンドバー');
      applyImportantStyles(host, {
        background: 'transparent', border: '0', display: 'block', height: '100vh',
        inset: '0', margin: '0', 'max-height': 'none', 'max-width': 'none',
        overflow: 'visible', padding: '0', position: 'fixed', width: '100vw',
        'z-index': '2147483647',
      });
      const iframe = document.createElement('iframe');
      iframe.src = browser.runtime.getURL('/command-bar.html');
      iframe.title = 'Arclet コマンドバー';
      iframe.setAttribute('aria-label', 'Arclet コマンドバー');
      applyImportantStyles(iframe, {
        background: 'transparent', border: '0', display: 'block', height: '100%',
        inset: '0', position: 'absolute', width: '100%',
        // `prefers-color-scheme` in an iframe inherits the embedding page's
        // `color-scheme`. Set the embedding context explicitly so sites such
        // as Slack cannot force the command bar into their own light scheme.
        'color-scheme': 'light dark',
      });
      host.append(iframe);
      host.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
      });
      document.documentElement.append(hostStyle, host);
      try {
        backdropSheet = new CSSStyleSheet();
        backdropSheet.replaceSync(`#${hostId}::backdrop { background: transparent !important; }`);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, backdropSheet];
      } catch {
        // The style element above is used by browsers without constructable stylesheets.
      }
      host.showModal();

      const focusCommandInput = () => {
        // `autofocus` inside an iframe does not always take focus away from an
        // already-focused control in the host page. Focus the browsing context
        // first, then ask the command-bar document to focus its input. This
        // must run after `load`: before then the iframe is still its initial
        // `about:blank` document, whose origin is the embedding site.
        iframe.focus({ preventScroll: true });
        iframe.contentWindow?.postMessage(
          { type: 'arclet:command-bar-focus' },
          new URL(browser.runtime.getURL('/')).origin,
        );
      };
      iframe.addEventListener('load', focusCommandInput, { once: true });
    };

    const toggle = () => {
      if (document.getElementById(hostId)) close(); else open();
    };

    const trySpaNavigation = async (url: string) => {
      let targetUrl: string;
      try {
        targetUrl = new URL(url).href;
      } catch {
        return { navigated: false };
      }

      // サイトが document レベルでリンククリックを横取りしている場合は、
      // 一時的なリンクでもクライアントルーターによる遷移になる。
      const link = document.createElement('a');
      link.href = targetUrl;
      link.hidden = true;
      link.tabIndex = -1;
      link.setAttribute('aria-hidden', 'true');
      (document.body ?? document.documentElement).append(link);
      link.click();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      link.remove();
      return { navigated: window.location.href === targetUrl };
    };

    window.addEventListener('message', (event) => {
      const iframe = document.querySelector(`#${hostId} > iframe`) as HTMLIFrameElement | null;
      if (
        event.source === iframe?.contentWindow &&
        event.origin === new URL(browser.runtime.getURL('/')).origin &&
        event.data?.type === 'arclet:command-bar-close'
      ) close();
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      const command = message as { type?: string; url?: string };
      if (command.type === 'command-bar:toggle') toggle();
      if (command.type === 'command-bar:spa-navigate' && command.url) return trySpaNavigation(command.url);
    });
  },
});
