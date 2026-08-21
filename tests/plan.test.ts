import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commonRequestedWindow,
  effectiveWindows,
  modelBaselines,
  obsoleteOverrideIds,
  planRoute,
  planRouteWithModels,
  profileModels,
  type RouteProfile,
} from '../src/client/plan.ts'
import type { DiscoveredModel, ProviderTarget } from '../src/client/api.ts'

function route(settingsNs: string, settingsPath: string[], declared?: boolean): ProviderTarget {
  return {
    provider: 'demo',
    displayName: 'Demo',
    settingsNs,
    settingsPath,
    active: true,
    ...declared === undefined ? {} : { declared },
  }
}

function entry(overrides: {
  settingsNs?: string
  settingsPath?: string[]
  declared?: boolean
  profile: unknown
  discovered?: readonly DiscoveredModel[]
  ceilingsKnown?: boolean
}): RouteProfile {
  return {
    route: route(overrides.settingsNs ?? 'llm-pi-ai', overrides.settingsPath ?? ['providers', 'demo'], overrides.declared ?? false),
    profile: overrides.profile,
    discovered: overrides.discovered ?? [],
    ceilingsKnown: overrides.ceilingsKnown ?? true,
  }
}

test('a catalog route with no models list is capped through modelOverrides', () => {
  // This is the shape that made writing defaultContextWindow alone inert: the
  // models come from the installed catalog, whose capacity outranks the route
  // default, so only an entry-level override changes anything.
  const ops = planRoute(entry({
    profile: { apiKeyEnv: 'DEMO_KEY', defaultContextWindow: 1_000_000 },
    discovered: [
      { id: 'big', contextWindow: 1_000_000 },
      { id: 'small', contextWindow: 256_000 },
    ],
  }), 400_000)

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'defaultContextWindow'], value: 400_000 },
    { op: 'set', path: ['providers', 'demo', 'modelOverrides', 'big', 'contextWindow'], value: 400_000 },
  ])
})

test('a model already at or below the chosen window is left alone', () => {
  const ops = planRoute(entry({
    profile: { defaultContextWindow: 400_000 },
    discovered: [{ id: 'small', contextWindow: 128_000 }],
  }), 400_000)

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'defaultContextWindow'], value: 400_000 },
  ])
})

test('choosing a window at the ceiling removes the override this plugin wrote', () => {
  const ops = planRoute(entry({
    profile: {
      defaultContextWindow: 400_000,
      modelOverrides: { big: { contextWindow: 400_000 } },
    },
    discovered: [{ id: 'big', contextWindow: 1_000_000 }],
  }), 1_000_000)

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'defaultContextWindow'], value: 1_000_000 },
    { op: 'unset', path: ['providers', 'demo', 'modelOverrides', 'big'] },
  ])
})

test('removing a capacity override keeps the other fields on that entry', () => {
  const ops = planRoute(entry({
    profile: {
      modelOverrides: { big: { contextWindow: 400_000, maxTokens: 8192 } },
    },
    discovered: [{ id: 'big', contextWindow: 1_000_000 }],
  }), 1_000_000)

  assert.deepEqual(ops[1], {
    op: 'unset',
    path: ['providers', 'demo', 'modelOverrides', 'big', 'contextWindow'],
  })
})

test('an override the catalog no longer describes is cleared, not left to wedge the route', () => {
  const profile = entry({
    profile: {
      modelOverrides: {
        big: { contextWindow: 400_000 },
        retired: { contextWindow: 400_000, maxTokens: 8192 },
      },
    },
    discovered: [{ id: 'big', contextWindow: 1_000_000 }],
  })
  const ops = planRoute(profile, 400_000)

  assert.deepEqual(obsoleteOverrideIds(profile), ['retired'])

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'defaultContextWindow'], value: 400_000 },
    { op: 'set', path: ['providers', 'demo', 'modelOverrides', 'big', 'contextWindow'], value: 400_000 },
    { op: 'unset', path: ['providers', 'demo', 'modelOverrides', 'retired'] },
  ])
})

test('a route whose ceilings are unknown keeps its overrides untouched', () => {
  const profile = entry({
    declared: true,
    ceilingsKnown: false,
    profile: { modelOverrides: { anything: { contextWindow: 400_000 } } },
  })
  const ops = planRoute(profile, 200_000)

  assert.deepEqual(obsoleteOverrideIds(profile), [])

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'defaultContextWindow'], value: 200_000 },
  ])
})

