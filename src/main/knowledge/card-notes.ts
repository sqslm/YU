/** The note body a card is saved as: its title, then its own text. */
export function cardNoteText(card: { title: string; body: string }): string {
  return `# ${card.title}\n\n${card.body}\n`
}

export interface CardNoteDeps {
  read(cardId: string): Promise<{ id: string; title: string; body: string }>
  nextId(): string
  /**
   * Saves the note. The store announces a finished note on its own, so whatever
   * publishes it may run before this call returns.
   */
  save(input: { id: string; text: string }): Promise<{ id: string }>
  /**
   * Names the cards the note's source cites, for the note id that is about to be
   * written. Registering before the save is what makes the *first* source carry
   * the citation: there is one publication, not a plain one racing an explicit one.
   */
  cite(noteId: string, cardIds: string[]): void
}

/**
 * A card becomes a note through the note store's own save path, citing the card
 * it came from. Extracting that same text again then restates knowledge instead
 * of minting a second card.
 */
export async function saveCardAsNote(deps: CardNoteDeps, cardId: string): Promise<{ noteId: string }> {
  const card = await deps.read(cardId)
  const noteId = deps.nextId()
  deps.cite(noteId, [card.id])
  const note = await deps.save({ id: noteId, text: cardNoteText(card) })
  return { noteId: note.id }
}
