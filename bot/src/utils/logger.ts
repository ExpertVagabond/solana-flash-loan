import pino from "pino";

const LOG_FILE = process.env.LOG_FILE || "/tmp/flash-arb-logs/stdout.log";

export function createLogger(verbose: boolean): pino.Logger {
  const level = verbose ? "debug" : "info";
  const isTTY = process.stdout.isTTY;

  if (isTTY) {
    // Interactive terminal — pretty output + file backup
    return pino({
      level,
      transport: {
        targets: [
          {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
              ignore: "pid,hostname",
            },
            level,
          },
          {
            target: "pino/file",
            options: { destination: LOG_FILE, append: true },
            level,
          },
        ],
      },
    });
  }

  // Background / nohup / launchd — file-only transport
  return pino({
    level,
    transport: {
      target: "pino/file",
      options: { destination: LOG_FILE, append: true },
    },
  });
}
