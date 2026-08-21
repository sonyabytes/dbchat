declare module "pg-cursor" {
  interface CursorField {
    readonly name: string;
    readonly dataTypeID: number;
  }

  interface CursorResult {
    readonly fields: ReadonlyArray<CursorField>;
    readonly rowCount: number | null;
    readonly command: string;
  }

  type ReadCallback = (
    err: Error | null,
    rows: Array<Array<unknown>>,
    result: CursorResult | undefined,
  ) => void;

  export default class Cursor {
    constructor(
      text: string,
      values?: ReadonlyArray<unknown> | null,
      config?: { rowMode?: "array" | undefined },
    );
    submit(connection: unknown): void;
    read(rowCount: number, cb: ReadCallback): void;
    close(cb?: (err?: Error) => void): void;
  }
}
