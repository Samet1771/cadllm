// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export type ErrorCode =
  | 'unknown_part' | 'unknown_ref' | 'unknown_pin' | 'unknown_net' | 'unknown_prop'
  | 'duplicate_ref' | 'invalid_name' | 'net_short' | 'pin_in_use'
  | 'rev_conflict' | 'history' | 'invalid';

export class CadError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'CadError';
    this.code = code;
    this.hint = hint;
  }

  /** One-line form for AI clients: "unknown pin U1.VDD · pins: 1A 1B …". */
  override toString(): string {
    return this.hint ? `${this.message} · ${this.hint}` : this.message;
  }
}

/** Several errors from one transaction (e.g. one per CNL line). */
export class CadErrors extends Error {
  readonly errors: CadError[];

  constructor(errors: CadError[]) {
    super(errors.map(String).join('\n'));
    this.name = 'CadErrors';
    this.errors = errors;
  }

  override toString(): string {
    return this.message;
  }
}

/** Text for any thrown value, as shown to AI clients. */
export function errorText(err: unknown): string {
  if (err instanceof CadError || err instanceof CadErrors) return String(err);
  return err instanceof Error ? err.message : String(err);
}
