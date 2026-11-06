export interface BackupSummary {
  path: string
  createdAt: string
  files: number
  bytes: number
  counts: Record<string, number>
  /** Which of the two helper databases this backup carries; empty for version 1 backups. */
  libraries?: Array<'knowledge' | 'profile'>
}
