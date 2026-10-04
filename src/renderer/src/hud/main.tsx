import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../common/base.css'
import './hud.css'
import { Hud } from './Hud'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Hud />
  </StrictMode>
)
