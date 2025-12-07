const sentenceEndRegex = /([.!?])\s+/;

export function splitBufferedText(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let working = buffer;

  while (true) {
    const match = working.match(sentenceEndRegex);
    if (!match) break;
    const idx = match.index;
    if (idx === undefined) break;
    const sentence = working.slice(0, idx + 1).trim();
    if (sentence) sentences.push(sentence);
    working = working.slice(idx + match[0].length);
  }

  return { sentences, remainder: working };
}

