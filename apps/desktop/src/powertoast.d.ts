declare module "powertoast" {
  export class Toast {
    constructor(options: unknown);
    on(event: string, listener: (event: unknown, rawInput: unknown) => void): void;
    show(options?: unknown): Promise<void>;
  }
}