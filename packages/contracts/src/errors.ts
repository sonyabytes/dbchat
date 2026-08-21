import * as Schema from "effect/Schema";

export class ConnectionError extends Schema.TaggedError<ConnectionError>()("ConnectionError", {
  connectionId: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  dialect: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export class SqlError extends Schema.TaggedError<SqlError>()("SqlError", {
  message: Schema.String,
  position: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String,
}) {}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}

/** A write statement was attempted on a path that only permits reads. */
export class WriteBlocked extends Schema.TaggedError<WriteBlocked>()("WriteBlocked", {
  sql: Schema.String,
  reason: Schema.String,
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  field: Schema.optional(Schema.String),
  message: Schema.String,
}) {}
