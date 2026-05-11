export function LoginPage() {
  return (
    <section>
      <h1>Login</h1>
      <p>Simple login placeholder page.</p>
      <form>
        <div>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" />
          </label>
        </div>
        <div>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" />
          </label>
        </div>
        <button type="submit">Sign in</button>
      </form>
    </section>
  )
}

