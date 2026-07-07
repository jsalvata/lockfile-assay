export class UsageError extends Error {}
export class CannotEvaluate extends Error {}

export class StagingError extends Error {
  constructor(readonly path: string) {
    super('unsafe staged path');
    this.name = 'StagingError';
  }
}
