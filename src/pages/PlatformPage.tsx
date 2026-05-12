import * as signalR from '@microsoft/signalr'
import { useDrag } from '@use-gesture/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CandlestickSeries, createChart, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, IPriceLine, ISeriesApi, UTCTimestamp } from 'lightweight-charts'

function removeSeriesPriceLine(series: ISeriesApi<'Candlestick'>, line: IPriceLine | undefined | null) {
  if (line == null) return
  series.removePriceLine(line)
}

type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

function generateSampleCandles(): Candle[] {
  const start = Math.floor(Date.now() / 1000) - 60 * 60 * 24
  const candles: Candle[] = []
  let price = 100

  for (let i = 0; i < 200; i++) {
    const open = price
    const drift = (Math.random() - 0.5) * 2
    const close = Math.max(1, open + drift)
    const high = Math.max(open, close) + Math.random()
    const low = Math.min(open, close) - Math.random()
    price = close

    candles.push({
      time: start + i * 60 * 5,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    })
  }

  return candles
}

type BinanceKline = [
  number, // open time (ms)
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time (ms)
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base asset volume
  string, // taker buy quote asset volume
  string, // ignore
]

type BinanceWsKlineEvent = {
  e: 'kline'
  E: number
  s: string
  k: {
    t: number // open time (ms)
    T: number // close time (ms)
    s: string
    i: string // interval
    o: string
    c: string
    h: string
    l: string
    x: boolean // is this kline closed?
  }
}

async function fetchBinanceCandles({
  symbol,
  interval,
  limit,
  signal,
}: {
  symbol: string
  interval: string
  limit: number
  signal: AbortSignal
}): Promise<Candle[]> {
  const url = new URL('https://api.binance.com/api/v3/klines')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', interval)
  url.searchParams.set('limit', String(limit))

  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`Market data request failed (${res.status})`)
  }

  const raw = (await res.json()) as BinanceKline[]
  return raw.map((k) => {
    const timeMs = k[0]
    return {
      time: Math.floor(timeMs / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }
  })
}

/** MT stream: live `quote` ticks; history: POST `Manage/ohlc` (see `fetchMtOhlcCandles`). */
const SIGNALR_URL = (import.meta.env.VITE_SIGNALR_URL as string | undefined)?.trim()
const SIGNALR_TERMINAL = (
  (import.meta.env.VITE_SIGNALR_TERMINAL as string | undefined) ?? 'MT5'
).trim()
const SIGNALR_ACCOUNT = Number((import.meta.env.VITE_SIGNALR_ACCOUNT as string | undefined) ?? '')
const SIGNALR_DEFAULT_SYMBOL = (
  (import.meta.env.VITE_SIGNALR_SYMBOL as string | undefined) ?? 'XAUUSD'
)
  .trim()
  .toUpperCase()

const USE_SIGNALR_STREAM = Boolean(
  SIGNALR_URL && Number.isFinite(SIGNALR_ACCOUNT) && SIGNALR_ACCOUNT > 0,
)

const DEFAULT_CHART_SYMBOL = USE_SIGNALR_STREAM ? SIGNALR_DEFAULT_SYMBOL : 'BTCUSDT'

function hubOriginFromUrl(hubUrl: string): string | null {
  try {
    return new URL(hubUrl).origin
  } catch {
    return null
  }
}

const OHLC_API_URL = (() => {
  const explicit = (import.meta.env.VITE_OHLC_URL as string | undefined)?.trim()
  if (explicit) return explicit
  if (!SIGNALR_URL) return ''
  const origin = hubOriginFromUrl(SIGNALR_URL)
  return origin ? `${origin}/Manage/ohlc` : ''
})()

const OHLC_HISTORY_DAYS = Math.max(
  1,
  Number((import.meta.env.VITE_OHLC_HISTORY_DAYS as string | undefined) ?? '14') || 14,
)

const OHLC_TIMEFRAME = Math.max(
  1,
  Number((import.meta.env.VITE_OHLC_TIMEFRAME as string | undefined) ?? '1') || 1,
)

const BROKER_TERMINAL_TYPE = Math.max(
  0,
  Number((import.meta.env.VITE_TERMINAL_TYPE as string | undefined) ?? '1') || 1,
)

function manageOriginFromOhlcUrl(ohlcUrl: string): string | null {
  try {
    return new URL(ohlcUrl).origin
  } catch {
    return null
  }
}

type BrokerServerTimeResponse = {
  statusCode?: number
  message?: string
  brokerServerTime?: string
}

/** GET /Manage/broker-server-time — use `brokerServerTime` as OHLC `to` (broker clock, not browser). */
async function fetchBrokerServerTime(opts: {
  manageOrigin: string
  terminalType: number
  accountNumber: number
  signal?: AbortSignal
}): Promise<string> {
  const q = new URLSearchParams({
    terminalType: String(opts.terminalType),
    accountNumber: String(opts.accountNumber),
  })
  const url = `${opts.manageOrigin}/Manage/broker-server-time?${q.toString()}`
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    signal: opts.signal,
  })
  if (!res.ok) {
    throw new Error(`Broker server time failed (${res.status})`)
  }
  const json = (await res.json()) as BrokerServerTimeResponse
  const raw = json.brokerServerTime
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Broker server time response missing brokerServerTime')
  }
  return raw.trim()
}

