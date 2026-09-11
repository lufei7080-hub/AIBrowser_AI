import type { ConnectivityStatus } from "../../types";

interface ConnectivityIndicatorProps {
  status: ConnectivityStatus;
}

export function ConnectivityIndicator({ status }: ConnectivityIndicatorProps) {
  if (status === "testing") {
    return <span className="text-xs text-muted-foreground">测试中…</span>;
  }
  if (status === "success") {
    return <span className="text-xs font-medium text-emerald-600">已连接</span>;
  }
  if (status === "error") {
    return <span className="text-xs font-medium text-red-500">未连接</span>;
  }
  return <span className="text-xs text-muted-foreground">未测试</span>;
}
