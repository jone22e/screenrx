import type { Transcript } from '@shared/models/captions'
import type { Project } from '@shared/models/project'
import type { ProjectTemplate } from '@shared/models/template'

/**
 * What the web editor keeps between visits, in the browser's IndexedDB:
 * the project of each video opened (by a fingerprint of the file), the
 * images, clips and music brought into it, the list of videos opened
 * lately, the templates, and the transcript of each video (the one thing a
 * server took part in). Nothing else leaves the browser.
 */

const DATABASE = 'screenrx-web'
const VERSION = 2
const STORES = { projects: 'projects', assets: 'assets', recent: 'recent', templates: 'templates', transcripts: 'transcripts' } as const

/** A video opened lately: enough to show it in the list and to open it again when the browser allows. */
export interface RecentVideo {
  sessionId: string
  title: string
  sizeBytes: number
  durationMs: number
  openedAt: string
  /** The file itself, when the browser lets the page keep a handle to it (Chromium). */
  handle?: FileSystemFileHandle
}

/** A file brought into a session: an image, a clip, or the music. */
export interface StoredAsset {
  /** `<sessionId>/<file>` */
  key: string
  sessionId: string
  file: string
  name: string
  kind: 'image' | 'clip' | 'music'
  blob: Blob
  widthPx: number
  heightPx: number
  durationMs: number
}

let opening: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORES.projects)) database.createObjectStore(STORES.projects, { keyPath: 'sessionId' })
      if (!database.objectStoreNames.contains(STORES.assets)) {
        const assets = database.createObjectStore(STORES.assets, { keyPath: 'key' })
        assets.createIndex('sessionId', 'sessionId')
      }
      if (!database.objectStoreNames.contains(STORES.recent)) database.createObjectStore(STORES.recent, { keyPath: 'sessionId' })
      if (!database.objectStoreNames.contains(STORES.templates)) database.createObjectStore(STORES.templates)
      if (!database.objectStoreNames.contains(STORES.transcripts)) database.createObjectStore(STORES.transcripts)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      opening = null
      reject(request.error ?? new Error('IndexedDB unavailable'))
    }
  })
  return opening
}

const settle = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })

async function read<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const database = await openDatabase()
  return settle(database.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>)
}

async function write(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const database = await openDatabase()
  const objectStore = database.transaction(store, 'readwrite').objectStore(store)
  await settle(key === undefined ? objectStore.put(value) : objectStore.put(value, key))
}

async function remove(store: string, key: IDBValidKey): Promise<void> {
  const database = await openDatabase()
  await settle(database.transaction(store, 'readwrite').objectStore(store).delete(key))
}

async function readAll<T>(store: string): Promise<T[]> {
  const database = await openDatabase()
  return settle(database.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>)
}

export const webStorage = {
  readProject: (sessionId: string) => read<Project>(STORES.projects, sessionId),
  writeProject: (project: Project) => write(STORES.projects, project),

  async listAssets(sessionId: string): Promise<StoredAsset[]> {
    const database = await openDatabase()
    const index = database.transaction(STORES.assets, 'readonly').objectStore(STORES.assets).index('sessionId')
    return settle(index.getAll(sessionId) as IDBRequest<StoredAsset[]>)
  },
  writeAsset: (asset: StoredAsset) => write(STORES.assets, asset),
  removeAsset: (sessionId: string, file: string) => remove(STORES.assets, `${sessionId}/${file}`),

  listRecent: async (): Promise<RecentVideo[]> =>
    (await readAll<RecentVideo>(STORES.recent)).sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
  writeRecent: (video: RecentVideo) => write(STORES.recent, video),
  removeRecent: (sessionId: string) => remove(STORES.recent, sessionId),

  readTemplates: async (): Promise<unknown> => read<unknown>(STORES.templates, 'all'),
  writeTemplates: (templates: ProjectTemplate[]) => write(STORES.templates, templates, 'all'),

  readTranscript: (sessionId: string) => read<unknown>(STORES.transcripts, sessionId),
  writeTranscript: (sessionId: string, transcript: Transcript) => write(STORES.transcripts, transcript, sessionId),
  removeTranscript: (sessionId: string) => remove(STORES.transcripts, sessionId)
}
