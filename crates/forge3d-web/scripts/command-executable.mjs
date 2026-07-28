export function resolveCommand(command, operatingSystem = process.platform) {
  return operatingSystem === "win32" && command === "npm"
    ? "npm.cmd"
    : command;
}
