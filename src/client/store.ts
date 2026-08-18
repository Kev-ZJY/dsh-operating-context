/**
 * Page state for the operating-window section, on the official snapshot store
 * so the shell's subscription and flush behavior are the same as every built-in
 * settings page. The store carries facts and raw host errors; turning either
 * into words is the section's job, because only it has the dictionary.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath } from '@deepseek-ai/dsh-client-schema-form'
import {
  CodedError, unwrap,
  type DiscoveredModel, type NamespaceView, type OperatingContextApi, type PathOp,
  type ProviderTarget,
} from './api.ts'
import { ceilingsOf, hasDiscoverableCeilings, routeKey } from './ceiling.ts'
import { failureOf, WRITE_BLOCKED, type HostFailure } from './failure.ts'
import { commonRequestedWindow, effectiveWindows, planRoute, planRouteWithModels, profileModels, type RouteProfile } from './plan.ts'
import { writeBatches } from './write.ts'

/** One configured route the page can show and write. */
export interface RouteEntry extends RouteProfile {
  /** Stable identity for React keys and lookups. */
  key: string
  /**
   * The models this route serves, as the page lists them. Prefers the profile's
   * own `models[]` rows (authoritative when present), falling back to whatever
   * discovery reported. Distinct from {@link RouteProfile.discovered}, which
   * stays the capacity list used to clamp writes.
   */
  models: readonly DiscoveredModel[]
}

/** Everything the section renders. */
export interface OperatingContextState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Why the page could not load. */
  error: HostFailure | null
  /** Why the last apply did not go through. */
  writeFailure: HostFailure | null
  /** The window written by the last successful apply. */
  savedWindow: number | null
  /** A write that changed some settings batches before a later batch failed. */
  partialWrite: { applied: number; total: number } | null
  applying: boolean
  writable: boolean
  routes: readonly RouteEntry[]
  /** The common window requested on every route, restored across page mounts. */
  selectedWindow: number | undefined
  /** The window every model already holds, when they all agree on one. */
  current: number | undefined
  /** Whether models currently disagree about the window in force. */
  mixed: boolean
  /** Per-route save status: 'saving' | 'ok' | null, keyed by route key. */
  routeSaveResult: Record<string, 'saving' | 'ok' | null>
  /** Per-route save error message, keyed by route key. */
  routeSaveError: Record<string, string | null>
}

const INITIAL: OperatingContextState = {
  status: 'idle',
  error: null,
  writeFailure: null,
  savedWindow: null,
  partialWrite: null,
  applying: false,
  writable: false,
  routes: [],
  selectedWindow: undefined,
  current: undefined,
  mixed: false,
  routeSaveResult: {},
  routeSaveError: {},
}

/** Reads the configured routes, and writes a chosen window across all of them. */
export class OperatingContextStore {
  /** Snapshot source the section subscribes to. */
  readonly store: SnapshotStore<OperatingContextState>

  private readonly api: OperatingContextApi

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the official Web API client.
   */
  constructor(api: OperatingContextApi) {
    this.api = api
    this.store = createSnapshotStore<OperatingContextState>(INITIAL)
  }

  /**
   * Load routes, their profiles, and whatever native capacities can be read
   * without leaving the machine.
   * @returns nothing; the outcome lands in the snapshot.
   */
  async load(): Promise<void> {
    const generation = this.generation + 1
    this.generation = generation
    this.store.update((draft) => {
      draft.status = draft.status === 'ready' ? 'ready' : 'loading'
      draft.error = null
    })
    try {
      const [providers, settings] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      const directory = unwrap(providers).providers
      const document = unwrap(settings)
      const namespaces = new Map(document.namespaces.map(view => [view.ns, view]))
      const configured: { route: ProviderTarget; profile: unknown }[] = []
      for (const route of directory) {
        if (route.settingsNs.length === 0) continue
        const namespace = namespaces.get(route.settingsNs)
        if (namespace === undefined) continue
        const profile = getPath(namespace.value, route.settingsPath)
        if (profile === undefined) continue
        configured.push({ route, profile })
      }
      const routes: RouteEntry[] = await Promise.all(configured.map(async ({ route, profile }) => {
        const discovered = await this.describeCeilings(route)
        const allModels = await this.discoverAllModels(route)
        // The profile's own models[] rows are the authoritative list when
        // present (they replace the served catalog). Fall back to the adapter's
        // discovery only when the profile declares none.
        const listed = profileModels(profile)
        const models = listed.length > 0 ? listed : discovered ?? allModels
        return {
          key: routeKey(route),
          route,
          profile,
          // `discovered` stays the capacity list used to clamp writes; a
          // profile-declared models[] is authoritative for display but is not a
          // ceiling, so it must not leak into ceilingsKnown.
          discovered: discovered ?? [],
          models,
          ceilingsKnown: discovered !== undefined,
        }
      }))
      if (this.generation !== generation) return
      const windows = new Set(routes.flatMap(entry => effectiveWindows(entry)))
      this.store.update((draft) => {
        draft.status = 'ready'
        draft.error = null
        draft.writable = document.writable
        draft.routes = routes
        draft.selectedWindow = commonRequestedWindow(routes)
        draft.current = windows.size === 1 ? [...windows][0] : undefined
        draft.mixed = windows.size > 1
      })
    } catch (reason: unknown) {
      if (this.generation !== generation) return
      this.store.update((draft) => {
        draft.status = 'error'
        draft.error = failureOf(reason)
      })
    }
  }

