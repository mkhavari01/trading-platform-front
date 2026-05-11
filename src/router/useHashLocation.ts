import { useEffect, useMemo, useState } from 'react'

function getHashPathname() {
  const raw = window.location.hash || '#/'
  const value = raw.startsWith('#') ? raw.slice(1) : raw
  return value.startsWith('/') ? value : `/${value}`
}

export function useHashLocation() {
  const [pathname, setPathname] = useState(() => getHashPathname())

  useEffect(() => {
    const onHashChange = () => setPathname(getHashPathname())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useMemo(() => {
    return (to: string, { replace }: { replace?: boolean } = {}) => {
      const next = to.startsWith('/') ? to : `/${to}`
      const hash = `#${next}`

      if (replace) {
        window.location.replace(hash)
        return
      }

      window.location.hash = hash
    }
  }, [])

  return { pathname, navigate }
}

