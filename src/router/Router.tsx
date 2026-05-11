import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useHashLocation } from './useHashLocation'

type RouterContextValue = {
  pathname: string
  navigate: (to: string, opts?: { replace?: boolean }) => void
}

const RouterContext = createContext<RouterContextValue | null>(null)

export function Router({ children }: { children: ReactNode }) {
  const { pathname, navigate } = useHashLocation()

  return (
    <RouterContext.Provider value={{ pathname, navigate }}>
      {children}
    </RouterContext.Provider>
  )
}

export function useRouter() {
  const ctx = useContext(RouterContext)
  if (!ctx) {
    throw new Error('useRouter must be used inside <Router>.')
  }
  return ctx
}

function normalizePath(path: string) {
  const clean = path.trim() || '/'
  return clean.startsWith('/') ? clean : `/${clean}`
}

function isMatch(pathname: string, routePath: string) {
  if (routePath === '*') return true
  return normalizePath(pathname) === normalizePath(routePath)
}

export function Route({
  path,
  element,
}: {
  path: string
  element: ReactNode
}) {
  const { pathname } = useRouter()
  return isMatch(pathname, path) ? element : null
}

