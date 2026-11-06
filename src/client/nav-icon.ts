import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { LibraryNavIcon } from './icon.tsx'

// Backport the DSH 0.2.2 contract to the older development-only slot types.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section.icon': {
      kind: 'list'
      scope: 'root'
      owner: { size: number; active: boolean }
    }
  }
}

export function registerSettingsNavIcon(ctx: Pick<ClientContext, 'slots'>): void {
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: 'subagent-library',
  }, LibraryNavIcon))
}
