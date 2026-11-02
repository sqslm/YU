/** Clipped snapshot of the focused control, produced by the native UIA reader. */
export interface UiaSnapshot {
  controlType: string
  /** Official UIA ID: Edit=50004, Document=50030. */
  controlTypeId: number
  className: string
  automationId: string
  name: string
  /** Tail of the value, at most 4000 UTF-16 units without a split surrogate pair. */
  value: string
  valueTruncated: boolean
  readOnly: boolean
}