  /**
   * Reload for a pushed invalidation, but only when there is a loaded page to
   * refresh and no write in flight to race.
   */
  refreshIfLoaded(): void {
    const snapshot = this.store.getSnapshot()
    if (snapshot.status === 'idle' || snapshot.applying) return
    void this.load()
  }

  /** Dismiss feedback that belongs to an earlier, now-abandoned choice. */
  clearWriteFeedback(): void {
    const snapshot = this.store.getSnapshot()
    if (snapshot.savedWindow === null && snapshot.writeFailure === null && snapshot.partialWrite === null) return
    this.store.update((draft) => {
      draft.savedWindow = null
      draft.writeFailure = null
      draft.partialWrite = null
    })
  }

  /** Dismiss per-route save feedback. */
  clearRouteSaveFeedback(key?: string): void {
    this.store.update((draft) => {
      if (key !== undefined) {
        draft.routeSaveResult[key] = null
        draft.routeSaveError[key] = null
      } else {
        draft.routeSaveResult = {}
        draft.routeSaveError = {}
      }
    })
  }

  /**
   * Put every configured route under one window, then reload so the page shows
   * what the adapter resolved rather than what was requested.
   * @param target - the window the user picked.
   * @returns nothing; the outcome lands in the snapshot.
   */
  async apply(target: number): Promise<void> {
    this.store.update((draft) => {
      draft.applying = true
      draft.writeFailure = null
      draft.savedWindow = null
      draft.partialWrite = null
    })
    let attemptedWrite = false
    try {
      if (!Number.isSafeInteger(target) || target <= 0) {
        throw new CodedError('window must be a positive integer', WRITE_BLOCKED.invalidWindow)
      }
      const document = unwrap(await this.api.settings.describe({}))
      if (!document.writable) {
        throw new CodedError('the settings document is read-only', WRITE_BLOCKED.readOnly)
      }
      const namespaces = new Map(document.namespaces.map(view => [view.ns, view]))
      const groups = this.groupOps(namespaces, target)
      attemptedWrite = true
      const result = await writeBatches(
        groups.map(group => ({ ns: group.ns, payload: group })),
        async ({ payload: { ns, ops, revision } }) => {
          unwrap(await this.api.settings.mutate({ ns, ops, expectedRevision: revision }))
        },
      )
      if (!result.ok) {
        // The first batch can fail because another writer committed and caused
        // an invalidation while `applying` suppressed the pushed reload.
        await this.load()
        this.store.update((draft) => {
          draft.applying = false
          draft.writeFailure = failureOf(result.reason)
          draft.partialWrite = result.applied > 0
            ? { applied: result.applied, total: result.total }
            : null
        })
        return
      }
      // A pushed invalidation is deliberately ignored while a write is in
      // flight. This explicit read is therefore the one convergence path for
      // both single- and multi-namespace writes.
      await this.load()
      this.store.update((draft) => {
        draft.applying = false
        draft.savedWindow = target
        draft.partialWrite = null
      })
    } catch (reason: unknown) {
      const failure = failureOf(reason)
      // A synchronous host/client failure may still happen after a write was
      // attempted. Re-read because its pushed invalidation was suppressed.
      if (attemptedWrite) await this.load()
      this.store.update((draft) => {
        draft.applying = false
        draft.writeFailure = failure
        draft.partialWrite = null
      })
    }
  }

