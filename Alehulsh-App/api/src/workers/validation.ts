import { Validator, type Schema } from '@cfworker/json-schema';
import { AppError } from '../errors.js';

const validators = new WeakMap<object, Validator>();
/** Preserves the existing strict JSON Schemas without eval or type coercion. */
export async function validatedJson<T>(request: Request, schema: object): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new AppError('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('invalid_request');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (; ;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) { await reader.cancel(); throw new AppError('invalid_request'); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    let validator = validators.get(schema);
    if (!validator) { validator = new Validator(schema as Schema); validators.set(schema, validator); }
    if (!validator.validate(body).valid) throw new AppError('invalid_request');
    return body as T;
  } catch { throw new AppError('invalid_request'); }
  finally { reader.releaseLock(); }
}
