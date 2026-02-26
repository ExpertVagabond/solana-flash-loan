import pino from "pino";

const LOG_FILE = process.env.LOG_FILE || "/tmp/flash-arb-logs/stdout.log";

export function createLogger(verbose: boolean): pino.Logger {
  // When running via launchd, pino-pretty's worker thread bypasses
  // StandardOutPath redirect. Write to file directly + stdout.
  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
        ignore: "pid,hostname",
      },
      level: verbose ? "debug" : "info",
    },
    {
      target: "pino/file",
      options: { destination: LOG_FILE, append: true },
      level: verbose ? "debug" : "info",
    },
  ];

  return pino({
    level: verbose ? "debug" : "info",
    transport: { targets },
  });
}
