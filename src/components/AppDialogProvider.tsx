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

import { useAppCloseGuard } from "../hooks/useAppCloseGuard";
import { Modal } from "./Modal";

export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

export interface PromptOptions {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type ExitCloseChoice = "yes" | "no" | "ignore";

export interface ExitCloseOptions {
  title: string;
  description: string;
  yesLabel?: string;
  noLabel?: string;
  ignoreLabel?: string;
}

interface ConfirmRequest extends ConfirmOptions {
  kind: "confirm";
  resolve: (value: boolean) => void;
}

interface PromptRequest extends PromptOptions {
  kind: "prompt";
  resolve: (value: string | null) => void;
}

interface ExitCloseRequest extends ExitCloseOptions {
  kind: "exitClose";
  resolve: (value: ExitCloseChoice) => void;
}

type DialogRequest = ConfirmRequest | PromptRequest | ExitCloseRequest;

interface AppDialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  exitClose: (options: ExitCloseOptions) => Promise<ExitCloseChoice>;
}

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

export function useAppDialog(): AppDialogContextValue {
  const context = useContext(AppDialogContext);
  if (!context) {
    throw new Error("useAppDialog must be used within AppDialogProvider");
  }
  return context;
}

function ConfirmDialogBody({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: (confirmed: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const confirmLabel = request.confirmLabel ?? "确定";
  const cancelLabel = request.cancelLabel ?? "取消";
  const tone = request.tone ?? "default";

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-foreground">{request.description}</p>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn btn-outline px-4" onClick={() => onClose(false)}>
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={`btn px-4 ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
          onClick={() => onClose(true)}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function PromptDialogBody({
  request,
  onClose,
}: {
  request: PromptRequest;
  onClose: (value: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.defaultValue ?? "");

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          onClose(trimmed);
        }
      }}
    >
      {request.description ? (
        <p className="text-sm leading-6 text-muted-foreground">{request.description}</p>
      ) : null}
      <input
        ref={inputRef}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/20 focus:ring-2"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={request.placeholder}
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn btn-outline px-4" onClick={() => onClose(null)}>
          {request.cancelLabel ?? "取消"}
        </button>
        <button type="submit" className="btn btn-primary px-4" disabled={!value.trim()}>
          {request.confirmLabel ?? "确定"}
        </button>
      </div>
    </form>
  );
}

function ExitCloseDialogBody({
  request,
  onClose,
}: {
  request: ExitCloseRequest;
  onClose: (choice: ExitCloseChoice) => void;
}) {
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    yesRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose("ignore");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const yesLabel = request.yesLabel ?? "是";
  const noLabel = request.noLabel ?? "否";
  const ignoreLabel = request.ignoreLabel ?? "忽略";

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-foreground">{request.description}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="btn btn-outline px-4" onClick={() => onClose("ignore")}>
          {ignoreLabel}
        </button>
        <button type="button" className="btn btn-outline px-4" onClick={() => onClose("no")}>
          {noLabel}
        </button>
        <button
          ref={yesRef}
          type="button"
          className="btn btn-primary px-4"
          onClick={() => onClose("yes")}
        >
          {yesLabel}
        </button>
      </div>
    </div>
  );
}

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);

  const closeRequest = useCallback((result: boolean | string | null | ExitCloseChoice) => {
    setRequest((current) => {
      if (!current) {
        return null;
      }
      if (current.kind === "confirm") {
        current.resolve(result === true);
      } else if (current.kind === "exitClose") {
        current.resolve(
          result === "yes" || result === "no" || result === "ignore" ? result : "ignore",
        );
      } else {
        current.resolve(typeof result === "string" ? result : null);
      }
      return null;
    });
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setRequest({
        kind: "confirm",
        ...options,
        resolve,
      });
    });
  }, []);

  const prompt = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setRequest({
        kind: "prompt",
        ...options,
        resolve,
      });
    });
  }, []);

  const exitClose = useCallback((options: ExitCloseOptions) => {
    return new Promise<ExitCloseChoice>((resolve) => {
      setRequest({
        kind: "exitClose",
        ...options,
        resolve,
      });
    });
  }, []);

  useAppCloseGuard(exitClose);

  const contextValue = useMemo(
    () => ({ confirm, prompt, exitClose }),
    [confirm, prompt, exitClose],
  );

  return (
    <AppDialogContext.Provider value={contextValue}>
      {children}
      {request ? (
        <Modal
          open
          title={request.title}
          onClose={() =>
            closeRequest(
              request.kind === "confirm" ? false : request.kind === "exitClose" ? "ignore" : null,
            )
          }
          widthClass="max-w-md"
          layer="elevated"
        >
          {request.kind === "confirm" ? (
            <ConfirmDialogBody
              request={request}
              onClose={(confirmed) => closeRequest(confirmed)}
            />
          ) : request.kind === "exitClose" ? (
            <ExitCloseDialogBody
              request={request}
              onClose={(choice) => closeRequest(choice)}
            />
          ) : (
            <PromptDialogBody request={request} onClose={(value) => closeRequest(value)} />
          )}
        </Modal>
      ) : null}
    </AppDialogContext.Provider>
  );
}
