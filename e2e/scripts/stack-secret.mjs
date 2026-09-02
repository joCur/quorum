import { randomBytes } from "node:crypto";

/**
 * A random secret for the throwaway end-to-end stack that can never be read as a command-line flag.
 *
 * base64url's alphabet contains "-", so about one value in twenty-two begins with one, and a tool
 * that receives the secret as a positional argument parses it as a flag instead: `mc alias set`
 * fails the bucket bootstrap that way, which fails the whole stack. Because these values are
 * persisted and reused, one unlucky draw breaks every later run until the file is deleted.
 *
 * Unlucky draws are discarded rather than patched: rewriting the first character would bias it
 * towards whatever replacement was chosen, while drawing again stays uniform over what is left.
 */
export function stackSecret(bytes = 24) {
  for (;;) {
    const value = randomBytes(bytes).toString("base64url");
    if (/^[A-Za-z0-9]/.test(value)) return value;
  }
}

/**
 * The names of any secrets in `values` that a tool could still mistake for a flag. Older runs
 * generated their credentials before `stackSecret` existed, and those files outlive the fix.
 */
export function flagLikeSecrets(values) {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "string" && value.startsWith("-"))
    .map(([name]) => name);
}
