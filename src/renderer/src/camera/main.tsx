import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../common/base.css'
import './camera.css'
import { CameraBubble } from './CameraBubble'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <CameraBubble />
  </StrictMode>
)