test('a route with a models list is written on its rows, never through overrides', () => {
  const ops = planRoute(entry({
    settingsNs: 'llm-deepseek',
    settingsPath: [],
    ceilingsKnown: false,
    profile: {
      defaultContextWindow: 1_000_000,
      models: [
        { id: 'chat', contextWindow: 1_000_000, maxTokens: 256_000 },
        { id: 'reasoner', contextWindow: 1_000_000 },
      ],
    },
  }), 256_000)

  assert.deepEqual(ops, [
    { op: 'set', path: ['defaultContextWindow'], value: 256_000 },
    {
      op: 'set',
      path: ['models'],
      value: [
        { id: 'chat', contextWindow: 256_000, maxTokens: 256_000 },
        { id: 'reasoner', contextWindow: 256_000 },
      ],
    },
  ])
})

test('rows are clamped per model when the catalog discloses their ceilings', () => {
  const ops = planRoute(entry({
    profile: { models: [{ id: 'big' }, { id: 'small' }] },
    discovered: [
      { id: 'big', contextWindow: 1_000_000 },
      { id: 'small', contextWindow: 200_000 },
    ],
  }), 400_000)

  assert.deepEqual(ops[1], {
    op: 'set',
    path: ['providers', 'demo', 'models'],
    value: [
      { id: 'big', contextWindow: 400_000 },
      { id: 'small', contextWindow: 200_000 },
    ],
  })
})

test('a hand-declared route can only be given the route default', () => {
  const ops = planRoute(entry({
    declared: true,
    ceilingsKnown: false,
    profile: { apiKeyEnv: 'DEMO_KEY', baseURL: 'https://gateway.example' },
  }), 200_000)

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'defaultContextWindow'], value: 200_000 },
  ])
})

test('effectiveWindows reports what the adapter resolves, not what is stored', () => {
  // An override wins, then the catalog, then the route default — so a route
  // whose default says 400K while its catalog says 256K reports 256K.
  assert.deepEqual(effectiveWindows(entry({
    profile: {
      defaultContextWindow: 400_000,
      modelOverrides: { patched: { contextWindow: 128_000 } },
    },
    discovered: [
      { id: 'patched', contextWindow: 1_000_000 },
      { id: 'catalog', contextWindow: 256_000 },
      { id: 'silent' },
    ],
  })), [128_000, 256_000, 400_000])
})

test('effectiveWindows reads a models list off its rows', () => {
  assert.deepEqual(effectiveWindows(entry({
    ceilingsKnown: false,
    profile: {
      defaultContextWindow: 400_000,
      models: [{ id: 'a', contextWindow: 256_000 }, { id: 'b' }],
    },
  })), [256_000, 400_000])
})

test('effectiveWindows falls back to the route default alone', () => {
  assert.deepEqual(effectiveWindows(entry({
    ceilingsKnown: false,
    profile: { defaultContextWindow: 200_000 },
  })), [200_000])
  assert.deepEqual(effectiveWindows(entry({
    ceilingsKnown: false,
    profile: { apiKeyEnv: 'DEMO_KEY' },
  })), [])
})

test('catalog planning is identical for OpenCode, Kimi Coding, and Anthropic', () => {
  for (const provider of ['opencode', 'kimi-coding', 'anthropic']) {
    const profile: RouteProfile = {
      route: {
        provider,
        displayName: provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
        active: true,
        declared: false,
      },
      profile: {
        apiKeyEnv: `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`,
        defaultContextWindow: 1_000_000,
      },
      discovered: [
        { id: `${provider}-large`, contextWindow: 1_000_000 },
        { id: `${provider}-small`, contextWindow: 200_000 },
      ],
      ceilingsKnown: true,
    }

    assert.deepEqual(planRoute(profile, 400_000), [
      {
        op: 'set',
        path: ['providers', provider, 'defaultContextWindow'],
        value: 400_000,
      },
      {
        op: 'set',
        path: ['providers', provider, 'modelOverrides', `${provider}-large`, 'contextWindow'],
        value: 400_000,
      },
    ], `${provider} should be planned from its route metadata, not a provider allow-list`)
  }
})

test('an unknown hand-declared provider preserves its endpoint and model metadata', () => {
  const profile: RouteProfile = {
    route: {
      provider: 'private-anthropic-gateway',
      displayName: 'Private Anthropic Gateway',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'private-anthropic-gateway'],
      active: true,
      declared: true,
    },
    profile: {
      api: 'anthropic-messages',
      apiKeyEnv: 'PRIVATE_ANTHROPIC_KEY',
      baseURL: 'https://gateway.example/v1',
      models: [
        { id: 'claude-private-large', name: 'Private Large', contextWindow: 800_000, maxTokens: 64_000 },
        { id: 'claude-private-small', name: 'Private Small', maxTokens: 8_000 },
      ],
    },
    discovered: [],
    ceilingsKnown: false,
  }

  assert.deepEqual(planRoute(profile, 400_000), [
    {
      op: 'set',
      path: ['providers', 'private-anthropic-gateway', 'defaultContextWindow'],
      value: 400_000,
    },
    {
      op: 'set',
      path: ['providers', 'private-anthropic-gateway', 'models'],
      value: [
        { id: 'claude-private-large', name: 'Private Large', contextWindow: 400_000, maxTokens: 64_000 },
        { id: 'claude-private-small', name: 'Private Small', contextWindow: 400_000, maxTokens: 8_000 },
      ],
    },
  ])
})

