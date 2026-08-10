import { writeSync } from "node:fs";
const STDERR_JSONL_WRITE_RETRY_LIMIT = 100;
/**
 * Write one complete JSONL record to fd 2.
 * Retries EAGAIN/EINTR and short writes; never writes stdout.
 */
export function writeStderrJsonlRecord(record, write = writeSync) {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    let offset = 0;
    let retries = 0;
    while (offset < bytes.length) {
        try {
            const written = write(2, bytes, offset, bytes.length - offset);
            if (written <= 0)
                throw new Error("stderr JSONL write made no progress");
            offset += written;
            retries = 0;
        }
        catch (error) {
            const code = error.code;
            if ((code === "EAGAIN" || code === "EINTR") && retries++ < STDERR_JSONL_WRITE_RETRY_LIMIT)
                continue;
            throw error;
        }
    }
}
