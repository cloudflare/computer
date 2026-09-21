export function retryableOnce(operation: () => Promise<void>): () => Promise<void> {
  let successful: Promise<void> | undefined;
  return () => {
    if (successful !== undefined) return successful;
    const attempt = operation();
    successful = attempt;
    void attempt.catch(() => {
      if (successful === attempt) successful = undefined;
    });
    return attempt;
  };
}
