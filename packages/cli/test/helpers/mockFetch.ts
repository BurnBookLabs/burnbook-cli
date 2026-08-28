import * as undici from "undici";
import { getGlobalDispatcher } from "undici";
import { vi } from "vitest";

export function setupMockFetch(): undici.MockAgent {
  const mockAgent = new undici.MockAgent();
  mockAgent.disableNetConnect();

  // Set the global dispatcher to use the mock agent
  undici.setGlobalDispatcher(mockAgent);

  // Stub global fetch to use undici's fetch, which respects the global dispatcher
  // This ensures mocks work on all Node versions (handles the Node 22 CI skew)
  vi.stubGlobal("fetch", undici.fetch);

  return mockAgent;
}

export function teardownMockFetch(mockAgent: undici.MockAgent, originalDispatcher: undici.Dispatcher): void {
  // Restore the original dispatcher
  undici.setGlobalDispatcher(originalDispatcher);

  // Restore original global fetch
  vi.unstubAllGlobals();

  // Close the mock agent (cleanup)
  mockAgent.close();
}

export function getOriginalDispatcher(): undici.Dispatcher {
  return getGlobalDispatcher();
}
