declare module 'argon2-wasm-esm/lib/argon2.js' {
  export interface ArgonResult {
    hash: Uint8Array;
    hashHex: string;
    encoded: string;
  }

  export enum ArgonType {
    argon2d = 0,
    argon2i = 1,
    argon2id = 2,
  }

  export function hash(options: {
    pass: string | Uint8Array;
    salt: string | Uint8Array;
    time?: number;
    mem?: number;
    hashLen?: number;
    parallelism?: number;
    type?: ArgonType;
  }): Promise<ArgonResult>;

  const argon2: {
    ArgonType: typeof ArgonType;
    hash: typeof hash;
    verify: (options: { pass: string | Uint8Array; encoded: string | Uint8Array; type?: ArgonType }) => Promise<void>;
  };

  export { ArgonType, hash };
  export default argon2;
}
