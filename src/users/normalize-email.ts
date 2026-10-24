/** Emails are stored and compared lowercased, without surrounding whitespace. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