test('the common requested window survives legitimate per-model clamps', () => {
  const routes = [
    entry({
      profile: {
        defaultContextWindow: 400_000,
        modelOverrides: { large: { contextWindow: 400_000 } },
      },
      discovered: [
        { id: 'large', contextWindow: 1_000_000 },
        { id: 'small', contextWindow: 256_000 },
      ],
    }),
    entry({
      settingsPath: ['providers', 'second'],
      profile: { defaultContextWindow: 400_000 },
      discovered: [{ id: 'small', contextWindow: 128_000 }],
    }),
  ]

  assert.equal(commonRequestedWindow(routes), 400_000)
  assert.deepEqual(routes.flatMap(route => effectiveWindows(route)), [400_000, 256_000, 128_000])
})

test('a saved choice is only inferred when every route carries the same valid marker', () => {
  assert.equal(commonRequestedWindow([
    entry({ profile: { defaultContextWindow: 400_000 } }),
    entry({ settingsPath: ['providers', 'second'], profile: { defaultContextWindow: 256_000 } }),
  ]), undefined)
  assert.equal(commonRequestedWindow([
    entry({ profile: { defaultContextWindow: 400_000 } }),
    entry({ settingsPath: ['providers', 'second'], profile: {} }),
  ]), undefined)
  assert.equal(commonRequestedWindow([]), undefined)
})

test('profileModels reads the models a profile declares, skipping rows without an id', () => {
  assert.deepEqual(profileModels({
    defaultContextWindow: 128_000,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 128_000 },
    ],
  }), [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 128_000 },
  ])
  assert.deepEqual(profileModels({ models: [{ name: 'no-id' }, { id: 7 }] }), [])
  assert.deepEqual(profileModels({ apiKeyEnv: 'DEMO_KEY' }), [])
  assert.deepEqual(profileModels(undefined), [])
})

test('profileModels preserves fields beyond id/name/contextWindow on the row', () => {
  const models = profileModels({
    models: [{ id: 'vision', name: 'Vision', contextWindow: 200_000, maxTokens: 4_096, foo: 'bar' }],
  })
  assert.deepEqual(models, [{ id: 'vision', name: 'Vision', contextWindow: 200_000 }])
})

test('modelBaselines reports the window in force on a profile models list', () => {
  // Row-level contextWindow is the current value; a row without one falls back
  // to the route default.
  assert.deepEqual([...modelBaselines(entry({
    ceilingsKnown: false,
    profile: {
      defaultContextWindow: 400_000,
      models: [{ id: 'a', contextWindow: 256_000 }, { id: 'b' }],
    },
  }))], [['a', 256_000], ['b', 400_000]])
})

test('modelBaselines reads override, then ceiling, then default on catalog routes', () => {
  const baselines = modelBaselines(entry({
    ceilingsKnown: true,
    profile: {
      defaultContextWindow: 400_000,
      modelOverrides: { patched: { contextWindow: 128_000 } },
    },
    discovered: [
      { id: 'patched', contextWindow: 1_000_000 },
      { id: 'catalog', contextWindow: 256_000 },
      { id: 'silent' },
    ],
  }))
  assert.deepEqual([...baselines], [['patched', 128_000], ['catalog', 256_000], ['silent', 400_000]])
})

test('modelBaselines is empty when nothing resolves a window', () => {
  assert.deepEqual([...modelBaselines(entry({
    ceilingsKnown: false,
    profile: { apiKeyEnv: 'DEMO_KEY' },
    discovered: [],
  }))], [])
})

// ---------------------------------------------------------------------------
// planRouteWithModels — strict per-model semantics
// ---------------------------------------------------------------------------

