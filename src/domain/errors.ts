/** A problem with the caller's input. Shown to Claude (isError) or the web user as-is, so make it actionable. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** The thing doesn't exist, or exists but isn't visible to this user (deliberately indistinguishable). */
export class NotFoundError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
