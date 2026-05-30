import { useState } from 'react'

const PRIORITY_COLORS = { high: '#dc2626', medium: '#d97706', low: '#16a34a' }

const SEED = [
  { id: 1, text: 'Wire up the Atlas dev-loop', priority: 'high' },
  { id: 2, text: 'Ship the demo', priority: 'medium' },
  { id: 3, text: 'Write the docs', priority: 'low' },
]

function Badge({ priority }) {
  return (
    <span className="badge" style={{ backgroundColor: PRIORITY_COLORS[priority] }}>
      {priority}
    </span>
  )
}

export default function Home() {
  const [todos, setTodos] = useState(SEED.map((t) => ({ ...t, done: false })))
  const toggle = (id) =>
    setTodos((t) => t.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))

  return (
    <main className="page">
      <h1>Todos</h1>
      <ul className="todos">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''} onClick={() => toggle(t.id)}>
            <span className="todo-text">{t.text}</span>
            <Badge priority={t.priority} />
          </li>
        ))}
      </ul>
    </main>
  )
}
