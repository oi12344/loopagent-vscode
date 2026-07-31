export type WorkspaceMutationLock = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

export function createWorkspaceMutationLock(): WorkspaceMutationLock {
  let tail = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
