import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AnswerCard } from './AnswerCard'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')
createRoot(container).render(
  <StrictMode>
    <AnswerCard />
  </StrictMode>
)
