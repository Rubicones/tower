"use client";

import { useCallback, useEffect, useState } from "react";

const DISMISS_KEY = "tower-install-dismissed";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const SHOW_DELAY_MS = 2_400;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia(
    "(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)",
  );
  const iosStandalone =
    "standalone" in navigator &&
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return media.matches || iosStandalone;
}

function wasDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return true;
    return Date.now() - at < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Soft suggestion to install the PWA. Uses beforeinstallprompt on Chromium;
 * on iOS shows Add to Home Screen steps. Hidden when already installed.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [iosHints, setIosHints] = useState(false);
  const [variant, setVariant] = useState<"chromium" | "ios" | null>(null);

  useEffect(() => {
    if (isStandaloneDisplay() || wasDismissedRecently()) return;

    const onBip = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBip);

    const delay = window.setTimeout(() => {
      if (isStandaloneDisplay() || wasDismissedRecently()) return;
      if (isIosDevice()) {
        setVariant("ios");
        setVisible(true);
        return;
      }
      setVariant("chromium");
    }, SHOW_DELAY_MS);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.clearTimeout(delay);
    };
  }, []);

  useEffect(() => {
    if (variant === "chromium" && deferred) setVisible(true);
  }, [variant, deferred]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore quota / private mode */
    }
    setVisible(false);
    setIosHints(false);
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === "accepted") setVisible(false);
    else dismiss();
  }, [deferred, dismiss]);

  if (!visible || !variant) return null;
  if (variant === "chromium" && !deferred) return null;

  return (
    <div
      role="dialog"
      aria-label="Install tower"
      className="animate-tower-in pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto flex w-full max-w-md flex-col gap-3 border border-white/8 bg-black/70 px-4 py-3.5 backdrop-blur-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-light tracking-[0.35em] text-foreground/90 lowercase">
              install tower
            </p>
            <p className="text-muted mt-1.5 font-mono text-[9px] uppercase tracking-[0.22em]">
              {variant === "ios"
                ? "fullscreen on your home screen"
                : "add to home · fullscreen app"}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss install suggestion"
            className="text-muted hover:text-foreground -mt-0.5 -mr-1 px-2 py-1 font-mono text-[10px] tracking-widest transition-colors"
          >
            later
          </button>
        </div>

        {variant === "chromium" ? (
          <button
            type="button"
            onClick={() => void install()}
            className="border-accent/35 text-accent hover:border-accent/60 hover:bg-accent/5 self-start border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.28em] transition-colors"
          >
            install
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setIosHints((v) => !v)}
              className="border-accent/35 text-accent hover:border-accent/60 hover:bg-accent/5 self-start border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.28em] transition-colors"
            >
              {iosHints ? "hide steps" : "how to install"}
            </button>
            {iosHints && (
              <ol className="text-muted space-y-1.5 font-mono text-[9px] uppercase tracking-[0.18em]">
                <li>1. tap share</li>
                <li>2. add to home screen</li>
                <li>3. open tower from home</li>
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
