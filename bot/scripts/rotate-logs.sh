#!/bin/bash
# Rotate flash-arb bot logs — keeps last 5 rotations (~50MB max)
LOG_DIR="/tmp/flash-arb-logs"
MAX_ROTATIONS=5
MAX_SIZE_MB=10

for logfile in "$LOG_DIR"/stdout.log "$LOG_DIR"/stderr.log; do
  [ -f "$logfile" ] || continue
  size_mb=$(du -m "$logfile" | cut -f1)
  if [ "$size_mb" -ge "$MAX_SIZE_MB" ]; then
    # Rotate existing backups
    for i in $(seq $((MAX_ROTATIONS - 1)) -1 1); do
      [ -f "${logfile}.$i" ] && mv "${logfile}.$i" "${logfile}.$((i + 1))"
    done
    mv "$logfile" "${logfile}.1"
    touch "$logfile"
    # Signal the bot to reopen file descriptors
    pkill -USR1 -f "tsx src/index.ts" 2>/dev/null
  fi
done

# Delete rotations beyond MAX_ROTATIONS
find "$LOG_DIR" -name "*.log.*" -newer "$LOG_DIR" -mtime +7 -delete 2>/dev/null
