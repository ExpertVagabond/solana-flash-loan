import pino from "pino";

export function createLogger(verbose: boolean): pino.Logger {
  return pino({
    level: verbose ? "debug" : "info",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  });
}
