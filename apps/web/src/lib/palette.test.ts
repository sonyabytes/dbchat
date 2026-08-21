import { beforeEach, describe, expect, test } from "bun:test";

import { usePalette } from "./palette.ts";

beforeEach(() => usePalette.setState({ open: false, mode: "all" }));

describe("usePalette", () => {
  test("setOpen(true, mode) keeps the mode; closing resets it", () => {
    usePalette.getState().setOpen(true, "tables");
    expect(usePalette.getState()).toMatchObject({ open: true, mode: "tables" });
    usePalette.getState().setOpen(false, "tables");
    expect(usePalette.getState()).toMatchObject({ open: false, mode: "all" });
  });

  test("toggle flips open and always lands on 'all'", () => {
    usePalette.getState().setOpen(true, "tables");
    usePalette.getState().toggle();
    expect(usePalette.getState()).toMatchObject({ open: false, mode: "all" });
    usePalette.getState().toggle();
    expect(usePalette.getState()).toMatchObject({ open: true, mode: "all" });
  });
});
