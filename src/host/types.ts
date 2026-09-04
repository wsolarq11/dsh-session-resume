/** Host-facing structural contracts for DSH services the plugin touches. */

export interface HttpRequestLike {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  on(event: 'data' | 'end' | 'error', listener: (...args: unknown[]) => void): unknown
  resume?(): unknown
  removeAllListeners?(event: string): unknown
}

export interface HttpResponseLike {
  writeHead(code: number, headers: Record<string, string>): unknown
  end(payload: string): unknown
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
  }): () => void
}

export interface SessionHeaderLike {
  id: string
  cwd?: string
  title?: string
  parentSession?: string
}

export interface SessionRecordLike {
  header: SessionHeaderLike
  live?: boolean
  persisted?: boolean
}

export interface SessionLineageNodeLike {
  session: SessionRecordLike
  descendants: SessionLineageNodeLike[]
}

export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
  readTitle(sessionId: string, signal?: AbortSignal): Promise<{ title: string } | undefined>
  traceSession?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ descendants: SessionLineageNodeLike[] }>
  readTitleSnapshots?(
    sessionIds: string[],
    signal?: AbortSignal,
  ): Promise<
    Array<
      | { title?: string | { title: string } }
      | { status: 'fulfilled'; value?: { title?: string | { title: string } } }
      | { status: 'rejected' }
      | undefined
    >
  >
}

export interface SessionRawArtifactLike {
  meta: SessionHeaderLike
  filename: string
  content: string
}

export interface SessionPersistenceLike {
  supportsRawArtifacts: boolean
  locate(meta: SessionHeaderLike): { kind: string; path: string } | undefined
  readRaw?(id: string, signal?: AbortSignal): Promise<SessionRawArtifactLike | undefined>
}

export interface SessionStoreLike {
  get(id: string): unknown
  flush(session: unknown): Promise<boolean>
}

export interface ImageAttachmentRefLike {
  attachmentId: string | number
  mediaType: string
}

export interface AttachmentStoreLike {
  readImage?(
    ref: ImageAttachmentRefLike,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array }>
}

export interface WorkspaceLike {
  id: string
  path: string
  sessionIds: readonly string[]
  attachSession?(sessionId: string): Promise<void>
  /** Optional compensation for a workspace this plugin created and must roll back. */
  remove?(): Promise<void>
}

export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
  resolveByPath?(path: string): Promise<WorkspaceLike | undefined>
  create?(path: string, title?: string): Promise<WorkspaceLike>
}

export interface HostContext {
  get?(name: string): unknown
  webServer?: WebServerLike
  sessionQuery?: SessionQueryLike
  sessionPersistence?: SessionPersistenceLike
  sessions?: SessionStoreLike
  workspaceRegistry?: WorkspaceRegistryLike
  attachments?: AttachmentStoreLike
  /** Host typert registry (strict local store + register). Used to self-heal a withdrawn contribution. */
  typert?: {
    local: {
      hasSeen(endpoint: string): boolean
      get(endpoint: string): unknown
      list(): unknown[]
      subscribe?(listener: (change: { kind?: string; key: string }) => void): () => void
    }
    register: (contribution: { package?: string; face?: string; invocations: unknown[]; schemas?: unknown[] }) => () => void
  }
  /**
   * Internal runtime may wrap HostContext in a getter-only facade. Read
   * through a local variable so injected contexts do not throw "without inject".
   */
  resumeCacheRoot?: string
  logger?: {
    info?(...args: unknown[]): void
    warn?(...args: unknown[]): void
    error?(...args: unknown[]): void
  }
}
