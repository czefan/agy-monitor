declare module 'sidecar_sdk' {
  import type { Server } from 'node:http';

  export interface ResponseOptions {
    contentType?: string;
    status?: number;
    headers?: Record<string, string>;
  }

  export class Response {
    body: string | Uint8Array;
    contentType: string;
    status: number;
    headers?: Record<string, string>;
    constructor(body: string | Uint8Array, options?: ResponseOptions);
  }

  export interface SidecarConfig {
    projectId?: string;
    conversationId?: string;
  }

  export type PageHandler = () => string | Response | Promise<string | Response>;
  export type ApiHandler = (data: Record<string, string | undefined>) => unknown | Promise<unknown>;

  export class SidecarApp {
    readonly config: SidecarConfig;
    sendMessage(
      conversationId: string,
      message: string,
      options?: { title?: string; projectId?: string },
    ): unknown;
    startConversation(
      message: string,
      options?: { model?: string; projectId?: string },
    ): unknown;
    getConversationMetadata(conversationId: string): unknown;
    page(path: string, handler: PageHandler): void;
    api(path: string, handler: ApiHandler, method?: string): void;
    run(): Promise<Server>;
    close(): Promise<void>;
  }
}
