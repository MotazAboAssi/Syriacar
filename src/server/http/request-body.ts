import "server-only";
import { performance } from "node:perf_hooks";

export const requestBodyLimit = 8192;
export const requestBodyDeadlineMs = 10_000;
/** Server-only test seam, never sourced from a request/header. */
export interface BodyReadOptions { deadlineMs?: number }
export class RequestBodyError extends Error {
  readonly status: 408 | 413 | 422;
  constructor(status: 408 | 413 | 422, message: string) {
    super(message); this.name = "RequestBodyError"; this.status = status;
  }
}
const invalid = () => new RequestBodyError(422, "بيانات الطلب غير صالحة.");

/** Complete transport validation before callers acquire a DB connection.
 * One absolute deadline, including trickled chunks; cancel need not resolve.
 */
export async function readJsonBody(request: Request, options: BodyReadOptions = {}): Promise<unknown> {
  const milliseconds = options.deadlineMs ?? requestBodyDeadlineMs;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error("Invalid body deadline");
  const expires = performance.now() + milliseconds;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
    !request.body) throw invalid();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = request.body.getReader(); } catch { throw invalid(); }
  let stopped: RequestBodyError | undefined;
  let reject!: (reason: RequestBodyError) => void;
  const failure = new Promise<never>((_resolve, fail) => { reject = fail; });
  void failure.catch(() => {});
  const cancel = () => {
    // A hostile/disconnected producer's cancellation can remain pending forever.
    // Stream cancellation closes pending reads synchronously; do not await it.
    void reader.cancel().catch(() => {});
  };
  const stop = () => {
    if (stopped) return;
    stopped = new RequestBodyError(408, "انتهت مهلة قراءة الطلب. حاول مجدداً.");
    reject(stopped); cancel();
  };
  const checkpoint = () => {
    if (performance.now() >= expires) stop();
    if (stopped) throw stopped;
  };
  const timer = setTimeout(stop, Math.max(0, expires - performance.now()));
  request.signal.addEventListener("abort", stop, { once: true });
  const bytes = new Uint8Array(requestBodyLimit);
  let size = 0, complete = false;
  try {
    if (request.signal.aborted) stop();
    for (;;) {
      checkpoint();
      const { value, done } = await Promise.race([reader.read(), failure]);
      checkpoint(); // A late read/EOF cannot win against an expired deadline.
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw invalid();
      size += value.byteLength;
      if (size > requestBodyLimit) throw new RequestBodyError(413, "حجم الطلب أكبر من المسموح.");
      bytes.set(value, size - value.byteLength);
    }
    let result: unknown;
    try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw invalid(); }
    checkpoint();
    return result;
  } catch (error) {
    if (stopped) throw stopped;
    if (error instanceof RequestBodyError) throw error;
    throw invalid(); // Interrupted/invalid streams remain malformed input.
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", stop);
    if (!complete && !stopped) cancel();
    reader.releaseLock();
  }
}