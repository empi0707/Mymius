import { useSyncExternalStore } from 'react'
import { getSnapshot, setActivities, subscribe, type Activity } from './activity-core'

export { filesActivities, setActivities, summarize, type Activity } from './activity-core'

export function useActivities(): Activity[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

if (import.meta.env.MODE === 'e2e') {
  // Lets the end-to-end tests drive the bar deterministically; not present in a real build.
  ;(window as unknown as { __mymiusActivity: unknown }).__mymiusActivity = { setActivities }
}
