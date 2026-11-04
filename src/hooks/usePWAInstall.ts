import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Installed desktop windows can stay open for days: check for a new build this often. */
const UPDATE_POLL_INTERVAL_MS = 15 * 60 * 1000;

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    // Check if running as installed desktop standalone app
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
      document.referrer.includes('android-app://');
    setIsInstalled(isStandalone);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    // Register the service worker and watch for background updates. Everything registered here
    // is torn down in the cleanup so a remount (or StrictMode double-invoke) never leaks timers.
    let cancelled = false;
    let pollId: number | undefined;
    let registration: ServiceWorkerRegistration | undefined;
    let handleUpdateFound: (() => void) | undefined;
    let refreshing = false;
    const handleControllerChange = () => {
      // The new worker took control (after SKIP_WAITING): load the new build exactly once.
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };

    const serviceWorkerEnabled = 'serviceWorker' in navigator && import.meta.env.MODE !== 'test';
    if (serviceWorkerEnabled) {
      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`)
        .then((reg) => {
          if (cancelled) return;
          registration = reg;
          pollId = window.setInterval(() => reg.update().catch(() => undefined), UPDATE_POLL_INTERVAL_MS);

          // If a new worker is already waiting, an update has arrived
          if (reg.waiting) {
            setWaitingWorker(reg.waiting);
            setHasUpdate(true);
          }

          handleUpdateFound = () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (cancelled) return;
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New update available!
                setWaitingWorker(newWorker);
                setHasUpdate(true);
              }
            });
          };
          reg.addEventListener('updatefound', handleUpdateFound);
        })
        .catch((err) => {
          console.warn('Service Worker registration skipped:', err);
        });

      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    }

    return () => {
      cancelled = true;
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      if (pollId !== undefined) window.clearInterval(pollId);
      if (registration && handleUpdateFound) registration.removeEventListener('updatefound', handleUpdateFound);
      if (serviceWorkerEnabled) navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return false;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsInstalled(true);
        setDeferredPrompt(null);
        return true;
      }
      return false;
    } catch (err) {
      // The prompt can only be used once; a second call or a browser-side failure rejects.
      console.warn('Install prompt could not be shown:', err);
      setDeferredPrompt(null);
      return false;
    }
  }, [deferredPrompt]);

  const applyUpdate = useCallback(() => {
    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  }, [waitingWorker]);

  return {
    isInstallable: !!deferredPrompt,
    isInstalled,
    hasUpdate,
    install,
    applyUpdate,
  };
}
