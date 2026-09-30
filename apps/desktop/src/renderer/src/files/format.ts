export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function formatDate(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '' : dateFmt.format(new Date(ms))
}
