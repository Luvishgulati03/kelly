/** Exact allowlist check. IDs are opaque strings: no suffix, prefix, or numeric coercion. */
export function isAllowedOwner(identity: unknown, allowedOwnerIds: readonly string[]): identity is string {
  return typeof identity === "string" && identity.length > 0 && allowedOwnerIds.includes(identity);
}

export function requireAllowedOwner(identity: unknown, allowedOwnerIds: readonly string[]): string {
  if (!isAllowedOwner(identity, allowedOwnerIds)) throw new Error("WhatsApp identity is not an allowed owner");
  return identity;
}
