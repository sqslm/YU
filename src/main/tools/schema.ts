/** Validate the JSON Schema vocabulary used by our registered tools. Business rules stay in each service. */
export function argumentError(schema: Record<string, unknown>, value: unknown, path = 'args'): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) return path
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return path
      const object = value as Record<string, unknown>, properties = schema.properties as Record<string, Record<string, unknown>> | undefined
      for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(object, key)) return `${path}.${key}`
      for (const [key, item] of Object.entries(object)) {
        const field = properties && Object.hasOwn(properties, key) ? properties[key] : undefined
        if (!field) { if (schema.additionalProperties === false) return `${path}.${key}`; continue }
        const error = argumentError(field, item, `${path}.${key}`)
        if (error) return error
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value) || typeof schema.maxItems === 'number' && value.length > schema.maxItems || typeof schema.minItems === 'number' && value.length < schema.minItems) return path
      if (schema.items) for (let index = 0; index < value.length; index++) {
        const error = argumentError(schema.items as Record<string, unknown>, value[index], `${path}[${index}]`)
        if (error) return error
      }
      break
    }
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) ||
          typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum) return path
      break
    case 'string':
      if (typeof value !== 'string' || typeof schema.minLength === 'number' && value.length < schema.minLength || typeof schema.maxLength === 'number' && value.length > schema.maxLength) return path
      break
    case 'boolean': if (typeof value !== 'boolean') return path
  }
  return null
}
