import { Route, Routes } from 'react-router-dom'

function PlaceholderHome() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-tertiary text-text-primary">
      <div className="flex flex-col items-center gap-4">
        <h1 className="text-3xl font-bold">my-agent</h1>
        <p className="text-text-secondary">M-WEB Phase 1 — boot OK</p>
        <p className="text-sm text-text-muted">
          web bridge will be wired up in M-WEB-3 onward
        </p>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PlaceholderHome />} />
      <Route path="*" element={<PlaceholderHome />} />
    </Routes>
  )
}