  /** Group every route's operations by the namespace one mutate call can carry. */
  private groupOps(
    namespaces: ReadonlyMap<string, NamespaceView>,
    target: number,
  ): { ns: string; ops: PathOp[]; revision: number }[] {
    const grouped = new Map<string, { ops: PathOp[]; revision: number }>()
    for (const entry of this.store.getSnapshot().routes) {
      const namespace = namespaces.get(entry.route.settingsNs)
      if (namespace === undefined) continue
      const profile = getPath(namespace.value, entry.route.settingsPath)
      if (profile === undefined) continue
      let group = grouped.get(namespace.ns)
      if (group === undefined) {
        group = { ops: [], revision: namespace.revision }
        grouped.set(namespace.ns, group)
      }
      group.ops.push(...planRoute({ ...entry, profile }, target))
    }
    if (grouped.size === 0) {
      throw new CodedError('no configured model routes to write', WRITE_BLOCKED.noRoutes)
    }
    return [...grouped].map(([ns, group]) => ({ ns, ...group }))
  }

  /**
   * Apply per-model window changes for a single route. This writes modelOverrides
   * and updates defaultContextWindow for that route only.
   * @param routeKey - the stable key of the route to save.
   * @param modelWindows - per-model target windows.
   * @returns nothing; the outcome lands in the snapshot.
   */
  async applyModels(routeKey: string, modelWindows: ReadonlyMap<string, number>): Promise<void> {
    this.store.update((draft) => {
      draft.routeSaveResult[routeKey] = 'saving'
      draft.routeSaveError[routeKey] = null
    })
    try {
      const document = unwrap(await this.api.settings.describe({}))
      if (!document.writable) {
        throw new CodedError('the settings document is read-only', WRITE_BLOCKED.readOnly)
      }
      if (modelWindows.size === 0) {
        throw new CodedError('no model changes to apply', WRITE_BLOCKED.noRoutes)
      }
      const namespaces = new Map(document.namespaces.map(view => [view.ns, view]))
      const entry = this.store.getSnapshot().routes.find(r => r.key === routeKey)
      if (entry === undefined) {
        throw new CodedError('route not found', WRITE_BLOCKED.noRoutes)
      }
      const namespace = namespaces.get(entry.route.settingsNs)
      if (namespace === undefined) {
        throw new CodedError('namespace not found', WRITE_BLOCKED.noRoutes)
      }
      const profile = getPath(namespace.value, entry.route.settingsPath)
      if (profile === undefined) {
        throw new CodedError('profile not found', WRITE_BLOCKED.noRoutes)
      }
      const ops = planRouteWithModels({ ...entry, profile }, modelWindows)
      unwrap(await this.api.settings.mutate({
        ns: namespace.ns,
        ops,
        expectedRevision: namespace.revision,
      }))
      // Reload to get fresh state after the write.
      await this.load()
      this.store.update((draft) => {
        draft.routeSaveResult[routeKey] = 'ok'
        draft.routeSaveError[routeKey] = null
      })
    } catch (reason: unknown) {
      const failure = failureOf(reason)
      // Reload on conflict so the page shows fresh state.
      if (failure.code === 'settings-conflict') await this.load()
      this.store.update((draft) => {
        draft.routeSaveResult[routeKey] = null
        draft.routeSaveError[routeKey] = failure.message
      })
    }
  }

  /**
   * Ask the adapter for a route's native capacities, but only when the answer
   * comes from local data. `undefined` means the ceilings are unknown, which the
   * page reports rather than papering over with a default.
   */
  private async describeCeilings(
    route: ProviderTarget,
  ): Promise<readonly DiscoveredModel[] | undefined> {
    if (!hasDiscoverableCeilings(route)) return undefined
    if (typeof this.api.llm.discoverModels !== 'function') return undefined
    try {
      const answer = await this.api.llm.discoverModels({
        settingsNs: route.settingsNs,
        provider: route.provider,
      })
      const { models } = unwrap(answer)
      return ceilingsOf(models).size === 0 ? undefined : models
    } catch {
      // A route that cannot describe itself is reported as unknown, not as an
      // error: the rest of the page is still usable and still writable.
      return undefined
    }
  }

  /**
   * Try to discover models for ALL routes, including non-pi-ai ones. Unlike
   * {@link describeCeilings}, this does not require local catalog data and may
   * make a network request for external providers. Returns the model list even
   * when ceilings are not authoritative.
   */
  private async discoverAllModels(
    route: ProviderTarget,
  ): Promise<readonly DiscoveredModel[]> {
    if (typeof this.api.llm.discoverModels !== 'function') return []
    try {
      const answer = await this.api.llm.discoverModels({
        settingsNs: route.settingsNs,
        provider: route.provider,
      })
      return unwrap(answer).models
    } catch {
      return []
    }
  }
}
