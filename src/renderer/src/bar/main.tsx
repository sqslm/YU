import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Bar } from './Bar'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')
createRoot(container).render(
  <StrictMode>
    <Bar />
  </StrictMode>
)
