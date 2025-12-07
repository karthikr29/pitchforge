import { splitBufferedText } from "../sentenceSplitter";

describe("splitBufferedText", () => {
  it("splits sentences and preserves remainder", () => {
    const { sentences, remainder } = splitBufferedText("Hello world. How are you");
    expect(sentences).toEqual(["Hello world."]);
    expect(remainder).toBe("How are you");
  });

  it("returns empty when no terminator", () => {
    const { sentences, remainder } = splitBufferedText("No stop here");
    expect(sentences).toEqual([]);
    expect(remainder).toBe("No stop here");
  });
});

