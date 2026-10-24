/** Display names are localized; persisted application IDs and profile paths stay stable. */
export function productName(language: string): string {
  return language.startsWith('en') ? 'YU' : '语'
}
