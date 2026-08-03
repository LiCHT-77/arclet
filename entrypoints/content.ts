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
    };

    const toggle = () => {
      if (document.getElementById(hostId)) close(); else open();
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
      if ((message as { type?: string })?.type === 'command-bar:toggle') toggle();
    });
  },
});
