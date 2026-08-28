export type {
  BackgroundService,
  BackgroundServiceChange,
  BackgroundServiceHealth,
  BackgroundServiceState,
} from "./background-service.js";
export {
  resolveBackgroundService,
  type BackgroundServiceFactoryOptions,
  type BackgroundServiceResolution,
} from "./factory.js";
export {
  BURNBOOK_LAUNCHD_LABEL,
  BURNBOOK_SYNC_INTERVAL_SECONDS,
} from "./macos-launchd.js";
export { BURNBOOK_SYSTEMD_SERVICE, BURNBOOK_SYSTEMD_TIMER, renderLinuxSystemdUnits } from "./linux-systemd.js";
export { BURNBOOK_WINDOWS_TASK, renderWindowsTask } from "./windows-task.js";
