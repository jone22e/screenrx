/**
 * A nudge for the library to list the recordings again, from the renderer
 * itself: the main process says so after its own changes (`library:changed`),
 * but a project written from here (a series edited by the team) is not one.
 */
class LibraryRefresh {
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const libraryRefresh = new LibraryRefresh()
