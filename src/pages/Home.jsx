import { useState } from 'react'

const SEED = [
  { id: 1, text: 'Wire up the Atlas dev-loop' },
  { id: 2, text: 'Ship the demo' },
]

export default function Home() {
  const [todos, setTodos] = useState(SEED.map((t) => ({ ...t, done: false })))
  const toggle = (id) =>
    setTodos((t) => t.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))

  return (
    <main className="page">
      <h1>Todos</h1>
      <ul className="todos">
        {todos.map((t) => (
          <li
            key={t.id}
            className={t.done ? 'done' : ''}
            onClick={() => toggle(t.id)}
          >
            {t.text}
          </li>
        ))}
      </ul>
    </main>
  )
}
