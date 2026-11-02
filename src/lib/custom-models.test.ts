import { describe, expect, it } from "vitest";

import { filterCustomModels } from "./custom-models";

const rows = [
  { id: "omlx::gemma-4-31b-it-bf16", label: "gemma-4-31b-it-bf16 (oMLX)", loaded: true },
  { id: "omlx::GLM-5.2-fp8", label: "GLM-5.2-fp8 (oMLX)" },
  { id: "ollama::llama3.2:latest", label: "llama3.2:latest (Ollama)" },
];

describe("filterCustomModels", () => {
  it("matches the visible label or the encoded host id", () => {
    expect(filterCustomModels(rows, "gemma").map((row) => row.id)).toEqual(["omlx::gemma-4-31b-it-bf16"]);
    expect(filterCustomModels(rows, "OLLAMA").map((row) => row.id)).toEqual(["ollama::llama3.2:latest"]);
    expect(filterCustomModels(rows, "omlx").map((row) => row.id)).toEqual([
      "omlx::gemma-4-31b-it-bf16",
      "omlx::GLM-5.2-fp8",
    ]);
  });

  it("treats blank search as no filter", () => {
    expect(filterCustomModels(rows, "  ")).toEqual(rows);
  });
});
