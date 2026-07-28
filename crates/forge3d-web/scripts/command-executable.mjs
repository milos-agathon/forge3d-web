export function resolveCommandInvocation(command, args, options = {}) {
  const operatingSystem = options.operatingSystem ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const npmExecutable = options.npmExecutable ?? process.env.npm_execpath;

  if (command !== "npm") {
    return { command, args };
  }
  if (npmExecutable) {
    return {
      command: nodeExecutable,
      args: [npmExecutable, ...args],
    };
  }
  if (operatingSystem === "win32") {
    throw new Error(
      "npm_execpath is required to launch npm without a Windows command shell",
    );
  }
  return { command, args };
}
