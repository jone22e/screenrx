import { createWebApi } from '../renderer/src/web/webApi'
import { probeServices } from '../renderer/src/web/webTranscription'

// The bridge must be in place before any module of the editor reads it, so the editor is loaded only after:
// what the editor offers depends on what the server answers it has.
void probeServices().then(async (services) => {
  window.screenrx = createWebApi(services)
  const [{ StrictMode }, { createRoot }, { WebApp }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../renderer/src/web/WebApp'),
    import('../renderer/src/common/base.css')
  ])
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <WebApp />
    </StrictMode>
  )
})
