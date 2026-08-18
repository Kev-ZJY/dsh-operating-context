/**
 * How this plugin reads and writes one provider profile.
 *
 * The multi-provider adapter resolves a model's capacity as
 * `entry.contextWindow ?? catalog.contextWindow ?? defaultContextWindow`, where
 * `entry` is either a `models[]` row or a `modelOverrides` patch. That order is
 * why writing `defaultContextWindow` alone changes nothing for a route whose
 * models come from the installed catalog, and why the write target has to be
 * chosen from the profile's shape rather than assumed:
 *
 * - a non-empty `models[]` replaces the served catalog, so capacities belong on
 *   its rows and `modelOverrides` beside it is rejected;
 * - an absent or empty `models[]` on a catalog route serves the catalog, so
 *   `modelOverrides` is the only entry-level lever;
 * - a hand-declared route has no catalog to override, so only its own rows or
 *   the route default can say anything.
 *
 * Within that, one rule decides the value: a model is never given a window
 * larger than it can hold, and a model that already holds the right number is
 * left alone rather than restated. Leaving it alone is what makes the write
 * idempotent and what makes choosing a large window undo earlier clamps.
 */
import { ceilingsOf, effectiveWindow } from './ceiling.ts'
import type { DiscoveredModel, PathOp, ProviderTarget } from './api.ts'

/** A route joined with its settings profile and whatever the adapter disclosed. */
export interface RouteProfile {
  route: ProviderTarget
  /** Settings value at the route's `settingsPath`. */
  profile: unknown
  /** Models the adapter could describe locally; empty when it could not. */
  discovered: readonly DiscoveredModel[]
  /** Whether {@link RouteProfile.discovered} is an authoritative capacity list. */
  ceilingsKnown: boolean
}

interface ProviderProfile {
  models?: unknown
  modelOverrides?: unknown
  defaultContextWindow?: unknown
}

function asProfile(profile: unknown): ProviderProfile {
  return typeof profile === 'object' && profile !== null ? profile as ProviderProfile : {}
}

function modelRows(profile: unknown): Record<string, unknown>[] | undefined {
  const { models } = asProfile(profile)
  if (!Array.isArray(models) || models.length === 0) return undefined
  return models.map(row => (typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}))
}

function overrides(profile: unknown): Record<string, unknown> | undefined {
  const { modelOverrides } = asProfile(profile)
  if (typeof modelOverrides !== 'object' || modelOverrides === null) return undefined
  return modelOverrides as Record<string, unknown>
}

function overrideEntry(profile: unknown, id: string): Record<string, unknown> | undefined {
  const entry = overrides(profile)?.[id]
  return typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined
}

function ceilingMap(entry: RouteProfile): ReadonlyMap<string, number> {
  return entry.ceilingsKnown ? ceilingsOf(entry.discovered) : new Map()
}

/**
 * The models a route actually serves, read from its profile's own `models[]`
 * rows when present. A non-empty models list replaces the served catalog, so
 * these rows are the authoritative list of what the user configured — they are
 * what the official Models page edits and what discovery cannot see when the
 * adapter ships no catalog (e.g. `llm-deepseek`).
 * @param profile - the route's settings profile.
 * @returns the models declared in the profile, with the fields the page shows.
 */
export function profileModels(profile: unknown): DiscoveredModel[] {
  const rows = modelRows(profile) ?? []
  const models: DiscoveredModel[] = []
  for (const row of rows) {
    const id = typeof row['id'] === 'string' ? row['id'] : undefined
    if (id === undefined) continue
    const name = typeof row['name'] === 'string' ? row['name'] : undefined
    const contextWindow = typeof row['contextWindow'] === 'number'
      && Number.isSafeInteger(row['contextWindow']) && row['contextWindow'] > 0
      ? row['contextWindow']
      : undefined
    models.push({ id, name, contextWindow })
  }
  return models
}

/**
 * The window each model holds right now, keyed by model id. Follows the same
 * precedence the adapter applies (`entry.contextWindow ?? catalog.contextWindow
 * ?? defaultContextWindow`) so the page reports the value that is actually in
 * force, not a raw setting that the next resolution step would override.
 * @param entry - the route joined with its profile.
 * @returns model id to effective window; a model with no resolvable value is absent.
 */
export function modelBaselines(entry: RouteProfile): Map<string, number> {
  const baselines = new Map<string, number>()
  const { defaultContextWindow } = asProfile(entry.profile)
  const fallback = typeof defaultContextWindow === 'number' && defaultContextWindow > 0
    ? defaultContextWindow
    : undefined
  const rows = modelRows(entry.profile)
  if (rows !== undefined) {
    for (const row of rows) {
      const id = typeof row['id'] === 'string' ? row['id'] : undefined
      if (id === undefined) continue
      const declared = row['contextWindow']
      const value = typeof declared === 'number' && declared > 0 ? declared : fallback
      if (value !== undefined) baselines.set(id, value)
    }
    return baselines
  }
  const ceilings = ceilingMap(entry)
  for (const model of entry.discovered) {
    const patched = overrideEntry(entry.profile, model.id)?.['contextWindow']
    const value = typeof patched === 'number' && patched > 0
      ? patched
      : ceilings.get(model.id) ?? fallback
    if (value !== undefined) baselines.set(model.id, value)
  }
  return baselines
}

