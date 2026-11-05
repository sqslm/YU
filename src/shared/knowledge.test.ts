import { describe, expect, it } from 'vitest'

import { sourceIdentityOf } from './knowledge'

/**
 * A delete preview must answer for the whole record. Reading a bare id as one
 * source is how the confirm dialog came to warn「无法预览关联知识」and count zero
 * cards for a thread that really had one.
 */
describe('naming the record a delete is about', () => {
  it('turns the record the user named into the identity the helper knows', () => {
    expect(sourceIdentityOf({ threadId: 't1' })).toEqual({ channel: 'chat', groupKey: 't1' })
    expect(sourceIdentityOf({ noteId: 'n1' })).toEqual({ channel: 'note', originRef: 'n1' })
    expect(sourceIdentityOf({ sourceId: 's1' })).toEqual({ sourceId: 's1' })
  })

  it('answers nothing when no record was named', () => {
    expect(sourceIdentityOf({})).toBeNull()
  })
})
