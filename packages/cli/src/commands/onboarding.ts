import {
  login,
  loginDiagnostic,
  LoginError,
  type LoginDiagnostic,
} from "./login.js";
import { BACKGROUND_STATE_VERSION, saveBackgroundState } from "../core/background-state.js";

export interface OnboardingOptions {
  loginDevice?: () => Promise<unknown>;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  onDiagnostic?: (diagnostic: LoginDiagnostic) => void;
}

/** Link a device without installing persistent hooks or services. */
export async function runOnboarding(opts: OnboardingOptions = {}): Promise<number> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const errorLog = opts.errorLog ?? ((message: string) => console.error(message));

  try {
    await (opts.loginDevice ?? login)();
    if (!opts.loginDevice) {
      await saveBackgroundState({ version: BACKGROUND_STATE_VERSION, status: "idle", failureCount: 0 });
    }
    log("Device linked. Run `burn repair` to explicitly enable hooks and automatic sync.");
    return 0;
  } catch (error) {
    if (error instanceof LoginError) {
      try { opts.onDiagnostic?.(loginDiagnostic(error)); } catch { /* diagnostics never break login */ }
    }
    errorLog(error instanceof LoginError ? error.message : "Device login failed. Run `burn doctor` for diagnostics.");
    return 1;
  }
}
