declare module "asciinema-player" {
  export function create(url: string, container: HTMLElement, opts?: Record<string, unknown>): { dispose?: () => void }
}
