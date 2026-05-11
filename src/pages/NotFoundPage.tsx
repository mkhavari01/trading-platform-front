import { Link } from '../router/Link'

export function NotFoundPage() {
  return (
    <section>
      <h1>404</h1>
      <p>Page not found.</p>
      <p>
        Go back to <Link to="/">Home</Link>.
      </p>
    </section>
  )
}

