import type { Layer } from '@shared/models/project'
import { FilmIcon, ImageIcon, ShapesIcon, SmileIcon } from './icons'

/** The icon a layer is listed with: by its kind. */
export function LayerIcon({ layer }: { layer: Layer }) {
  switch (layer.kind) {
    case 'video':
      return <FilmIcon />
    case 'shape':
      return <ShapesIcon />
    case 'emoji':
      return <SmileIcon />
    default:
      return <ImageIcon />
  }
}
