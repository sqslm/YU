import { describe, expect, it } from 'vitest'
import { inferInputAreaType } from './inputArea'

describe('inferInputAreaType', () => {
  it('reports nothing when there is no snapshot or the control is read-only', () => {
    expect(inferInputAreaType(null)).toBe('unknown')
    expect(inferInputAreaType(undefined)).toBe('unknown')
    expect(inferInputAreaType({ controlType: 'edit', readOnly: true })).toBe('unknown')
  })

  it('recognises plain edit boxes', () => {
    expect(inferInputAreaType({ controlType: 'edit', className: 'Edit' })).toBe('edit')
    expect(inferInputAreaType({ className: 'RichEdit20W' })).toBe('edit')
    expect(inferInputAreaType({ className: 'TEEdit' })).toBe('edit')
  })

  it('recognises terminals before anything else, because they never want punctuation', () => {
    expect(inferInputAreaType({ controlType: 'edit', className: 'ConsoleWindowClass' })).toBe('terminal')
    expect(inferInputAreaType({ className: 'CASCADIA_HOSTING_WINDOW_CLASS' })).toBe('terminal')
    expect(
      inferInputAreaType({ controlType: 'edit', className: 'ConsoleWindowClass', appName: 'WeChat' })
    ).toBe('terminal')
  })

  it('treats a browser render widget as a document even when UIA calls it an edit', () => {
    expect(
      inferInputAreaType({ controlType: 'edit', className: 'Chrome_RenderWidgetHostHWND' })
    ).toBe('document')
    expect(inferInputAreaType({ controlType: 'document', className: 'Edit' })).toBe('document')
  })

  it('labels a chat composer by app, before the class heuristic runs', () => {
    expect(inferInputAreaType({ controlType: 'edit', className: 'Edit', appName: 'WeChat.exe' })).toBe(
      'chat'
    )
    expect(inferInputAreaType({ controlType: 'edit', appName: 'Slack' })).toBe('chat')
  })

  it('stays unknown rather than inventing a register', () => {
    expect(inferInputAreaType({})).toBe('unknown')
    expect(inferInputAreaType({ controlType: 'pane', className: 'SomeUnknownHost' })).toBe('unknown')
    expect(inferInputAreaType({ controlType: 'button', className: 'Button' })).toBe('unknown')
  })
})