test('editing one catalog model writes only that override and never the default', () => {
  const ops = planRouteWithModels(
    entry({
      profile: { defaultContextWindow: 1_000_000, modelOverrides: {} },
      discovered: [
        { id: 'model-a', contextWindow: 1_000_000 },
        { id: 'model-b', contextWindow: 1_000_000 },
        { id: 'model-c', contextWindow: 1_000_000 },
      ],
      ceilingsKnown: true,
    }),
    new Map([['model-a', 256_000]]),
  )

  // The shared default must never be rewritten by a single-model edit.
  assert.ok(!ops.some(op => op.op === 'set' && op.path.includes('defaultContextWindow')))
  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'modelOverrides', 'model-a', 'contextWindow'], value: 256_000 },
  ])
})

test('editing one catalog model does not touch modelOverrides of the others', () => {
  const ops = planRouteWithModels(
    entry({
      profile: {
        defaultContextWindow: 400_000,
        modelOverrides: { 'model-b': { contextWindow: 128_000 } },
      },
      discovered: [
        { id: 'model-a', contextWindow: 1_000_000 },
        { id: 'model-b', contextWindow: 1_000_000 },
        { id: 'model-c', contextWindow: 1_000_000 },
      ],
      ceilingsKnown: true,
    }),
    new Map([['model-a', 256_000]]),
  )

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'modelOverrides', 'model-a', 'contextWindow'], value: 256_000 },
  ])
})

test('a catalog override is clamped to the model ceiling', () => {
  const ops = planRouteWithModels(
    entry({
      profile: {
        defaultContextWindow: 1_000_000,
        modelOverrides: { 'model-a': { contextWindow: 128_000 } },
      },
      discovered: [{ id: 'model-a', contextWindow: 200_000 }],
      ceilingsKnown: true,
    }),
    new Map([['model-a', 400_000]]),
  )

  // 400K exceeds the 200K ceiling, so the override is clamped to 200K. It is
  // still written because the model currently holds 128K, not the ceiling.
  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'modelOverrides', 'model-a', 'contextWindow'], value: 200_000 },
  ])
})

test('a target above the ceiling that matches the current value is a no-op', () => {
  const ops = planRouteWithModels(
    entry({
      profile: { defaultContextWindow: 1_000_000, modelOverrides: {} },
      discovered: [{ id: 'model-a', contextWindow: 200_000 }],
      ceilingsKnown: true,
    }),
    new Map([['model-a', 400_000]]),
  )

  // The clamp lands on 200K, which the model already holds via its ceiling —
  // writing a redundant override would add nothing, so no operation is emitted.
  assert.deepEqual(ops, [])
})

test('a catalog override with an unknown ceiling is capped at 1024K', () => {
  const ops = planRouteWithModels(
    entry({
      profile: { defaultContextWindow: 400_000, modelOverrides: {} },
      discovered: [{ id: 'model-a' }],
      ceilingsKnown: true,
    }),
    new Map([['model-a', 2_000_000]]),
  )

  assert.deepEqual(ops, [
    { op: 'set', path: ['providers', 'demo', 'modelOverrides', 'model-a', 'contextWindow'], value: 1_024_000 },
  ])
})

test('a target equal to the natural value removes a stale override and writes nothing new', () => {
  const ops = planRouteWithModels(
    entry({
      profile: {
        defaultContextWindow: 400_000,
        modelOverrides: { 'model-a': { contextWindow: 400_000 } },
      },
      discovered: [{ id: 'model-a', contextWindow: 1_000_000 }],
      ceilingsKnown: true,
    }),
    new Map([['model-a', 400_000]]),
  )

  // natural value = min(400_000 default, 1_000_000 ceiling) = 400_000 == target,
  // so the redundant override is removed, not restated.
  assert.deepEqual(ops, [
    { op: 'unset', path: ['providers', 'demo', 'modelOverrides', 'model-a'] },
  ])
})

test('editing one model on a models[] route touches only that row and never the default', () => {
  const ops = planRouteWithModels(
    entry({
      ceilingsKnown: false,
      profile: {
        defaultContextWindow: 400_000,
        models: [
          { id: 'claude-large', name: 'Large', contextWindow: 800_000, maxTokens: 64_000 },
          { id: 'claude-small', name: 'Small', contextWindow: 200_000, maxTokens: 8_000 },
        ],
      },
    }),
    new Map([['claude-large', 1_000_000]]),
  )

  // No defaultContextWindow write; only the edited row changes (capped at
  // 1024K because ceilings are unknown); the other row is untouched.
  assert.ok(!ops.some(op => op.op === 'set' && op.path.includes('defaultContextWindow')))
  assert.deepEqual(ops, [
    {
      op: 'set',
      path: ['providers', 'demo', 'models'],
      value: [
        { id: 'claude-large', name: 'Large', contextWindow: 1_000_000, maxTokens: 64_000 },
        { id: 'claude-small', name: 'Small', contextWindow: 200_000, maxTokens: 8_000 },
      ],
    },
  ])
})
