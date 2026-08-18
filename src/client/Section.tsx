/**
 * The operating-window settings page: per-model context window controls
 * grouped by provider. Each provider group is collapsible (default collapsed)
 * and contains per-model dropdown selectors with a save button at the bottom.
 */
import { useCallback, useEffect, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCapacity } from './capacity.ts'
import { writeFailureText } from './failure.ts'
import { fill, type OperatingContextKey } from './locales.ts'
import { RouteRow } from './RouteRow.tsx'
import styles from './Section.module.css'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { OperatingContextState, OperatingContextStore } from './store.ts'

/** Injected dependencies of {@link OperatingContextSection}. */
export interface OperatingContextInjected {
  controller: OperatingContextStore
  useSnapshot: SnapshotSelectorHook<OperatingContextState>
  t: (key: OperatingContextKey) => string
}

/** Props delivered by the slot outlet, which cannot promise the inject face. */
export type OperatingContextSectionProps = Partial<OperatingContextInjected>

/**
 * Compute the baseline effective window per model for one route entry.
 * This reads the current effective value from the profile (override >> default).
 */
function computeBaseline(entry: { profile: unknown; discovered: readonly { id: string }[] }): Map<string, number> {
  const baseline = new Map<string, number>()
  if (typeof entry.profile !== 'object' || entry.profile === null) return baseline

  const { modelOverrides, defaultContextWindow } = entry.profile as Record<string, unknown>
  const defaultNum = typeof defaultContextWindow === 'number'
    && Number.isSafeInteger(defaultContextWindow) && defaultContextWindow > 0
    ? defaultContextWindow
    : undefined

  for (const model of entry.discovered) {
    let value = defaultNum
    if (typeof modelOverrides === 'object' && modelOverrides !== null) {
      const override = (modelOverrides as Record<string, unknown>)[model.id]
      if (typeof override === 'object' && override !== null) {
        const cw = (override as Record<string, unknown>)['contextWindow']
        if (typeof cw === 'number') value = cw
      }
    }
    if (value !== undefined) {
      baseline.set(model.id, value)
    }
  }
  return baseline
}

/**
 * Render the operating-window section.
 * @param props - inject face from the client apply closure.
 * @returns the section, or nothing until the outlet supplies its dependencies.
 */
export function OperatingContextSection(props: OperatingContextSectionProps): ReactNode {
  const { controller, useSnapshot, t } = props
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} t={t} />
}

function Loaded({ controller, useSnapshot, t }: OperatingContextInjected): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  const handleSave = useCallback((routeKey: string, modelWindows: Map<string, number>) => {
    void controller.applyModels(routeKey, modelWindows)
  }, [controller])

  if (state.status === 'error') {
    return (
      <div className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.error}>{`${t('loadFailed')} ${state.error?.message ?? ''}`}</p>
        <div className={styles.actions}>
          <Button variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button>
        </div>
      </div>
    )
  }

  if (state.status !== 'ready') {
    return (
      <div className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.intro}>{t('intro')}</p>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>

      {state.routes.length === 0 ? (
        <p className={styles.notice}>{t('noRoutes')}</p>
      ) : (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.label}>{t('providerGroupLabel')}</span>
            {state.current !== undefined ? (
              <span className={styles.current}>
                {fill(t('current'), { window: formatCapacity(state.current) })}
              </span>
            ) : null}
          </div>

          <ul className={styles.routes}>
            {state.routes.map(entry => (
              <RouteRow
                key={entry.key}
                displayName={entry.route.displayName}
                models={entry.discovered}
                baseline={computeBaseline(entry)}
                ceilingsKnown={entry.ceilingsKnown}
                routeKey={entry.key}
                saveStatus={state.routeSaveResult[entry.key] ?? null}
                saveError={state.routeSaveError[entry.key] ?? null}
                onSave={handleSave}
                t={t}
              />
            ))}
          </ul>
        </div>
      )}

      {state.status === 'ready' && !state.writable
        ? <p className={styles.notice}>{t('readOnly')}</p>
        : null}
      {state.writeFailure === null ? null : (
        <p className={styles.error}>{writeFailureText(state.writeFailure, t)}</p>
      )}
    </div>
  )
}
