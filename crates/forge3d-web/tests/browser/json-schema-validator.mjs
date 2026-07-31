export function assertJsonSchema(value, schema, path = "$") {
  const errors = [];
  validate(value, schema, path, errors, schema);
  if (errors.length > 0) {
    throw new Error(`JSON schema validation failed:\n${errors.join("\n")}`);
  }
}

function validate(value, schema, path, errors, rootSchema) {
  if (schema.$ref !== undefined) {
    validate(value, resolveReference(schema.$ref, rootSchema), path, errors, rootSchema);
    return;
  }

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validate(value, candidate, path, candidateErrors, rootSchema);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(`${path}: expected exactly one oneOf schema to match`);
    }
    return;
  }

  for (const candidate of schema.allOf ?? []) {
    validate(value, candidate, path, errors, rootSchema);
  }

  if (schema.if !== undefined) {
    const conditionErrors = [];
    validate(value, schema.if, path, conditionErrors, rootSchema);
    if (conditionErrors.length === 0 && schema.then !== undefined) {
      validate(value, schema.then, path, errors, rootSchema);
    } else if (conditionErrors.length > 0 && schema.else !== undefined) {
      validate(value, schema.else, path, errors, rootSchema);
    }
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected type ${types.join("|")}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push(`${path}: number must be finite`);
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: less than minimum ${schema.minimum}`);
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push(`${path}: not greater than ${schema.exclusiveMinimum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validate(item, schema.items, `${path}[${index}]`, errors, rootSchema),
      );
    }
    return;
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${path}.${required}: required property is missing`);
      }
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(`${path}: fewer than ${schema.minProperties} properties`);
    }
    for (const key of keys) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        validate(value[key], propertySchema, `${path}.${key}`, errors, rootSchema);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property is not allowed`);
      } else if (isObject(schema.additionalProperties)) {
        validate(
          value[key],
          schema.additionalProperties,
          `${path}.${key}`,
          errors,
          rootSchema,
        );
      }
    }
  }
}

function resolveReference(reference, rootSchema) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Only local JSON schema references are supported: ${reference}`);
  }
  let value = rootSchema;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value?.[key];
  }
  if (!value || typeof value !== "object") {
    throw new Error(`JSON schema reference does not resolve: ${reference}`);
  }
  return value;
}

function matchesType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      throw new Error(`Unsupported JSON schema type: ${type}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
