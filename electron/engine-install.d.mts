export interface InstallEvent { sender?: object; senderFrame?: object }
export interface InstallDescriptor { command: string; driverKind?: string; needsNode?: boolean; signInCommand?: string }
export type InstallHandler = (event: InstallEvent, instanceId: string, installOnly?: boolean) => Promise<"running" | "opened" | "copied">;
export declare function registerEngineInstall(ipcMain: { handle(channel: string, fn: InstallHandler): void }, options: {
  trusted(event: InstallEvent): boolean;
  server(): { port: number; token?: string };
  copy(text: string): void;
  fetch?(url: string, init: RequestInit): Promise<{ ok: boolean; json(): Promise<InstallDescriptor> }>;
  open?(install: InstallDescriptor): Promise<boolean>;
  blank?(): Promise<boolean>;
}): void;
