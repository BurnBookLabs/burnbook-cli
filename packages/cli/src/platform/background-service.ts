export type BackgroundServiceState =
  | "not-installed"
  | "installed"
  | "needs-repair"
  | "conflict";

export interface BackgroundServiceHealth {
  state: BackgroundServiceState;
  installed: boolean;
  loaded: boolean;
  managed: boolean;
  current: boolean;
  detail: string;
}

export interface BackgroundServiceChange {
  changed: boolean;
  detail: string;
}

export interface BackgroundService {
  install(): Promise<BackgroundServiceChange>;
  inspect(): Promise<BackgroundServiceHealth>;
  trigger(): Promise<boolean>;
  remove(): Promise<BackgroundServiceChange>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>;
