import type { EventEmitter } from "node:events";
import type { InstallDescriptor } from "./engine-install.mjs";
export declare function openInstallTerminal(install: InstallDescriptor, platform?: string,
  run?: (file: string, args: string[], options: { windowsHide?: boolean; env?: NodeJS.ProcessEnv }) => EventEmitter): Promise<boolean>;
