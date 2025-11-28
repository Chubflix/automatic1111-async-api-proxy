class UnrecoverableError extends Error {
  readonly isUnrecoverable = true;
}

export default UnrecoverableError;