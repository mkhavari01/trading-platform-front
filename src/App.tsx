import { Link } from './router/Link'
import { Route, Router } from './router/Router'
import { DashboardPage } from './pages/DashboardPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PlatformPage } from './pages/PlatformPage'

function App() {
  return (
    <div style={{ padding: 16 }}>
      <Router>
        <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Link to="/">Home</Link>
          <Link to="/login">Login</Link>
          <Link to="/dashboard">Dashboard</Link>
          <Link to="/platform">Platform</Link>
        </nav>

        <main style={{ marginTop: 16 }}>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/platform" element={<PlatformPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </main>
      </Router>
    </div>
  )
}

export default App
