/**
 * Standalone package protocol surface for the dsh-typert-generator and the
 * client type-face. A standalone plugin does not register
 * @deepseek-ai/dsh-typert-protocol as a workspace source package, so this
 * ambient module (shadowing) lets the generator resolve the Remote markers
 * and keeps the client + generated `remote` artifact typable. Keep the surface
 * aligned with the real protocol's shapes.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertGatewayBindingOptions {
    readonly namespace?: string
  }
  export class TypertRemoteService<T = never> {
    protected readonly ctx: unknown
    readonly typertRemote: unknown
    constructor(context: unknown, serviceKey: string, options?: TypertGatewayBindingOptions)
  }
  export function Remote(exportName?: string): any
  export function RemoteScope(key: string, exportName?: string): any
  export function bindTypertRemote(service: object, serviceKey: string, options?: TypertGatewayBindingOptions): unknown

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }
  export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}
  export interface TypertRemoteNamespaceMap {}
  export type TypertRemoteEvent = string
  export type TypertDisposer = () => Promise<void>

  export interface TypertClientRemote extends TypertRemoteNamespaceMap {
    $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
    $on<Event extends TypertRemoteEvent>(event: Event, listener: (...args: any[]) => void): () => void
    $dispatch(event: string, args: readonly unknown[]): void
  }
}
