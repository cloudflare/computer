declare module "fuse-native" {
  interface FuseOptions {
    autoUnmount?: boolean;
    debug?: boolean;
  }

  export default class Fuse {
    constructor(mountPoint: string, operations: object, options?: FuseOptions);
    mount(callback: (error: Error | null) => void): void;
    unmount(callback: (error: Error | null) => void): void;
  }
}
