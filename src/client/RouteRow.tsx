/**
 * One provider group: collapsible section containing model rows, each with a
 * dropdown selector for context window. A save button at the bottom applies
 * changes for this provider only.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, DisclosureRow, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCapacity, presetLabel, WINDOW_PRESETS } from './capacity.ts'
import { fill, type OperatingContextKey } from './locales.ts'
import styles from './Section.module.css'
import type { DiscoveredModel } from './api.ts'

/** Props of {@link RouteRow}. */
export interface RouteRowProps {
  displayName: string
  /** Discovered models for this route. */
  models: readonly DiscoveredModel[]
  /** Current effective window per model id. */
  baseline: ReadonlyMap<string, number>
  /** Whether this route has unknown ceilings. */
  ceilingsKnown: boolean
  /** Route key for save tracking. */
  routeKey: string
  /** Current save status for this route. */
  saveStatus: 'saving' | 'ok' | null
  /** Current save error for this route. */
  saveError: string | null
  /** Callback to start saving this route. */
  onSave: (routeKey: string, modelWindows: Map<string, number>) => void
  t: (key: OperatingContextKey) => string
}

/**
 * Render one provider group with per-model window controls.
 */
export function RouteRow(props: RouteRowProps): ReactNode {
  const { displayName, models, baseline, ceilingsKnown, routeKey, saveStatus, saveError, onSave, t } = props
  const [open, setOpen] = useState(false)

  // Per-model draft windows: undefined means "not yet opened/selected"
  const [drafts, setDrafts] = useState<Map<string, number | undefined>>(() => {
    const m = new Map<string, number | undefined>()
    for (const model of models) m.set(model.id, undefined)
    return m
  })

  // Track which models have been modified from their baseline
  const getModified = useCallback((): Map<string, number> => {
    const modified = new Map<string, number>()
    for (const model of models) {
      const draft = drafts.get(model.id)
      const current = baseline.get(model.id)
      if (draft !== undefined && draft !== current) {
        modified.set(model.id, draft)
      }
    }
    return modified
  }, [drafts, models, baseline])

  const hasChanges = getModified().size > 0
  const isSaving = saveStatus === 'saving'

  const handleSave = useCallback(() => {
    const modified = getModified()
    if (modified.size > 0) {
      onSave(routeKey, modified)
    }
  }, [getModified, onSave, routeKey])

  const updateDraft = (modelId: string, value: number | undefined): void => {
    setDrafts(prev => new Map(prev).set(modelId, value))
  }

  return (
    <li className={styles.route}>
      <DisclosureRow
        icon={<IconChevronDownOutline14 />}
        title={displayName}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(current => !current)}
        titleClassName={styles.routeName}
        className={styles.routeHead}
      >
        <div className={styles.routeSummary}>
          {fill(t('providerModelsLabel'), { count: String(models.length) })}
          {saveStatus === 'ok' ? <span className={styles.saved}> {t('providerSaved')}</span> : null}
          {saveError ? <span className={styles.error}> {fill(t('providerSaveFailed'), { message: saveError })}</span> : null}
        </div>
      </DisclosureRow>

      {open ? (
        <div className={styles.modelsSection}>
          <ul className={styles.models}>
            {models.map((model) => (
              <ModelSelector
                key={model.id}
                model={model}
                baseline={baseline.get(model.id)}
                draft={drafts.get(model.id)}
                onChange={(value) => updateDraft(model.id, value)}
                t={t}
              />
            ))}
          </ul>

          <div className={styles.routeActions}>
            <Button
              variant="primary"
              size="sm"
              disabled={!hasChanges || isSaving}
              onClick={() => { void handleSave() }}
            >
              {isSaving ? t('providerSaving') : t('providerSave')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** Props of {@link ModelSelector}. */
interface ModelSelectorProps {
  model: DiscoveredModel
  baseline: number | undefined
  draft: number | undefined
  onChange: (value: number | undefined) => void
  t: (key: OperatingContextKey) => string
}

/** Render one model row with a dropdown selector for context window. */
function ModelSelector({ model, baseline, draft, onChange, t }: ModelSelectorProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const containerRef = useRef<HTMLLIElement>(null)

  // The effective selected value: draft if set, otherwise baseline
  const selectedValue = draft ?? baseline
  const isModified = draft !== undefined && draft !== baseline

  // Compute display text for the current selection
  const displayText = selectedValue !== undefined
    ? formatCapacity(selectedValue)
    : t('modelDropdownPlaceholder')

  // Check if current selection is a preset
  const isPreset = selectedValue !== undefined && presetLabel(selectedValue) !== undefined

  // Sync custom text when opening
  const handleToggle = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen && !isPreset && selectedValue !== undefined) {
      setCustomText(formatCapacity(selectedValue))
    }
  }

  return (
    <li className={styles.model} ref={containerRef}>
      <span className={styles.modelId}>{model.id}</span>

      <div className={styles.modelSelector}>
        <button
          className={`${styles.dropdownTrigger} ${isModified ? styles.modified : ''}`}
          onClick={() => handleToggle(!open)}
          type="button"
        >
          <span className={styles.dropdownValue}>{displayText}</span>
          <IconChevronDownOutline14 size={14} />
        </button>

        {open ? (
          <div className={styles.dropdownMenu}>
            <div className={styles.dropdownPresets}>
              {WINDOW_PRESETS.map(preset => (
                <button
                  key={preset.label}
                  className={`${styles.dropdownItem} ${selectedValue === preset.tokens ? styles.selected : ''}`}
                  onClick={() => {
                    onChange(preset.tokens)
                    handleToggle(false)
                  }}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className={styles.dropdownCustom}>
              <span className={styles.dropdownCustomLabel}>{t('modelDropdownCustom')}</span>
              <input
                className={styles.dropdownCustomInput}
                value={customText}
                placeholder="e.g. 128K"
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const parsed = parseCapacityFromInput(customText)
                    if (parsed !== undefined) {
                      onChange(parsed)
                      handleToggle(false)
                    }
                  }
                }}
                onBlur={() => {
                  // Apply custom value on blur if valid
                  const parsed = parseCapacityFromInput(customText)
                  if (parsed !== undefined && parsed !== selectedValue) {
                    onChange(parsed)
                  }
                  handleToggle(false)
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Show ceiling hint when known */}
      {model.contextWindow !== undefined ? (
        <span className={styles.modelCeiling}>
          {fill(t('modelCeiling'), { window: formatCapacity(model.contextWindow) })}
        </span>
      ) : null}
    </li>
  )
}

/** Parse a custom capacity input like "128K" or "256000". */
function parseCapacityFromInput(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([kmKM])?$/
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.parseInt(trimmed, 10)
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1
  const value = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
