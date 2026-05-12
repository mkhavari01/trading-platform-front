/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALR_URL?: string
  readonly VITE_SIGNALR_TERMINAL?: string
  readonly VITE_SIGNALR_ACCOUNT?: string
  readonly VITE_SIGNALR_SYMBOL?: string
  /** Full URL for POST OHLC (default: `{origin of VITE_SIGNALR_URL}/Manage/ohlc`). */
  readonly VITE_OHLC_URL?: string
  /** Days of 1m history to request (default 14). */
  readonly VITE_OHLC_HISTORY_DAYS?: string
  /** Payload `timeFrame` for Manage/ohlc (default 1 = 1m). */
  readonly VITE_OHLC_TIMEFRAME?: string
  /** Query `terminalType` for Manage/broker-server-time (default 1, e.g. MT5). */
  readonly VITE_TERMINAL_TYPE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
