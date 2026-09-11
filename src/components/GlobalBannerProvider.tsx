import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** 顶部红色提示条：展示后自动消失，避免遮挡环境列表 */
const BANNER_AUTO_DISMISS_MS = 1500;

interface GlobalBannerContextValue {
  error: string | null;
  showError: (message: string) => void;
  clearError: () => void;
}

const GlobalBannerContext = createContext<GlobalBannerContextValue | null>(null);

export function GlobalBannerProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current != null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => {
    clearDismissTimer();
    setError(null);
  }, [clearDismissTimer]);

  const showError = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) {
        clearError();
        return;
      }
      clearDismissTimer();
      setError(trimmed);
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        setError(null);
      }, BANNER_AUTO_DISMISS_MS);
    },
    [clearDismissTimer, clearError],
  );

  useEffect(() => {
    return () => {
      clearDismissTimer();
    };
  }, [clearDismissTimer]);

  const value = useMemo(
    () => ({
      error,
      showError,
      clearError,
    }),
    [clearError, error, showError],
  );

  return (
    <GlobalBannerContext.Provider value={value}>{children}</GlobalBannerContext.Provider>
  );
}

export function useGlobalBanner(): GlobalBannerContextValue {
  const ctx = useContext(GlobalBannerContext);
  if (!ctx) {
    throw new Error("useGlobalBanner must be used within GlobalBannerProvider");
  }
  return ctx;
}
