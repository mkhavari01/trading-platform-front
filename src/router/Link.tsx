import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { useRouter } from './Router'

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string
  replace?: boolean
}

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter()

  const href = `${to.startsWith('/') ? to : `/${to}`}`

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented) return

    if (
      e.button !== 0 ||
      rest.target === '_blank' ||
      e.metaKey ||
      e.altKey ||
      e.ctrlKey ||
      e.shiftKey
    ) {
      return
    }

    e.preventDefault()
    navigate(to, { replace })
  }

  return <a {...rest} href={href} onClick={handleClick} />
}

