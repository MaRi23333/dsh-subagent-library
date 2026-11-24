import type { Context } from '@deepseek-ai/cordis'

interface ModelRoute {
  provider: string
  model: string
}

interface Parent {
  options?: Partial<ModelRoute>
  session?: { requestHeader?(): { config?: Partial<ModelRoute> } | undefined }
}

const POLICY_KEY = 'subagentModelSelectionPolicy'

function isModelId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPolicy(state: unknown): state is readonly ModelRoute[] {
  if (!Array.isArray(state) || state.length === 0) return false
  const seen = new Set<string>()
  for (const route of state as unknown[]) {
    if (typeof route !== 'object' || route === null || Array.isArray(route)
      || Object.keys(route).length !== 2
      || !Object.hasOwn(route, 'provider') || !Object.hasOwn(route, 'model')) return false
    const { provider, model } = route as Partial<ModelRoute>
    if (!isModelId(provider) || !isModelId(model)) return false
    const key = JSON.stringify([provider, model])
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/** Enforce the official session policy for an explicit child model override. */
export function assertSessionModelAllowed(ctx: Context, parent: Parent, route: ModelRoute): void {
  const unavailable = () => new Error('Cannot verify the official subagent model-selection policy for this session. Omit provider, model, and reasoning_effort to use the role\'s saved model.')
  const { provider, model } = route
  if (!isModelId(provider) || !isModelId(model)) throw new Error('The child LLM provider and model must be non-empty.')
  if (!parent.session) throw unavailable()

  let policy: unknown
  try {
    // The host's compatibility reader returns undefined for an unregistered key.
    // Only the official projection's initial state (null) permits a parent-route fallback.
    const projections = ctx.get('sessionProjections') as { stateOf?(session: Parent['session'], key: string): unknown } | undefined
    policy = projections?.stateOf?.(parent.session, POLICY_KEY)
  } catch {
    throw unavailable()
  }

  const denied = `Child LLM route "${provider}/${model}" is not allowed for this session.`
  if (policy === null) {
    const requested = parent.session.requestHeader?.()?.config
    const current = requested === undefined ? parent.options : requested
    if (provider === current?.provider && model === current.model) return
    throw new Error(`${denied} Explicit overrides are limited to the current parent model. In the Subagent model selection page, select the allowed models, save, and start a new parent session.`)
  }
  if (!isPolicy(policy)) throw unavailable()
  if (!policy.some(allowed => allowed.provider === provider && allowed.model === model)) {
    throw new Error(`${denied} Check list_subagent_models if available, or select the model in Subagent model selection, save, and start a new parent session.`)
  }
}
