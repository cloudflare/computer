export interface BrowserBindingFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface Closable {
  close(): Promise<void>;
}

export function createBindingForwarder(
  resolve: () => BrowserBindingFetcher,
): BrowserBindingFetcher {
  return {
    fetch(input, init) {
      return resolve().fetch(input, init);
    },
  };
}

export async function withClosable<Resource extends Closable, Result>(
  resource: Resource,
  callback: (resource: Resource) => Result | Promise<Result>,
): Promise<Result> {
  let result: Result;
  try {
    result = await callback(resource);
  } catch (callbackFailure) {
    try {
      await resource.close();
    } catch (closeFailure) {
      throw new AggregateError(
        [callbackFailure, closeFailure],
        "Browser task and cleanup both failed",
        { cause: callbackFailure },
      );
    }
    throw callbackFailure;
  }
  await resource.close();
  return result;
}