/** Normalize broker ISO string to OHLC payload `to` / `from` shape (UTC, no sub-second). */
function brokerTimeToOhlcIso(brokerIso: string): string {
  const ms = Date.parse(brokerIso)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid brokerServerTime: ${brokerIso}`)
  }
  return new Date(ms).toISOString().slice(0, 19)
}

type MtOhlcRow = {
  time: string
  open: number
  high: number
  low: number
  close: number
}

type MtOhlcResponse = {
  data?: MtOhlcRow[]
}

async function fetchMtOhlcCandles(opts: {
  url: string
  account: number
  symbol: string
  fromIso: string
  toIso: string
  timeFrame: number
  signal?: AbortSignal
}): Promise<Candle[]> {
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account: opts.account,
      symbol: opts.symbol,
      from: opts.fromIso,
      to: opts.toIso,
      timeFrame: opts.timeFrame,
    }),
    credentials: 'omit',
    signal: opts.signal,
  })
  if (!res.ok) {
    throw new Error(`OHLC request failed (${res.status})`)
  }
  const json = (await res.json()) as MtOhlcResponse
  const rows = json.data ?? []
  const out: Candle[] = []
  for (const r of rows) {
    if (typeof r.time !== 'string') continue
    const ms = Date.parse(r.time)
    if (Number.isNaN(ms)) continue
    const t = Math.floor(ms / 1000)
    out.push({
      time: t,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    })
  }
  out.sort((a, b) => a.time - b.time)
  const dedup: Candle[] = []
  for (const c of out) {
    const prev = dedup[dedup.length - 1]
    if (prev && prev.time === c.time) dedup[dedup.length - 1] = c
    else dedup.push(c)
  }
  return dedup
}

/** MT-style price: main body + last fractional digit as superscript (2 dp). */
function formatMtPrice(value: number): { head: string; sup: string } {
  const [intPart, dec = ''] = value.toFixed(2).split('.')
  if (dec.length < 2) return { head: `${intPart}.${dec}`, sup: '' }
  return { head: `${intPart}.${dec[0]}`, sup: dec[1] }
}

/** Client-side trade id without `crypto.randomUUID` (non-secure origins / older runtimes). */
function createTradeId(): string {
  const t = Date.now().toString(36)
  const randHex = () =>
    Math.floor((1 + Math.random()) * 0x1000_0000)
      .toString(16)
      .slice(1)
  return `${t}-${randHex()}-${randHex()}`
}

/** Same synthetic half-spread as the order strip (mid ± half → bid / ask). */
function syntheticHalfSpread(mid: number): number {
  const tick = Math.max(mid * 0.00004, mid > 1000 ? 0.01 : 0.0001)
  return tick / 2
}

type ExitReason = 'TP' | 'SL'

/**
 * MT-style: longs are closed against **bid**; shorts against **ask**.
 * Uses the current 1m bar high/low so TP/SL can trigger inside the bar, not only on the close.
 * If both TP and SL trade through in the same update, **SL wins** (conservative / broker-like).
 * Used for breach detection / console logging only (positions are not auto-closed).
 */
function exitHitForTrade(
  t: { side: 'BUY' | 'SELL'; tpPrice: number | null; slPrice: number | null },
  bar: { high: number; low: number; close: number },
): ExitReason | null {
  const hasTp = t.tpPrice != null
  const hasSl = t.slPrice != null
  if (!hasTp && !hasSl) return null

  const half = syntheticHalfSpread(bar.close)
  const bidClose = bar.close - half
  const askClose = bar.close + half
  const { high, low } = bar
  const bestBid = Math.max(bidClose, high - half)
  const worstBid = Math.min(bidClose, low - half)
  const minAskDuringBar = Math.min(askClose, low + half)
  const maxAskDuringBar = Math.max(askClose, high + half)

  if (t.side === 'BUY') {
    const tp = hasTp && bestBid >= t.tpPrice!
    const sl = hasSl && worstBid <= t.slPrice!
    if (hasSl && hasTp && sl && tp) return 'SL'
    if (sl) return 'SL'
    if (tp) return 'TP'
    return null
  }
  const tp = hasTp && minAskDuringBar <= t.tpPrice!
  const sl = hasSl && maxAskDuringBar >= t.slPrice!
  if (hasSl && hasTp && sl && tp) return 'SL'
  if (sl) return 'SL'
  if (tp) return 'TP'
  return null
}

/** Default TP/SL vs entry (same ±0.5% as new orders in submitTrade). */
function defaultTpPrice(side: 'BUY' | 'SELL', entryPrice: number): number {
  return side === 'BUY' ? Number((entryPrice * 1.005).toFixed(2)) : Number((entryPrice * 0.995).toFixed(2))
}

function defaultSlPrice(side: 'BUY' | 'SELL', entryPrice: number): number {
  return side === 'BUY' ? Number((entryPrice * 0.995).toFixed(2)) : Number((entryPrice * 1.005).toFixed(2))
}

const HIDE_TP_SL_DRAG_HINT_KEY = 'trading-platform.hideTpSlDragHint'

function readHideTpSlDragHint(): boolean {
  try {
    return globalThis.localStorage?.getItem(HIDE_TP_SL_DRAG_HINT_KEY) === '1'
  } catch {
    return false
  }
}

function persistHideTpSlDragHint() {
  try {
    globalThis.localStorage?.setItem(HIDE_TP_SL_DRAG_HINT_KEY, '1')
  } catch {
    // private / blocked storage
  }
}

export function PlatformPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartGestureRootRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const pointerTapStartRef = useRef<{ x: number; y: number; t: number; id: number } | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const signalRConnRef = useRef<signalR.HubConnection | null>(null)
  const lastKlineBarRef = useRef<{ high: number; low: number; close: number } | null>(null)
  /** True after POST Manage/ohlc has populated the series (live ticks only extend/update after this). */
  const mtOhlcLoadedRef = useRef(false)
  const tickBarRef = useRef<Candle | null>(null)
  /** Last candle from Manage/ohlc: first stream ticks in the same bucket merge into it (preserve open). */
  const lastOhlcBarRef = useRef<Candle | null>(null)
  /** Latest exit-hit reason per trade (for logging only; no auto-close). */
  const lastExitHitReasonRef = useRef<Map<string, ExitReason | null>>(new Map())
  const priceLinesRef = useRef<
    Record<
      string,
      {
        entry?: IPriceLine
        tp?: IPriceLine
        sl?: IPriceLine
      }
    >
  >({})
  const draggingRef = useRef<null | { tradeId: string; kind: 'entry' | 'tp' | 'sl' }>(null)
  const tradeHistoryRef = useRef<
    Array<{
      id: string
      side: 'BUY' | 'SELL'
      symbol: string
      lotSize: number
      entryPrice: number
      tpPrice: number | null
      slPrice: number | null
      openedAtIso: string
    }>
  >([])
  const symbolRef = useRef<string>(DEFAULT_CHART_SYMBOL)
  const selectedTradeIdRef = useRef<string | null>(null)
  type PriceLineHitFn = (
    series: ISeriesApi<'Candlestick'>,
    y: number,
    hitPx: number,
  ) => { tradeId: string; kind: 'tp' | 'sl' | 'entry' } | null
  const findBestPriceLineHitRef = useRef<PriceLineHitFn>((_s, _y, _h) => null)

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [symbol, setSymbol] = useState(DEFAULT_CHART_SYMBOL)
  const interval = '1m' as const
  const [lotSize, setLotSize] = useState('0.01')
  const [tradeError, setTradeError] = useState<string | null>(null)
  const [showTradeForm, setShowTradeForm] = useState(true)
  const [latestPrice, setLatestPrice] = useState<number | null>(null)
  const [liveQuote, setLiveQuote] = useState<{ bid: number; ask: number } | null>(null)
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null)
  const [hideTpSlDragHint, setHideTpSlDragHint] = useState(readHideTpSlDragHint)
  const [platformTab, setPlatformTab] = useState<'chart' | 'history'>('chart')
  const [tradeHistory, setTradeHistory] = useState<
    Array<{
      id: string
      side: 'BUY' | 'SELL'
      symbol: string
      lotSize: number
      entryPrice: number
      tpPrice: number | null
      slPrice: number | null
      openedAtIso: string
    }>
  >([])
  const [lastTrade, setLastTrade] = useState<{
    side: 'BUY' | 'SELL'
    symbol: string
    lotSize: number
    atIso: string
  } | null>(null)

  const sampleCandles = useMemo(() => generateSampleCandles(), [])

  const selectedTrade = useMemo(
    () => (selectedTradeId ? (tradeHistory.find((t) => t.id === selectedTradeId) ?? null) : null),
    [tradeHistory, selectedTradeId],
  )

  const setChartDraggingEnabled = (enabled: boolean) => {
    const chart = chartRef.current
    if (!chart) return
    chart.applyOptions({
      handleScroll: {
        pressedMouseMove: enabled,
        horzTouchDrag: enabled,
        vertTouchDrag: enabled,
        mouseWheel: enabled,
      },
      handleScale: {
        axisPressedMouseMove: enabled,
        pinch: enabled,
        mouseWheel: enabled,
      },
    })
  }

  /** Closest TP / SL / entry line within hit radius (chart Y coordinate). */
  const findBestPriceLineHit = (
    series: ISeriesApi<'Candlestick'>,
    y: number,
    hitPx: number,
  ): { tradeId: string; kind: 'tp' | 'sl' | 'entry' } | null => {
    let best: { tradeId: string; kind: 'tp' | 'sl' | 'entry'; dist: number } | null = null
    const sym = symbolRef.current
    for (const t of tradeHistoryRef.current) {
      if (t.symbol !== sym) continue
      const tpY = t.tpPrice != null ? series.priceToCoordinate(t.tpPrice) : null
      const slY = t.slPrice != null ? series.priceToCoordinate(t.slPrice) : null
      const entryY = series.priceToCoordinate(t.entryPrice)
      if (tpY != null && t.tpPrice != null) {
        const d = Math.abs(tpY - y)
        if (d <= hitPx && (!best || d < best.dist)) best = { tradeId: t.id, kind: 'tp', dist: d }
      }
      if (slY != null && t.slPrice != null) {
        const d = Math.abs(slY - y)
        if (d <= hitPx && (!best || d < best.dist)) best = { tradeId: t.id, kind: 'sl', dist: d }
      }
      if (entryY != null) {
        const d = Math.abs(entryY - y)
        if (d <= hitPx && (!best || d < best.dist)) best = { tradeId: t.id, kind: 'entry', dist: d }
      }
    }
    if (!best) return null
    return { tradeId: best.tradeId, kind: best.kind }
  }

  findBestPriceLineHitRef.current = findBestPriceLineHit

  /** Selected trade: bold, saturated lines. Others: muted. */
  const syncTradeLineVisuals = (selectedId: string | null) => {
    const series = seriesRef.current
    for (const [tradeId, lines] of Object.entries(priceLinesRef.current)) {
      const t = tradeHistoryRef.current.find((x) => x.id === tradeId)
      if (!t) continue

      if (series) {
        if (t.tpPrice == null && lines.tp) {
          removeSeriesPriceLine(series, lines.tp)
          delete lines.tp
        }
        if (t.slPrice == null && lines.sl) {
          removeSeriesPriceLine(series, lines.sl)
          delete lines.sl
        }
      }

      const sel = tradeId === selectedId

      const entryBuy = 'rgba(16,185,129,1)'
      const entrySell = 'rgba(239,68,68,1)'
      const entryBuyDim = 'rgba(16,185,129,0.38)'
      const entrySellDim = 'rgba(239,68,68,0.38)'

      const entryColor = t.side === 'BUY' ? (sel ? entryBuy : entryBuyDim) : sel ? entrySell : entrySellDim
      lines.entry?.applyOptions?.({
        color: entryColor,
        lineWidth: sel ? 3 : 2,
        lineStyle: 0,
      })
      lines.tp?.applyOptions?.({
        color: sel ? 'rgba(5,150,105,1)' : 'rgba(16,185,129,0.42)',
        lineWidth: sel ? 3 : 2,
        lineStyle: 2,
      })
      lines.sl?.applyOptions?.({
        color: sel ? 'rgba(220,38,38,1)' : 'rgba(239,68,68,0.42)',
        lineWidth: sel ? 3 : 2,
        lineStyle: 2,
      })
    }
  }

  useEffect(() => {
    tradeHistoryRef.current = tradeHistory
  }, [tradeHistory])

  useEffect(() => {
    symbolRef.current = symbol
  }, [symbol])

  useEffect(() => {
    syncTradeLineVisuals(selectedTradeId)
    setChartDraggingEnabled(!selectedTradeId)
    selectedTradeIdRef.current = selectedTradeId
  }, [selectedTradeId, tradeHistory])

  useEffect(() => {
    if (platformTab !== 'chart') return
    const chart = chartRef.current
    const el = containerRef.current
    if (!chart || !el) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w > 0 && h > 0) {
      chart.applyOptions({ width: w, height: h })
    }
  }, [platformTab])

  /** Mobile: canvas rarely emits click; use capture pointer tap to select lines (when chart is not in overlay mode). */
  useEffect(() => {
    const root = chartGestureRootRef.current
    if (!root) return

    const TAP_TIME_MS = 450
    const TAP_MOVE_PX = 24
    const HIT_TOUCH_PX = 28

    const onPointerDownCapture = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (selectedTradeIdRef.current) return
      pointerTapStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
        id: e.pointerId,
      }
    }

    const onPointerUpCapture = (e: PointerEvent) => {
      const start = pointerTapStartRef.current
      pointerTapStartRef.current = null
      if (selectedTradeIdRef.current) return
      if (!start || e.pointerId !== start.id) return
      if (performance.now() - start.t > TAP_TIME_MS) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (Math.hypot(dx, dy) > TAP_MOVE_PX) return

      const series = seriesRef.current
      const container = containerRef.current
      if (!series || !container) return
      const rect = container.getBoundingClientRect()
      const y = e.clientY - rect.top
      if (series.coordinateToPrice(y) == null) return
      const hit = findBestPriceLineHitRef.current(series, y, HIT_TOUCH_PX)
      setSelectedTradeId(hit ? hit.tradeId : null)
    }

    root.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
    root.addEventListener('pointerup', onPointerUpCapture, { capture: true })
    root.addEventListener('pointercancel', onPointerUpCapture, { capture: true })
    return () => {
      root.removeEventListener('pointerdown', onPointerDownCapture, { capture: true })
      root.removeEventListener('pointerup', onPointerUpCapture, { capture: true })
      root.removeEventListener('pointercancel', onPointerUpCapture, { capture: true })
    }
  }, [])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    const prevTouchAction = document.body.style.touchAction
    const prevOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'manipulation'
    document.body.style.overscrollBehavior = 'none'
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.touchAction = prevTouchAction
      document.body.style.overscrollBehavior = prevOverscroll
    }
  }, [])

  useDrag(
    ({ first, last, active, event }) => {
      const overlay = overlayRef.current
      const series = seriesRef.current
      if (!overlay || !series) return

      const rect = overlay.getBoundingClientRect()
      const ev = event as PointerEvent | MouseEvent | TouchEvent
      let clientY: number | undefined
      let pointerType: string | undefined
      if ('clientY' in ev && typeof ev.clientY === 'number') {
        clientY = ev.clientY
        pointerType = (ev as PointerEvent).pointerType
      } else if ('touches' in ev && ev.touches.length > 0) {
        clientY = ev.touches[0].clientY
        pointerType = 'touch'
      }
      if (clientY === undefined) return
      const y = clientY - rect.top

      const HIT_PX = pointerType === 'touch' ? 28 : 16

      if (last) {
        draggingRef.current = null
        return
      }

      if (first) {
        if (series.coordinateToPrice(y) == null) return

        const hit = findBestPriceLineHitRef.current(series, y, HIT_PX)
        if (!hit) {
          setSelectedTradeId(null)
          draggingRef.current = null
          return
        }

        setSelectedTradeId(hit.tradeId)
        draggingRef.current = { tradeId: hit.tradeId, kind: hit.kind }
        return
      }

      if (!active || !draggingRef.current) return

      const nextPrice = series.coordinateToPrice(y)
      if (nextPrice == null) return

      const drag = draggingRef.current
      setTradeHistory((prev) => {
        const targetTrade = prev.find((t) => t.id === drag.tradeId)
        if (!targetTrade) return prev

        const next = prev.map((t) => {
          if (t.id !== drag.tradeId) return t
          if (drag.kind === 'tp') return { ...t, tpPrice: nextPrice }
          if (drag.kind === 'sl') return { ...t, slPrice: nextPrice }
          const isTpDrag =
            t.side === 'BUY' ? nextPrice >= t.entryPrice : nextPrice <= t.entryPrice
          return isTpDrag ? { ...t, tpPrice: nextPrice } : { ...t, slPrice: nextPrice }
        })

        const lines = priceLinesRef.current[drag.tradeId]
        const updated = next.find((t) => t.id === drag.tradeId)
        if (updated && lines && series) {
          const tpOpts = {
            title: 'TP (drag)',
            color: 'rgba(16,185,129,0.6)',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
          } as const
          const slOpts = {
            title: 'SL (drag)',
            color: 'rgba(239,68,68,0.6)',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
          } as const

          if (drag.kind === 'tp' && updated.tpPrice != null) {
            if (lines.tp) lines.tp.applyOptions({ price: updated.tpPrice })
            else lines.tp = series.createPriceLine({ price: updated.tpPrice, ...tpOpts })
          } else if (drag.kind === 'sl' && updated.slPrice != null) {
            if (lines.sl) lines.sl.applyOptions({ price: updated.slPrice })
            else lines.sl = series.createPriceLine({ price: updated.slPrice, ...slOpts })
          } else if (drag.kind === 'entry') {
            const isTpDrag =
              updated.side === 'BUY'
                ? nextPrice >= updated.entryPrice
                : nextPrice <= updated.entryPrice
            if (isTpDrag && updated.tpPrice != null) {
              if (lines.tp) lines.tp.applyOptions({ price: updated.tpPrice })
              else lines.tp = series.createPriceLine({ price: updated.tpPrice, ...tpOpts })
            } else if (!isTpDrag && updated.slPrice != null) {
              if (lines.sl) lines.sl.applyOptions({ price: updated.slPrice })
              else lines.sl = series.createPriceLine({ price: updated.slPrice, ...slOpts })
            }
          }
        }
        return next
      })
    },
    {
      target: overlayRef,
      enabled: Boolean(selectedTradeId),
      eventOptions: { passive: false },
      drag: {
        filterTaps: true,
        threshold: 0,
      },
      pointer: { touch: true },
    },
  )

  useEffect(() => {
    async function init() {
      try {
        if (!containerRef.current) return

        const chart = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
          layout: { background: { color: '#ffffff' }, textColor: '#111827' },
          grid: {
            vertLines: { color: '#e5e7eb' },
            horzLines: { color: '#e5e7eb' },
          },
          rightPriceScale: { borderColor: '#e5e7eb' },
          timeScale: { borderColor: '#e5e7eb' },
          crosshair: { mode: CrosshairMode.Normal },
        })

        const series = chart.addSeries(CandlestickSeries)
        chartRef.current = chart
        seriesRef.current = series

        const onResize = () => {
          if (!containerRef.current) return
          chart.applyOptions({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
          })
        }

        window.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('resize', onResize)
          chart.remove()
          chartRef.current = null
          seriesRef.current = null
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        setError(message)
      }
    }

    let cleanup: undefined | (() => void)
    init().then((c) => {
      cleanup = c
    })

    return () => {
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    if (!USE_SIGNALR_STREAM) {
      const controller = new AbortController()
      setLoading(true)
      setError(null)

      async function load() {
        try {
          const data = await fetchBinanceCandles({
            symbol,
            interval,
            limit: 500,
            signal: controller.signal,
          })

          const series = seriesRef.current
          const chart = chartRef.current
          if (series && chart) {
            series.setData(
              data.map((c) => ({
                ...c,
                time: c.time as UTCTimestamp,
              })),
            )
            chart.timeScale().fitContent()
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error'
          setError(
            `${message}. Falling back to sample data (your network may be blocking the exchange API).`,
          )

          const series = seriesRef.current
          const chart = chartRef.current
          if (series && chart) {
            series.setData(
              sampleCandles.map((c) => ({
                ...c,
                time: c.time as UTCTimestamp,
              })),
            )
            chart.timeScale().fitContent()
          }
        } finally {
          setLoading(false)
        }
      }

      load()
      return () => controller.abort()
    }

    const controller = new AbortController()
    mtOhlcLoadedRef.current = false
    lastOhlcBarRef.current = null
    setLoading(true)
    setError(null)

    if (!OHLC_API_URL) {
      setError('Configure VITE_SIGNALR_URL or VITE_OHLC_URL to load MT history.')
      setLoading(false)
      const series = seriesRef.current
      if (series) series.setData([])
      return () => controller.abort()
    }

    async function loadMtOhlc() {
      try {
        const manageOrigin = manageOriginFromOhlcUrl(OHLC_API_URL)
        if (!manageOrigin) {
          throw new Error('Invalid OHLC URL (cannot resolve API origin)')
        }

        const brokerRaw = await fetchBrokerServerTime({
          manageOrigin,
          terminalType: BROKER_TERMINAL_TYPE,
          accountNumber: SIGNALR_ACCOUNT,
          signal: controller.signal,
        })
        const toIso = brokerTimeToOhlcIso(brokerRaw)

        const toMs = Date.parse(`${toIso}Z`)
        if (Number.isNaN(toMs)) {
          throw new Error('Invalid OHLC `to` timestamp')
        }
        const fromIso = new Date(toMs - OHLC_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 19)
        const sym = symbol.trim().toUpperCase()

        const data = await fetchMtOhlcCandles({
          url: OHLC_API_URL,
          account: SIGNALR_ACCOUNT,
          symbol: sym,
          fromIso,
          toIso,
          timeFrame: OHLC_TIMEFRAME,
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        const series = seriesRef.current
        const chart = chartRef.current
        if (series && chart) {
          if (data.length === 0) {
            series.setData([])
            setError('No OHLC rows returned for this range.')
            mtOhlcLoadedRef.current = false
            lastOhlcBarRef.current = null
          } else {
            series.setData(
              data.map((c) => ({
                ...c,
                time: c.time as UTCTimestamp,
              })),
            )
            chart.timeScale().fitContent()
            mtOhlcLoadedRef.current = true
            const last = data[data.length - 1]
            lastOhlcBarRef.current = { ...last }
            lastKlineBarRef.current = {
              high: last.high,
              low: last.low,
              close: last.close,
            }
            tickBarRef.current = null
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return
        const message = e instanceof Error ? e.message : 'Unknown error'
        setError(message)
        mtOhlcLoadedRef.current = false
        lastOhlcBarRef.current = null
        const series = seriesRef.current
        if (series) series.setData([])
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void loadMtOhlc()
    return () => {
      controller.abort()
      mtOhlcLoadedRef.current = false
      lastOhlcBarRef.current = null
    }
  }, [sampleCandles, symbol])

  useEffect(() => {
    if (USE_SIGNALR_STREAM) return

    const series = seriesRef.current
    if (!series) return

    // close any existing socket when symbol changes
    wsRef.current?.close()
    wsRef.current = null

    const stream = `${symbol.toLowerCase()}@kline_1m`
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`)
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as BinanceWsKlineEvent
        if (!msg?.k?.t) return

        const candle = {
          time: Math.floor(msg.k.t / 1000) as UTCTimestamp,
          open: Number(msg.k.o),
          high: Number(msg.k.h),
          low: Number(msg.k.l),
          close: Number(msg.k.c),
        }

        series.update(candle)
        lastKlineBarRef.current = {
          high: candle.high,
          low: candle.low,
          close: candle.close,
        }
        setLatestPrice(candle.close)
      } catch {
        // ignore malformed messages
      }
    }

    ws.onerror = () => {
      setError((prev) => prev ?? 'WebSocket error while streaming 1m candles.')
    }

    return () => {
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [symbol])

  useEffect(() => {
    if (!USE_SIGNALR_STREAM || !SIGNALR_URL) return

    let cancelled = false

    const hub = new signalR.HubConnectionBuilder()
      .withUrl(SIGNALR_URL, {
        // `true` + `Allow-Origin: *` fails CORS; use `true` only with explicit origins on the API.
        withCredentials: false,
      })
      .withAutomaticReconnect()
      .build()

    const subscribeQuotes = () =>
      hub.invoke('Server', {
        name: 'subscribeToQuote',
        message: JSON.stringify({
          terminal: SIGNALR_TERMINAL,
          account: SIGNALR_ACCOUNT,
          symbol: symbolRef.current,
        }),
      })

    const onServer = (envelope: { name?: string; message?: string }) => {
      if (!envelope || envelope.name !== 'quote') return
      let data: {
        terminal?: string
        account?: number
        symbol?: string
        bid?: number
        ask?: number
        timeIso?: string
      }
      try {
        data = JSON.parse(envelope.message ?? '{}')
      } catch {
        return
      }
      if (typeof data.symbol !== 'string') return
      if (data.symbol.trim().toUpperCase() !== symbolRef.current.trim().toUpperCase()) return
      if (typeof data.bid !== 'number' || typeof data.ask !== 'number') return

      const seriesNow = seriesRef.current
      if (!seriesNow || cancelled) return

      const timeMs = data.timeIso ? Date.parse(data.timeIso) : Date.now()
      if (Number.isNaN(timeMs)) return

      const barDurSec = OHLC_TIMEFRAME * 60
      const barTimeSec = Math.floor(timeMs / 1000 / barDurSec) * barDurSec
      const mid = (data.bid + data.ask) / 2

      setLiveQuote({ bid: data.bid, ask: data.ask })
      setLatestPrice(mid)

      if (!mtOhlcLoadedRef.current) return

      let bar = tickBarRef.current
      const histTail = lastOhlcBarRef.current
      if (!bar || bar.time !== barTimeSec) {
        if (histTail && histTail.time === barTimeSec) {
          bar = {
            time: barTimeSec,
            open: histTail.open,
            high: Math.max(histTail.high, data.ask, mid),
            low: Math.min(histTail.low, data.bid, mid),
            close: mid,
          }
          lastOhlcBarRef.current = null
        } else {
          bar = {
            time: barTimeSec,
            open: mid,
            high: Math.max(mid, data.ask),
            low: Math.min(mid, data.bid),
            close: mid,
          }
        }
      } else {
        bar = {
          time: bar.time,
          open: bar.open,
          high: Math.max(bar.high, data.ask, mid),
          low: Math.min(bar.low, data.bid, mid),
          close: mid,
        }
      }
      tickBarRef.current = bar
      seriesNow.update({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })
      lastKlineBarRef.current = {
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }
    }

    hub.on('Server', onServer)
    hub.onreconnected(() => {
      void subscribeQuotes().catch(() => {})
    })

    void (async () => {
      try {
        await hub.start()
        if (cancelled) {
          await hub.stop()
          return
        }
        signalRConnRef.current = hub
        await subscribeQuotes()
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'SignalR connection failed'
          setError((prev) => prev ?? msg)
        }
      }
    })()

    return () => {
      cancelled = true
      signalRConnRef.current = null
      tickBarRef.current = null
      setLiveQuote(null)
      hub.off('Server', onServer)
      void hub.stop()
      const s = seriesRef.current
      if (s) s.setData([])
    }
  }, [symbol])

  /** Log when bid/ask hits TP or SL; trades stay open (no removal). */
  useEffect(() => {
    if (latestPrice == null) return
    const bar =
      lastKlineBarRef.current ?? {
        high: latestPrice,
        low: latestPrice,
        close: latestPrice,
      }
    const sym = symbolRef.current
    const activeIds = new Set(tradeHistoryRef.current.map((t) => t.id))
    for (const id of lastExitHitReasonRef.current.keys()) {
      if (!activeIds.has(id)) lastExitHitReasonRef.current.delete(id)
    }

    for (const t of tradeHistoryRef.current) {
      if (t.symbol !== sym) continue
      const reason = exitHitForTrade(t, bar)
      const prev = lastExitHitReasonRef.current.get(t.id) ?? null
      if (reason != null && reason !== prev) {
        console.log('[TP_SL_HIT]', {
          kind: reason,
          tradeId: t.id,
          symbol: t.symbol,
          side: t.side,
          tpPrice: t.tpPrice,
          slPrice: t.slPrice,
          barClose: bar.close,
        })
      }
      lastExitHitReasonRef.current.set(t.id, reason)
    }
  }, [latestPrice, symbol, tradeHistory])

  const submitTrade = (side: 'BUY' | 'SELL') => {
    setTradeError(null)
    const parsed = Number(lotSize)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setTradeError('Lot size must be a positive number.')
      return
    }

    if (!latestPrice) {
      setTradeError('Live price not ready yet. Wait a moment for the stream to connect.')
      return
    }

    const trade = {
      side,
      symbol,
      lotSize: parsed,
      atIso: new Date().toISOString(),
    }

    setLastTrade(trade)

    const entryPrice = latestPrice
    const tpPrice = defaultTpPrice(side, entryPrice)
    const slPrice = defaultSlPrice(side, entryPrice)

    const historyItem = {
      id: createTradeId(),
      side,
      symbol,
      lotSize: parsed,
      entryPrice,
      tpPrice,
      slPrice,
      openedAtIso: trade.atIso,
    }
    setTradeHistory((prev) => {
      const next = [historyItem, ...prev]
      tradeHistoryRef.current = next
      return next
    })

    const series = seriesRef.current
    if (series) {
      const existing = priceLinesRef.current[historyItem.id]
      if (existing?.entry) removeSeriesPriceLine(series, existing.entry)
      if (existing?.tp) removeSeriesPriceLine(series, existing.tp)
      if (existing?.sl) removeSeriesPriceLine(series, existing.sl)

      const entryLine = series.createPriceLine({
        price: entryPrice,
        title: `${side} entry`,
        color: side === 'BUY' ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
      })
      const tpLine = series.createPriceLine({
        price: tpPrice,
        title: 'TP (drag)',
        color: 'rgba(16,185,129,0.6)',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
      })
      const slLine = series.createPriceLine({
        price: slPrice,
        title: 'SL (drag)',
        color: 'rgba(239,68,68,0.6)',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
      })

      priceLinesRef.current[historyItem.id] = { entry: entryLine, tp: tpLine, sl: slLine }
    }
    syncTradeLineVisuals(selectedTradeId)
    // placeholder until a real trading API is wired
    console.log('OPEN_TRADE', trade)
  }

  const removeTradeTp = (tradeId: string) => {
    setTradeHistory((prev) => {
      const next = prev.map((t) => (t.id === tradeId ? { ...t, tpPrice: null } : t))
      tradeHistoryRef.current = next
      return next
    })
    const series = seriesRef.current
    const lines = priceLinesRef.current[tradeId]
    if (series && lines?.tp) {
      removeSeriesPriceLine(series, lines.tp)
      delete lines.tp
    }
    syncTradeLineVisuals(selectedTradeIdRef.current)
  }

  const removeTradeSl = (tradeId: string) => {
    setTradeHistory((prev) => {
      const next = prev.map((t) => (t.id === tradeId ? { ...t, slPrice: null } : t))
      tradeHistoryRef.current = next
      return next
    })
    const series = seriesRef.current
    const lines = priceLinesRef.current[tradeId]
    if (series && lines?.sl) {
      removeSeriesPriceLine(series, lines.sl)
      delete lines.sl
    }
    syncTradeLineVisuals(selectedTradeIdRef.current)
  }

  const addTradeTp = (tradeId: string) => {
    const series = seriesRef.current
    if (!series) return
    const t = tradeHistoryRef.current.find((x) => x.id === tradeId)
    if (!t || t.tpPrice != null) return
    const tpPrice = defaultTpPrice(t.side, t.entryPrice)
    setTradeHistory((prev) => {
      const next = prev.map((x) => (x.id === tradeId ? { ...x, tpPrice } : x))
      tradeHistoryRef.current = next
      return next
    })
    const lines = priceLinesRef.current[tradeId]
    if (lines?.tp) {
      lines.tp.applyOptions({ price: tpPrice })
    } else if (lines) {
      lines.tp = series.createPriceLine({
        price: tpPrice,
        title: 'TP (drag)',
        color: 'rgba(16,185,129,0.6)',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
      })
    }
    syncTradeLineVisuals(selectedTradeIdRef.current)
  }

  const addTradeSl = (tradeId: string) => {
    const series = seriesRef.current
    if (!series) return
    const t = tradeHistoryRef.current.find((x) => x.id === tradeId)
    if (!t || t.slPrice != null) return
    const slPrice = defaultSlPrice(t.side, t.entryPrice)
    setTradeHistory((prev) => {
      const next = prev.map((x) => (x.id === tradeId ? { ...x, slPrice } : x))
      tradeHistoryRef.current = next
      return next
    })
    const lines = priceLinesRef.current[tradeId]
    if (lines?.sl) {
      lines.sl.applyOptions({ price: slPrice })
    } else if (lines) {
      lines.sl = series.createPriceLine({
        price: slPrice,
        title: 'SL (drag)',
        color: 'rgba(239,68,68,0.6)',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
      })
    }
    syncTradeLineVisuals(selectedTradeIdRef.current)
  }

  const adjustLot = (delta: number) => {
    setTradeError(null)
    setLotSize((prev) => {
      const n = Number(prev)
      const base = Number.isFinite(n) && n > 0 ? n : 0.01
      const next = Math.max(0.0001, Math.round((base + delta) * 10_000) / 10_000)
      return String(next)
    })
  }

  const streamSpread =
    liveQuote != null && liveQuote.ask >= liveQuote.bid ? liveQuote.ask - liveQuote.bid : null
  const tickSize =
    streamSpread != null && streamSpread > 0
      ? streamSpread
      : latestPrice != null
        ? syntheticHalfSpread(latestPrice) * 2
        : 0
  const sellPx =
    liveQuote?.bid ?? (latestPrice != null && tickSize > 0 ? latestPrice - tickSize / 2 : null)
  const buyPx =
    liveQuote?.ask ?? (latestPrice != null && tickSize > 0 ? latestPrice + tickSize / 2 : null)
  const sellFmt = sellPx != null ? formatMtPrice(sellPx) : { head: '—', sup: '' as string }
  const buyFmt = buyPx != null ? formatMtPrice(buyPx) : { head: '—', sup: '' as string }

  const mtSellBg = '#b71c1c'
  const mtBuyBg = '#1565c0'
  const mtBarBtn = {
    flex: 1,
    minWidth: 0,
    border: 'none',
    cursor: 'pointer',
    padding: '6px 8px 8px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    justifyContent: 'center',
    color: '#fff',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overscrollBehavior: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: '#0d0d0d',
      }}
    >
      {showTradeForm && platformTab === 'chart' ? (
        <div style={{ flexShrink: 0, zIndex: 1200 }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'stretch',
              borderBottom: '1px solid #1f1f1f',
            }}
          >
            <button
              type="button"
              onClick={() => submitTrade('SELL')}
              style={{ ...mtBarBtn, background: mtSellBg, padding: '10px 10px 12px' }}
            >
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.6, opacity: 0.95 }}>SELL</span>
              <span style={{ fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>
                <span style={{ fontSize: 22 }}>{sellFmt.head}</span>
                {sellFmt.sup ? (
                  <sup style={{ fontSize: 13, fontWeight: 700, marginLeft: 1 }}>{sellFmt.sup}</sup>
                ) : null}
              </span>
            </button>
            <div
              className="flex w-[min(42vw,158px)] shrink-0 flex-col justify-center gap-1.5 border-x border-neutral-800 bg-[#050505] px-2.5 py-2"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {/* <div className="text-center">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                  Lot size
                </span>
              </div> */}
              <div className="flex min-h-[40px] items-center gap-0.5 rounded-lg border border-neutral-800/90 bg-gradient-to-b from-neutral-900/50 to-neutral-950 px-0.5 py-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-[box-shadow,border-color] focus-within:border-sky-600/45 focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(14,165,233,0.22)]">
                <button
                  type="button"
                  aria-label="Decrease lot by 0.01"
                  onClick={() => adjustLot(-0.01)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-800/90 hover:text-white active:scale-[0.94] active:bg-neutral-800"
                  style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M6 10l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <input
                  aria-label="Lot size"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={lotSize}
                  onChange={(e) => {
                    setTradeError(null)
                    setLotSize(e.target.value)
                  }}
                  onBlur={() => {
                    const n = Number(lotSize)
                    if (!Number.isFinite(n) || n <= 0) {
                      setLotSize('0.01')
                    } else {
                      setLotSize(String(Math.round(n * 10_000) / 10_000))
                    }
                  }}
                  className="min-w-0 flex-1 border-0 bg-transparent py-1 text-center text-[17px] font-semibold tabular-nums text-neutral-100 caret-sky-400 outline-none ring-0 placeholder:text-neutral-600"
                />
                <button
                  type="button"
                  aria-label="Increase lot by 0.01"
                  onClick={() => adjustLot(0.01)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-800/90 hover:text-white active:scale-[0.94] active:bg-neutral-800"
                  style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M18 14l-6-6-6 6"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              {/* <div className="grid grid-cols-4 gap-1">
                {(
                  [
                    { label: '−0.1', delta: -0.1 },
                    { label: '−0.01', delta: -0.01 },
                    { label: '+0.01', delta: 0.01 },
                    { label: '+0.1', delta: 0.1 },
                  ] as const
                ).map(({ label, delta }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => adjustLot(delta)}
                    className="rounded-md border border-neutral-700/55 bg-neutral-900/80 py-1 text-[10px] font-semibold tabular-nums text-neutral-400 transition hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-200 active:scale-[0.96]"
                    style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                  >
                    {label}
                  </button>
                ))}
              </div> */}
              {/* <div className="truncate text-center text-[10px] font-medium tracking-tight text-neutral-600">
                {symbol}
              </div> */}
            </div>
            <button
              type="button"
              onClick={() => submitTrade('BUY')}
              style={{ ...mtBarBtn, background: mtBuyBg, padding: '10px 10px 12px' }}
            >
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.6, opacity: 0.95 }}>BUY</span>
              <span style={{ fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>
                <span style={{ fontSize: 22 }}>{buyFmt.head}</span>
                {buyFmt.sup ? (
                  <sup style={{ fontSize: 13, fontWeight: 700, marginLeft: 1 }}>{buyFmt.sup}</sup>
                ) : null}
              </span>
            </button>
          </div>
          {tradeError ? (
            <div
              style={{
                padding: '6px 10px',
                fontSize: 12,
                color: '#fecaca',
                background: '#2d1212',
                borderBottom: '1px solid #1f1f1f',
              }}
            >
              {tradeError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          padding: '8px 10px',
          background: '#1a1a1a',
          borderBottom: '1px solid #2a2a2a',
          zIndex: 1100,
        }}
      >
        <strong style={{ color: '#e5e5e5', fontSize: 13 }}>Platform</strong>
        <label style={{ color: '#a3a3a3', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          Symbol
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
            placeholder={USE_SIGNALR_STREAM ? 'XAUUSD' : 'BTCUSDT'}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid #404040',
              outline: 'none',
              background: '#0d0d0d',
              color: '#fafafa',
              width: 110,
              fontSize: 12,
            }}
          />
        </label>
        <span style={{ color: '#a3a3a3', fontSize: 12 }}>
          Interval <strong style={{ color: '#e5e5e5' }}>1m</strong>
        </span>
        {loading ? <span style={{ color: '#a3a3a3', fontSize: 12 }}>Loading…</span> : null}
        <button
          type="button"
          onClick={() => setShowTradeForm((v) => !v)}
          style={{
            marginLeft: 'auto',
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #404040',
            background: '#262626',
            color: '#e5e5e5',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {showTradeForm ? 'Hide order strip' : 'Show order strip'}
        </button>
        {!showTradeForm && tradeError ? (
          <span style={{ color: '#f87171', fontSize: 12, width: '100%' }}>{tradeError}</span>
        ) : null}
      </div> */}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            visibility: platformTab === 'chart' ? 'visible' : 'hidden',
            pointerEvents: platformTab === 'chart' ? 'auto' : 'none',
          }}
        >
          <div
            ref={chartGestureRootRef}
            style={{
              position: 'absolute',
              inset: 0,
              touchAction: 'none',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }}
          >
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        <div
          ref={overlayRef}
          aria-hidden={!selectedTradeId}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 5,
            pointerEvents: selectedTradeId ? 'auto' : 'none',
            touchAction: 'none',
            WebkitTapHighlightColor: 'transparent',
            background: 'transparent',
          }}
        />
        {selectedTradeId ? (
          hideTpSlDragHint ? (
            <></>
            // <div
            //   style={{
            //     position: 'absolute',
            //     right: 12,
            //     top: 10,
            //     zIndex: 1100,
            //     pointerEvents: 'auto',
            //     display: 'flex',
            //     flexDirection: 'column',
            //     alignItems: 'flex-end',
            //     gap: 8,
            //   }}
            // >
            //   <div
            //     style={{
            //       display: 'flex',
            //       flexWrap: 'wrap',
            //       gap: 6,
            //       justifyContent: 'flex-end',
            //       maxWidth: 'min(280px, 100%)',
            //     }}
            //   >
            //     <button
            //       type="button"
            //       disabled={!selectedTrade || selectedTrade.tpPrice != null}
            //       onClick={() => selectedTradeId && addTradeTp(selectedTradeId)}
            //       style={{
            //         padding: '6px 10px',
            //         borderRadius: 8,
            //         fontSize: 11,
            //         fontWeight: 600,
            //         cursor:
            //           !selectedTrade || selectedTrade.tpPrice != null ? 'not-allowed' : 'pointer',
            //         border: '1px solid #14532d',
            //         background: '#052e16',
            //         color: '#bbf7d0',
            //         opacity: !selectedTrade || selectedTrade.tpPrice != null ? 0.4 : 1,
            //         WebkitTapHighlightColor: 'transparent',
            //       }}
            //     >
            //       Add TP
            //     </button>
            //     <button
            //       type="button"
            //       disabled={!selectedTrade || selectedTrade.tpPrice == null}
            //       onClick={() => selectedTradeId && removeTradeTp(selectedTradeId)}
            //       style={{
            //         padding: '6px 10px',
            //         borderRadius: 8,
            //         fontSize: 11,
            //         fontWeight: 600,
            //         cursor:
            //           !selectedTrade || selectedTrade.tpPrice == null ? 'not-allowed' : 'pointer',
            //         border: '1px solid #3f6212',
            //         background: '#1a2e05',
            //         color: '#d9f99d',
            //         opacity: !selectedTrade || selectedTrade.tpPrice == null ? 0.4 : 1,
            //         WebkitTapHighlightColor: 'transparent',
            //       }}
            //     >
            //       Remove TP
            //     </button>
            //     <button
            //       type="button"
            //       disabled={!selectedTrade || selectedTrade.slPrice != null}
            //       onClick={() => selectedTradeId && addTradeSl(selectedTradeId)}
            //       style={{
            //         padding: '6px 10px',
            //         borderRadius: 8,
            //         fontSize: 11,
            //         fontWeight: 600,
            //         cursor:
            //           !selectedTrade || selectedTrade.slPrice != null ? 'not-allowed' : 'pointer',
            //         border: '1px solid #991b1b',
            //         background: '#450a0a',
            //         color: '#fecaca',
            //         opacity: !selectedTrade || selectedTrade.slPrice != null ? 0.4 : 1,
            //         WebkitTapHighlightColor: 'transparent',
            //       }}
            //     >
            //       Add SL
            //     </button>
            //     <button
            //       type="button"
            //       disabled={!selectedTrade || selectedTrade.slPrice == null}
            //       onClick={() => selectedTradeId && removeTradeSl(selectedTradeId)}
            //       style={{
            //         padding: '6px 10px',
            //         borderRadius: 8,
            //         fontSize: 11,
            //         fontWeight: 600,
            //         cursor:
            //           !selectedTrade || selectedTrade.slPrice == null ? 'not-allowed' : 'pointer',
            //         border: '1px solid #7f1d1d',
            //         background: '#2d1212',
            //         color: '#fecaca',
            //         opacity: !selectedTrade || selectedTrade.slPrice == null ? 0.4 : 1,
            //         WebkitTapHighlightColor: 'transparent',
            //       }}
            //     >
            //       Remove SL
            //     </button>
            //   </div>
            //   <button
            //     type="button"
            //     onClick={() => setSelectedTradeId(null)}
            //     style={{
            //       padding: '8px 14px',
            //       borderRadius: 10,
            //       border: '1px solid #404040',
            //       background: 'rgba(23,23,23,0.96)',
            //       color: '#fafafa',
            //       fontWeight: 600,
            //       fontSize: 12,
            //       cursor: 'pointer',
            //       boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
            //       WebkitTapHighlightColor: 'transparent',
            //     }}
            //   >
            //     Done
            //   </button>
            // </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              style={{
                position: 'absolute',
                left: '50%',
                top: 10,
                transform: 'translateX(-50%)',
                zIndex: 1100,
                maxWidth: 'min(520px, calc(100% - 24px))',
                padding: '10px 14px',
                borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(30,64,175,0.97) 0%, rgba(67,56,202,0.95) 100%)',
                color: '#f8fafc',
                boxShadow: '0 12px 28px rgba(30,58,138,0.35)',
                border: '1px solid rgba(255,255,255,0.2)',
                pointerEvents: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.02, marginBottom: 4 }}>
                    Chart paused for TP & SL
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.95 }}>
                    Pan and zoom are off so you can drag precisely. The active trade uses{' '}
                    <strong>brighter</strong> lines; other trades stay muted.{' '}
                    <strong style={{ color: '#bbf7d0' }}>Green</strong> = take profit,{' '}
                    <strong style={{ color: '#fecaca' }}>red</strong> = stop loss. Drag the TP/SL lines, or drag from{' '}
                    <strong>entry</strong> (up/down sets TP or SL like MetaTrader).
                  </div>
                  <div style={{ fontSize: 11, marginTop: 6, opacity: 0.88 }}>
                    <strong>Done</strong> or tap empty chart space to pan again. Tap another trade’s entry, TP, or SL
                    line to switch which trade you are editing. <strong>Add TP / Add SL</strong> restores the default
                    ±0.5% levels from entry; you can still drag the entry line to set them instead.
                  </div>
                  {/* <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      disabled={!selectedTrade || selectedTrade.tpPrice != null}
                      onClick={() => selectedTradeId && addTradeTp(selectedTradeId)}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor:
                          !selectedTrade || selectedTrade.tpPrice != null ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(134,239,172,0.55)',
                        background: 'rgba(6,78,59,0.5)',
                        color: '#ecfdf5',
                        opacity: !selectedTrade || selectedTrade.tpPrice != null ? 0.45 : 1,
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      Add TP
                    </button>
                    <button
                      type="button"
                      disabled={!selectedTrade || selectedTrade.tpPrice == null}
                      onClick={() => selectedTradeId && removeTradeTp(selectedTradeId)}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor:
                          !selectedTrade || selectedTrade.tpPrice == null ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(167,243,208,0.45)',
                        background: 'rgba(6,78,59,0.4)',
                        color: '#ecfdf5',
                        opacity: !selectedTrade || selectedTrade.tpPrice == null ? 0.45 : 1,
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      Remove TP
                    </button>
                    <button
                      type="button"
                      disabled={!selectedTrade || selectedTrade.slPrice != null}
                      onClick={() => selectedTradeId && addTradeSl(selectedTradeId)}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor:
                          !selectedTrade || selectedTrade.slPrice != null ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(252,165,165,0.5)',
                        background: 'rgba(127,29,29,0.45)',
                        color: '#fef2f2',
                        opacity: !selectedTrade || selectedTrade.slPrice != null ? 0.45 : 1,
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      Add SL
                    </button>
                    <button
                      type="button"
                      disabled={!selectedTrade || selectedTrade.slPrice == null}
                      onClick={() => selectedTradeId && removeTradeSl(selectedTradeId)}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor:
                          !selectedTrade || selectedTrade.slPrice == null ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(254,202,202,0.45)',
                        background: 'rgba(127,29,29,0.45)',
                        color: '#fef2f2',
                        opacity: !selectedTrade || selectedTrade.slPrice == null ? 0.45 : 1,
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      Remove SL
                    </button>
                  </div> */}
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 10,
                      fontSize: 11,
                      cursor: 'pointer',
                      userSelect: 'none',
                      opacity: 0.95,
                    }}
                  >
                    <input
                      type="checkbox"
                      onChange={(e) => {
                        if (!e.target.checked) return
                        persistHideTpSlDragHint()
                        setHideTpSlDragHint(true)
                      }}
                      style={{ width: 14, height: 14, accentColor: '#93c5fd', cursor: 'pointer' }}
                    />
                    Don&apos;t show this again
                  </label>
                </div>
                {/* <button
                  type="button"
                  onClick={() => setSelectedTradeId(null)}
                  style={{
                    flexShrink: 0,
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.35)',
                    background: 'rgba(255,255,255,0.15)',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  Done
                </button> */}
              </div>
            </div>
          )
        ) : null}
          </div>

          {lastTrade ? (
            <></>
            // <div
            //   style={{
            //     position: 'absolute',
            //     right: 10,
            //     top: 10,
            //     padding: 10,
            //     background: 'rgba(30,30,30,0.95)',
            //     border: '1px solid #404040',
            //     borderRadius: 8,
            //     color: '#e5e5e5',
            //     fontSize: 12,
            //     whiteSpace: 'pre-wrap',
            //     zIndex: 800,
            //   }}
            // >
            //   <div style={{ fontWeight: 700, marginBottom: 4 }}>Last trade (local)</div>
            //   <div>
            //     {lastTrade.side} {lastTrade.symbol} lotSize={lastTrade.lotSize}
            //   </div>
            //   <div style={{ color: '#a3a3a3' }}>{lastTrade.atIso}</div>
            // </div>
          ) : null}
        </div>

        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            overflow: 'auto',
            WebkitOverflowScrolling: 'touch',
            visibility: platformTab === 'history' ? 'visible' : 'hidden',
            pointerEvents: platformTab === 'history' ? 'auto' : 'none',
            background: '#0d0d0d',
            padding: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontWeight: 700, color: '#fafafa' }}>History</div>
            <div style={{ fontSize: 12, color: '#a3a3a3' }}>
              Live price: {latestPrice ? latestPrice.toFixed(2) : '—'}
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, color: '#e5e5e5' }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: 12, color: '#a3a3a3' }}>
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>Time</th>
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>Symbol</th>
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>Side</th>
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>Lot</th>
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>
                Entry
              </th>
              {/* <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>
                Current
              </th> */}
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>TP / SL</th>
              <th style={{ padding: '8px 6px', borderBottom: '1px solid #333' }}>PnL</th>
            </tr>
          </thead>
          <tbody>
            {tradeHistory.length === 0 ? (
              <tr>
                <td style={{ padding: 10, color: '#a3a3a3' }} colSpan={8}>
                  No trades yet.
                </td>
              </tr>
            ) : (
              tradeHistory.map((t) => {
                const current = latestPrice ?? t.entryPrice
                const pnl =
                  (t.side === 'BUY' ? current - t.entryPrice : t.entryPrice - current) *
                  t.lotSize
                const pnlColor = pnl >= 0 ? '#42a5f5' : '#ef5350'
                const tpHit =
                  t.tpPrice != null &&
                  (t.side === 'BUY' ? current >= t.tpPrice : current <= t.tpPrice)
                const slHit =
                  t.slPrice != null &&
                  (t.side === 'BUY' ? current <= t.slPrice : current >= t.slPrice)
                return (
                  <tr key={t.id} style={{ borderBottom: '1px solid #2a2a2a' }}>
                    <td style={{ padding: '8px 6px', fontSize: 12, color: '#a3a3a3' }}>
                      {new Date(t.openedAtIso).toLocaleString()}
                    </td>
                    <td style={{ padding: '8px 6px' }}>{t.symbol}</td>
                    <td style={{ padding: '8px 6px' }}>{t.side}</td>
                    <td style={{ padding: '8px 6px' }}>{t.lotSize}</td>
                    <td style={{ padding: '8px 6px' }}>{t.entryPrice.toFixed(2)}</td>
                    {/* <td style={{ padding: '8px 6px' }}>{current.toFixed(2)}</td> */}
                    <td style={{ padding: '8px 6px', fontSize: 12, color: '#a3a3a3' }}>
                      {t.tpPrice != null ? (
                        <>
                          TP {t.tpPrice.toFixed(2)} {tpHit ? '(hit)' : ''}
                        </>
                      ) : (
                        <>TP —</>
                      )}
                      <br />
                      {t.slPrice != null ? (
                        <>
                          SL {t.slPrice.toFixed(2)} {slHit ? '(hit)' : ''}
                        </>
                      ) : (
                        <>SL —</>
                      )}
                    </td>
                    <td style={{ padding: '8px 6px', color: pnlColor, fontWeight: 600 }}>
                      {pnl.toFixed(2)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
          </table>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Main view"
        style={{
          flexShrink: 0,
          display: 'flex',
          borderTop: '1px solid #2a2a2a',
          background: '#111',
          paddingBottom: 'max(8px, env(safe-area-inset-bottom, 0px))',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={platformTab === 'chart'}
          onClick={() => setPlatformTab('chart')}
          style={{
            flex: 1,
            padding: '12px 10px',
            border: 'none',
            borderTop: platformTab === 'chart' ? '3px solid #1565c0' : '3px solid transparent',
            background: platformTab === 'chart' ? '#1a1a1a' : 'transparent',
            color: platformTab === 'chart' ? '#e5e5e5' : '#888',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          Chart
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={platformTab === 'history'}
          onClick={() => {
            setPlatformTab('history')
            setSelectedTradeId(null)
          }}
          style={{
            flex: 1,
            padding: '12px 10px',
            border: 'none',
            borderTop: platformTab === 'history' ? '3px solid #1565c0' : '3px solid transparent',
            background: platformTab === 'history' ? '#1a1a1a' : 'transparent',
            color: platformTab === 'history' ? '#e5e5e5' : '#888',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          History
        </button>
      </div>

      {error ? (
        <div
          style={{
            position: 'absolute',
            left: 12,
            bottom: 'calc(56px + max(12px, env(safe-area-inset-bottom, 0px)))',
            right: 12,
            padding: 12,
            background: 'rgba(255,255,255,0.95)',
            border: '1px solid #ef4444',
            color: '#991b1b',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  )
}

