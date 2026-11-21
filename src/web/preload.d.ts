export {};

declare global {
  interface Window {
    sidecar?: {
      conversationId?: string;
      fetch?: typeof fetch;
    };
  }
}
