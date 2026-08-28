declare const __CLI_VERSION__: string;

export const CLI_PACKAGE_VERSION =
  typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";