/**
 * Recover the operating window last chosen through this page.
 *
 * Applying a window always writes the same `defaultContextWindow` marker to
 * every configured route, even when individual models are clamped below that
 * request. Re-reading that common marker lets a newly mounted Settings page
 * restore the user's choice without confusing it with the models' resolved
 * (and legitimately mixed) capacities.
 */
export function commonRequestedWindow(entries: readonly RouteProfile[]): number | undefined {
  if (entries.length === 0) return undefined
  const requested = entries.map((entry) => {
    const value = asProfile(entry.profile).defaultContextWindow
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined
  })
  if (requested.some(value => value === undefined)) return undefined
  const windows = new Set(requested)
  return windows.size === 1 ? requested[0] : undefined
}

/**
 * Overrides that name models the authoritative catalog no longer contains.
 * Applying must remove these entries because the adapter rejects the route,
 * but the UI also uses this list to disclose that cleanup before writing.
 */
export function obsoleteOverrideIds(entry: RouteProfile): string[] {
  if (!entry.ceilingsKnown || modelRows(entry.profile) !== undefined) return []
  const described = new Set(entry.discovered.map(model => model.id))
  return Object.keys(overrides(entry.profile) ?? {})
    .filter(id => !described.has(id))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * The windows a route's models hold right now, after the same precedence the
 * adapter applies. Reading the resolved value rather than the raw setting is
 * what keeps the page from reporting a number that is written but inert.
 * @param entry - the route joined with its profile.
 * @returns one window per model, or the route default when there are no models.
 */
export function effectiveWindows(entry: RouteProfile): number[] {
  const { defaultContextWindow } = asProfile(entry.profile)
  const fallback = typeof defaultContextWindow === 'number' ? defaultContextWindow : undefined
  const rows = modelRows(entry.profile)
  if (rows !== undefined) {
    return rows.flatMap((row) => {
      const declared = row['contextWindow']
      if (typeof declared === 'number') return [declared]
      return fallback === undefined ? [] : [fallback]
    })
  }
  const ceilings = ceilingMap(entry)
  if (entry.discovered.length > 0) {
    return entry.discovered.flatMap((model) => {
      const patched = overrideEntry(entry.profile, model.id)?.['contextWindow']
      if (typeof patched === 'number') return [patched]
      const ceiling = ceilings.get(model.id)
      if (ceiling !== undefined) return [ceiling]
      return fallback === undefined ? [] : [fallback]
    })
  }
  return fallback === undefined ? [] : [fallback]
}

/**
 * The settings mutations that put a route under a chosen window.
 * @param entry - the route joined with its profile and disclosed capacities.
 * @param target - the window the user picked.
 * @returns path operations for this route, addressed from its namespace root.
 */
export function planRoute(entry: RouteProfile, target: number): PathOp[] {
  const at = (...tail: string[]): string[] => [...entry.route.settingsPath, ...tail]
  const ops: PathOp[] = [{ op: 'set', path: at('defaultContextWindow'), value: target }]
  const ceilings = ceilingMap(entry)
  const rows = modelRows(entry.profile)

  if (rows !== undefined) {
    // A models list replaces the served catalog, so every capacity has to be
    // written back on the rows themselves; the list is stored whole because a
    // user-layer array replaces the layer below it rather than merging into it.
    ops.push({
      op: 'set',
      path: at('models'),
      value: rows.map((row) => {
        const id = typeof row['id'] === 'string' ? row['id'] : undefined
        const ceiling = id === undefined ? undefined : ceilings.get(id)
        return { ...row, contextWindow: effectiveWindow(target, ceiling) }
      }),
    })
    return ops
  }

  for (const [id, ceiling] of ceilings) {
    const existing = overrideEntry(entry.profile, id)
    if (ceiling > target) {
      ops.push({ op: 'set', path: at('modelOverrides', id, 'contextWindow'), value: target })
      continue
    }
    // The catalog already holds a window at or below the target, so an override
    // would only restate it — and removing ours is how a larger choice lets the
    // native capacity come back.
    if (existing?.['contextWindow'] === undefined) continue
    ops.push(Object.keys(existing).length === 1
      ? { op: 'unset', path: at('modelOverrides', id) }
      : { op: 'unset', path: at('modelOverrides', id, 'contextWindow') })
  }

  for (const id of obsoleteOverrideIds(entry)) {
    // An override naming a model the catalog does not describe is refused
    // outright, and that refusal takes the whole route down with it — every
    // other field on the entry included. A catalog upgrade that drops a model
    // is how a profile ends up here, so clearing the dead entry is what lets
    // the route load and be written again.
    ops.push({ op: 'unset', path: at('modelOverrides', id) })
  }
  return ops
}

/**
 * The settings mutations that apply per-model window choices to one route.
 * Each model gets its own target; a model absent from the map keeps its current
 * value. The `defaultContextWindow` is set to the most common target among the
 * specified models so models without a custom choice get a reasonable default.
 *
 * @param entry - the route joined with its profile and disclosed capacities.
 * @param modelWindows - per-model target windows (only models whose values differ
 * from the current effective window need to be listed).
 * @returns path operations for this route, addressed from its namespace root.
 */
export function planRouteWithModels(
  entry: RouteProfile,
  modelWindows: ReadonlyMap<string, number>,
): PathOp[] {
  const at = (...tail: string[]): string[] => [...entry.route.settingsPath, ...tail]
  const ops: PathOp[] = []
  const ceilings = ceilingMap(entry)
  const rows = modelRows(entry.profile)

  // For catalog routes (no custom models list), use modelOverrides.
  if (rows === undefined) {
    const { defaultContextWindow: currentDefault } = asProfile(entry.profile)
    const currentDefaultNum = typeof currentDefault === 'number'
      && Number.isSafeInteger(currentDefault) && currentDefault > 0
      ? currentDefault
      : undefined

    // Determine the new default: most common target among specified models,
    // falling back to current default.
    const targetCounts = new Map<number, number>()
    for (const [, target] of modelWindows) {
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1)
    }
    let newDefault = currentDefaultNum
    if (modelWindows.size > 0) {
      let maxCount = 0
      for (const [target, count] of targetCounts) {
        if (count > maxCount) { maxCount = count; newDefault = target }
      }
    }
    // Ensure newDefault is always defined (fallback to 256K).
    if (newDefault === undefined) newDefault = 262_144
    ops.push({ op: 'set', path: at('defaultContextWindow'), value: newDefault })

    // For each model with a specified target, decide whether to set or remove
    // the override. The natural effective value (without override) is:
    //   min(default, ceiling) when ceiling known, else default.
    // We need an override only when target != natural effective value.
    for (const [id, target] of modelWindows) {
      const ceiling = ceilings.get(id)
      const naturalEffective = ceiling !== undefined ? Math.min(newDefault, ceiling) : newDefault
      const existing = overrideEntry(entry.profile, id)

      if (target === naturalEffective) {
        // Target matches natural value — no override needed, remove existing one.
        if (existing?.['contextWindow'] !== undefined) {
          ops.push(Object.keys(existing).length === 1
            ? { op: 'unset', path: at('modelOverrides', id) }
            : { op: 'unset', path: at('modelOverrides', id, 'contextWindow') })
        }
      } else {
        // Target differs — write override.
        ops.push({ op: 'set', path: at('modelOverrides', id, 'contextWindow'), value: target })
      }
    }

    // Clean up obsolete overrides (models no longer in the catalog).
    for (const id of obsoleteOverrideIds(entry)) {
      if (!modelWindows.has(id)) {
        ops.push({ op: 'unset', path: at('modelOverrides', id) })
      }
    }
  } else {
    // Custom models list: update rows in place.
    const targetOrDefault = newDefaultForRows(modelWindows, entry)
    ops.push({ op: 'set', path: at('defaultContextWindow'), value: targetOrDefault })
    ops.push({
      op: 'set',
      path: at('models'),
      value: rows.map((row) => {
        const id = typeof row['id'] === 'string' ? row['id'] : undefined
        const ceiling = id === undefined ? undefined : ceilings.get(id)
        const target = id !== undefined ? modelWindows.get(id) : undefined
        const resolved = target ?? effectiveWindow(targetOrDefault, ceiling)
        return { ...row, contextWindow: effectiveWindow(resolved, ceiling) }
      }),
    })
  }
  return ops
}

/**
 * Compute the default context window for routes with custom models[] when
 * per-model targets are specified.
 */
function newDefaultForRows(
  modelWindows: ReadonlyMap<string, number>,
  entry: RouteProfile,
): number {
  const { defaultContextWindow: currentDefault } = asProfile(entry.profile)
  const currentDefaultNum = typeof currentDefault === 'number'
    && Number.isSafeInteger(currentDefault) && currentDefault > 0
    ? currentDefault
    : 262_144

  const targetCounts = new Map<number, number>()
  for (const [, target] of modelWindows) {
    targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1)
  }
  let best = currentDefaultNum
  let maxCount = 0
  for (const [target, count] of targetCounts) {
    if (count > maxCount) { maxCount = count; best = target }
  }
  return best
}
