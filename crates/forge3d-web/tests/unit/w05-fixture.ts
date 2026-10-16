import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/** Native oracle recorded by scripts/generate-w05-camera-fixture.py. */
export const nativeFixture: any = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "golden", "w05-camera-native.json"),
    "utf8",
  ),
);

/** W05 acceptance: 1e-5 absolute, relative for magnitudes above 1. */
export function expectClose(actual: number, expected: number, context: string): void {
  const tolerance = 1e-5 * Math.max(1, Math.abs(expected));
  if (!(Math.abs(actual - expected) <= tolerance)) {
    expect.fail(`${context}: expected ${expected}, got ${actual}`);
  }
}

export function expectRowsClose(
  actualColumns: ArrayLike<number>,
  expectedRows: number[][],
  context: string,
): void {
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      expectClose(
        actualColumns[column * 4 + row] as number,
        expectedRows[row]![column]!,
        `${context}[${row}][${column}]`,
      );
    }
  }
}

/** Native snake_case parameter names mapped to the browser API names. */
export function browserMessage(native: string): string {
  let message = native;
  for (const [from, to] of [
    ["fovy_deg", "fovYDegrees"],
    ["zfar must be finite and > znear", "far must be finite and > near"],
    ["znear", "near"],
    ["clip_space", "clipSpace"],
    ["focus_distance", "focusDistance"],
    ["focal_length", "focalLength"],
    ["auto_focus_speed", "autoFocusSpeed"],
    ["f_stop", "fStop"],
    ["target_path_xz", "targetPathXZ"],
    ["theta_start_deg", "thetaStartDeg"],
    ["samples_per_second", "samplesPerSecond"],
    ["path_xz", "pathXZ"],
  ] as const) {
    message = message.split(from).join(to);
  }
  return message;
}

export interface HeightmapRecipe {
  size: [number, number];
  fill: number;
  patches: { row0: number; row1: number; col0: number; col1: number; value: number }[];
}

export function heightmapFromRecipe(recipe: HeightmapRecipe): {
  heights: Float32Array;
  width: number;
  height: number;
} {
  const [rows, cols] = recipe.size;
  const heights = new Float32Array(rows * cols).fill(recipe.fill);
  for (const patch of recipe.patches) {
    for (let row = patch.row0; row < patch.row1; row += 1) {
      for (let col = patch.col0; col < patch.col1; col += 1) {
        heights[row * cols + col] = patch.value;
      }
    }
  }
  return { heights, width: cols, height: rows };
}
