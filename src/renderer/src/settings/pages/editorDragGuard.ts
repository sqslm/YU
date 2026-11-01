import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * Keeps a text selection selectable — not draggable.
 *
 * In a contenteditable, pressing inside a range the document already highlights
 * starts an HTML5 drag of that range instead of extending the selection. In a
 * note that reads as two bugs at once: "选中的字会突然跳一下" and "重新选字的
 * 时候把整段字拖走了" — the drop usually lands in the same paragraph, so
 * ProseMirror performs a *move* and the block is split in two at the drop point,
 * which is the text jumping apart under the cursor.
 *
 * Two guards, because either one alone leaves a hole:
 *
 *  1. **Collapse before the browser decides.** A `mousedown` inside an existing
 *     non-empty text selection collapses that selection to the press point
 *     *before* the default action runs. With no range selected there is nothing
 *     to pick up, so the same gesture becomes an ordinary select-by-drag from
 *     the press point — what "重新选其中几个字" is supposed to do, and what a
 *     plain click collapsed on mouseup anyway.
 *  2. **Cancel stragglers.** A `dragstart` that does not come from the block
 *     handle (＋ / grip) is cancelled in the capture phase, so paths guard 1
 *     cannot see — a drag begun from an image, a triple-click range, a browser
 *     that drags regardless — still never reach ProseMirror as a drop.
 *
 * Both guards ignore presses outside the editable content, so the selection
 * toolbar keeps its own range: pressing 加粗 must format the selection, not
 * collapse it. The block handle lives next to the content, so moving a block by
 * its grip is untouched.
 */
const BLOCK_HANDLE = '.milkdown-block-handle'

/** True when the event came from the block handle rather than from the text. */
function isBlockHandleDrag(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(BLOCK_HANDLE))
}

/**
 * Installs both guards on `root`; `view` is read lazily because the editor view
 * only exists once Crepe has finished mounting. Returns the teardown function.
 */
export function guardEditorSelectionDrag(root: HTMLElement, view: () => EditorView | null): () => void {
  const onDragStart = (event: DragEvent): void => {
    if (isBlockHandleDrag(event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
    if (isBlockHandleDrag(event.target)) return
    const editor = view()
    if (!editor || !editor.editable) return
    // Only presses on the text itself: the toolbar, slash menu and image
    // controls are siblings of the editable content and own their own clicks.
    if (!(event.target instanceof Node) || !editor.dom.contains(event.target)) return
    const { selection } = editor.state
    if (selection.empty || selection instanceof NodeSelection) return
    const at = editor.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!at || at.pos < selection.from || at.pos > selection.to) return
    // Collapse rather than extend: the browser must have no range to pick up.
    try {
      editor.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(at.pos))))
    } catch { /* a press on a boundary resolves differently; the native gesture still works */ }
  }

  root.addEventListener('dragstart', onDragStart, true)
  root.addEventListener('mousedown', onMouseDown, true)
  return () => {
    root.removeEventListener('dragstart', onDragStart, true)
    root.removeEventListener('mousedown', onMouseDown, true)
  }
}
